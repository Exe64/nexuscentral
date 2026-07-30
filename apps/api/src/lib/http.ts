/**
 * The shared HTTP client: native `fetch` plus retry/backoff, a hard body-size
 * cap and a timeout.
 *
 * Every outbound request in the app goes through this. Adapters poll third
 * parties on a schedule, so being a good citizen (conditional requests, a
 * descriptive User-Agent, backing off on 429) is not optional, and neither is
 * refusing to buffer an unbounded response into memory.
 */

import { USER_AGENT } from '../version.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  /** Caller-owned cancellation, combined with the internal timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  /** Retry attempts *after* the first. 0 disables retrying. */
  retries?: number;
  redirect?: 'follow' | 'error' | 'manual';
}

export interface HttpTextResponse {
  status: number;
  ok: boolean;
  /** Lowercased header names. */
  headers: Headers;
  body: string;
  /** Final URL after redirects -- relative feed links must resolve against it. */
  url: string;
  contentType: string | null;
}

/** A request that failed for a reason the caller should distinguish. */
export class HttpError extends Error {
  readonly kind: 'timeout' | 'too_large' | 'network' | 'status';
  readonly status?: number;
  readonly url: string;

  constructor(
    kind: HttpError['kind'],
    message: string,
    url: string,
    status?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HttpError';
    this.kind = kind;
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

/** 429 and 5xx are worth another try; a 404 will still be a 404. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

/** Honour `Retry-After` when the server sends one, in seconds or as a date. */
function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;

  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && String(seconds) === raw.trim()) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return null;
}

function backoffMs(attempt: number): number {
  // 1s, 5s, 25s -- the same ladder alert delivery uses (02-SPEC-ingestion.md 6).
  const base = [1000, 5000, 25_000][attempt] ?? 25_000;
  // Jitter so several sources failing at once do not retry in lockstep.
  return base + Math.floor(Math.random() * 250);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Read the body with a hard byte ceiling, aborting rather than buffering past it.
 * `Content-Length` is only a hint -- a chunked response has none, and a
 * misreported one must not be trusted -- so the count is enforced on the stream.
 */
async function readCapped(response: Response, maxBytes: number, url: string): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new HttpError(
        'too_large',
        `Response declares ${length} bytes, over the ${maxBytes} byte cap`,
        url,
        response.status,
      );
    }
  }

  if (response.body === null) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new HttpError('too_large', `Response exceeded the ${maxBytes} byte cap`, url);
      }
      chunks.push(value);
    }
  } finally {
    // Releasing the lock lets the connection be torn down on the error path.
    reader.releaseLock();
    if (total > maxBytes) await response.body.cancel().catch(() => undefined);
  }

  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

export async function httpRequest(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpTextResponse> {
  const {
    method = 'GET',
    headers = {},
    body,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    retries = 2,
    redirect = 'follow',
  } = options;

  // Drop undefined entries so callers can pass optional conditional headers
  // (`If-None-Match`) without branching at every call site.
  const outboundHeaders: Record<string, string> = { 'User-Agent': USER_AGENT };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) outboundHeaders[name] = value;
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    try {
      const response = await fetch(url, {
        method,
        headers: outboundHeaders,
        redirect,
        signal: combined,
        ...(body === undefined ? {} : { body }),
      });

      if (isRetryableStatus(response.status) && attempt < retries) {
        // Drain so the socket can be reused for the retry.
        await response.body?.cancel().catch(() => undefined);
        lastError = new HttpError('status', `HTTP ${response.status}`, url, response.status);
        await sleep(retryAfterMs(response.headers) ?? backoffMs(attempt));
        continue;
      }

      // 304 is a successful conditional request with no body by definition.
      const text = response.status === 304 ? '' : await readCapped(response, maxBytes, url);

      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        body: text,
        url: response.url === '' ? url : response.url,
        contentType: response.headers.get('content-type'),
      };
    } catch (err) {
      // A body over the cap is a property of the response, not a transient
      // failure. Retrying would download it again to fail the same way.
      if (err instanceof HttpError && err.kind === 'too_large') throw err;

      // The caller cancelling is final; only our own timeout is retryable.
      if (signal?.aborted === true) {
        throw new HttpError('network', 'Request cancelled by caller', url, undefined, err);
      }

      lastError = err;
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }

  if (lastError instanceof HttpError) throw lastError;

  const isTimeout =
    lastError instanceof Error &&
    (lastError.name === 'TimeoutError' || lastError.name === 'AbortError');

  throw new HttpError(
    isTimeout ? 'timeout' : 'network',
    isTimeout
      ? `Request timed out after ${timeoutMs}ms`
      : lastError instanceof Error
        ? lastError.message
        : String(lastError),
    url,
    undefined,
    lastError,
  );
}
