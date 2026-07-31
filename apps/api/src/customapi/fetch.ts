/**
 * The server-side fetch behind every `custom_api` widget (03-SPEC-api.md 7).
 *
 * The browser never calls the third party itself. That keeps API keys on the
 * server and sidesteps CORS, at the cost of making this file a request-forging
 * primitive -- which is why `resolveTarget` runs before anything else.
 */

import { Agent, request as undiciRequest } from 'undici';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { BlockedTargetError, blockedRange, resolveTarget } from './ssrf.js';

const log = logger.child({ component: 'custom-api' });

/** 03-SPEC-api.md 7. */
export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 15_000;

/** Redirects are followed, but each hop is checked like the first. */
export const MAX_REDIRECTS = 3;

export interface FetchSpec {
  url: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface FetchOutcome {
  status: number;
  body: unknown;
  /** The final URL, after redirects, for the preview to show. */
  finalUrl: string;
  bytes: number;
  durationMs: number;
}

export class CustomApiError extends Error {
  readonly kind: 'blocked' | 'placeholder' | 'http' | 'timeout' | 'too-large' | 'parse' | 'network';

  constructor(kind: CustomApiError['kind'], message: string) {
    super(message);
    this.name = 'CustomApiError';
    this.kind = kind;
  }
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Substitute `${VAR}` from the environment.
 *
 * A missing variable is an error, not an empty string: silently sending
 * `Authorization: Bearer ` produces a 401 that looks like a credential problem
 * rather than a configuration one. The spec wants this to fail at save time,
 * which is why the preview endpoint runs the same code.
 */
export function resolvePlaceholders(value: string): string {
  return value.replace(PLACEHOLDER, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined || resolved === '') {
      throw new CustomApiError(
        'placeholder',
        `The environment variable ${name} is referenced but not set on the server.`,
      );
    }
    return resolved;
  });
}

/** Which env var names a spec depends on, so the UI can say so before saving. */
export function referencedVariables(spec: FetchSpec): string[] {
  const found = new Set<string>();
  const scan = (text: string): void => {
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  };

  scan(spec.url);
  for (const [key, value] of Object.entries(spec.params ?? {})) {
    scan(key);
    scan(value);
  }
  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    scan(key);
    scan(value);
  }
  return [...found].sort();
}

/**
 * Headers the caller is not allowed to set.
 *
 * `Host` would let a widget target one address and present as another, which is
 * the other half of an SSRF. The rest are ours to set.
 */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

function buildUrl(spec: FetchSpec): URL {
  const url = new URL(resolvePlaceholders(spec.url));
  for (const [key, value] of Object.entries(spec.params ?? {})) {
    url.searchParams.set(resolvePlaceholders(key), resolvePlaceholders(value));
  }
  return url;
}

function buildHeaders(spec: FetchSpec): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    'user-agent': env.REDDIT_USER_AGENT,
  };

  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    const name = key.trim().toLowerCase();
    if (name === '' || FORBIDDEN_HEADERS.has(name)) continue;
    headers[name] = resolvePlaceholders(value);
  }
  return headers;
}

/**
 * Fetch a spec, once, with every guard applied.
 *
 * Uses undici directly rather than `fetch` for one reason: the connection has to
 * be pinned to the address the SSRF guard checked. `fetch` resolves the hostname
 * itself, which leaves a window between the check and the connection in which DNS
 * can return something else.
 */
export async function fetchSpec(spec: FetchSpec): Promise<FetchOutcome> {
  const startedAt = Date.now();

  let url = buildUrl(spec);
  const headers = buildHeaders(spec);
  let redirects = 0;
  let target = await resolveTarget(url.toString());

  for (;;) {
    // Connect to the checked address, but keep sending the real hostname so TLS
    // and virtual hosting still work.
    const agent = new Agent({
      connect: {
        lookup: (_hostname, _options, callback) => {
          callback(null, [{ address: target.address, family: target.family }]);
        },
      },
    });

    let response;
    try {
      response = await undiciRequest(target.url, {
        method: 'GET',
        headers: { ...headers, host: target.url.host },
        dispatcher: agent,
        // No `maxRedirections`: redirects are followed by hand below so every
        // hop goes back through the SSRF guard. Undici's own follower would not.
        headersTimeout: TIMEOUT_MS,
        bodyTimeout: TIMEOUT_MS,
      });
    } catch (err) {
      await agent.close();
      const message = err instanceof Error ? err.message : String(err);
      if (/timeout/i.test(message)) {
        throw new CustomApiError('timeout', `The request timed out after ${TIMEOUT_MS / 1000}s.`);
      }
      throw new CustomApiError('network', `Could not reach the target: ${message}`);
    }

    // Redirects are followed by hand so each hop goes through the guard again.
    const location = response.headers.location;
    if (response.statusCode >= 300 && response.statusCode < 400 && typeof location === 'string') {
      // `dump()`, not `destroy()`: destroying an undici body raises an
      // AbortError that lands nowhere, and an unhandled rejection takes the
      // process down. Dumping reads and discards it, which is what we want.
      await response.body.dump();
      await agent.close();

      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        throw new CustomApiError('http', `More than ${MAX_REDIRECTS} redirects.`);
      }

      url = new URL(location, target.url);
      target = await resolveTarget(url.toString());
      continue;
    }

    try {
      const { text, bytes } = await readCapped(response.body);

      if (response.statusCode >= 400) {
        throw new CustomApiError(
          'http',
          `The target answered ${response.statusCode}.${text === '' ? '' : ` ${text.slice(0, 200)}`}`,
        );
      }

      let body: unknown;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        throw new CustomApiError(
          'parse',
          'The response is not JSON. Only JSON endpoints can be mapped.',
        );
      }

      log.debug({ url: target.url.host, bytes, status: response.statusCode }, 'Custom API fetched');

      return {
        status: response.statusCode,
        body,
        finalUrl: target.url.toString(),
        bytes,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await agent.close();
    }
  }
}

/**
 * Read a body, refusing to buffer more than the cap.
 *
 * Checked while reading rather than from `content-length`: a hostile or merely
 * broken server can omit the header or lie about it, and by the time the
 * discrepancy shows up the memory is already gone.
 */
async function readCapped(body: AsyncIterable<Buffer>): Promise<{ text: string; bytes: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      throw new CustomApiError('too-large', `The response exceeded ${MAX_BYTES / 1024 / 1024} MB.`);
    }
    chunks.push(chunk);
  }

  return { text: Buffer.concat(chunks).toString('utf8'), bytes };
}

export { BlockedTargetError, blockedRange };
