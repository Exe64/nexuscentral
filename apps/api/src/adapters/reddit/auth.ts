/**
 * Reddit OAuth2 (02-SPEC-ingestion.md 3.2).
 *
 * `client_credentials` against www.reddit.com with HTTP basic auth, cached in
 * memory with a safety margin before `expires_in`. A refresh is one request, so
 * the cache exists to avoid pointless round trips, not to save budget.
 *
 * All *data* calls go to oauth.reddit.com. The token endpoint is the only thing
 * on www.reddit.com, and the unauthenticated `.json` endpoints are never touched:
 * they are IP-tracked, capped near 10 QPM, and this runs on a datacentre IP.
 */

import { httpRequest, HttpError } from '../../lib/http.js';
import { logger } from '../../logger.js';
import type { RedditCredentials } from '../../db/settings.js';

export const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

/** Refresh this long before the token actually expires. */
export const EXPIRY_MARGIN_SECONDS = 60;

const log = logger.child({ component: 'reddit-auth' });

interface CachedToken {
  value: string;
  expiresAt: number;
  /** Which client the token belongs to, so changing credentials invalidates it. */
  clientId: string;
}

export class RedditAuthError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RedditAuthError';
    this.status = status;
  }
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
}

export class RedditTokenCache {
  #token: CachedToken | null = null;
  /** Deduplicates concurrent refreshes: four poll jobs must not fetch four tokens. */
  #inFlight: Promise<string> | null = null;

  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  async getToken(credentials: RedditCredentials, signal?: AbortSignal): Promise<string> {
    const cached = this.#token;
    if (
      cached !== null &&
      cached.clientId === credentials.clientId &&
      cached.expiresAt > this.#now()
    ) {
      return cached.value;
    }

    if (this.#inFlight !== null) return this.#inFlight;

    this.#inFlight = this.#fetchToken(credentials, signal).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Drop the cached token, e.g. after a 401 that a refresh might fix. */
  invalidate(): void {
    this.#token = null;
  }

  async #fetchToken(credentials: RedditCredentials, signal?: AbortSignal): Promise<string> {
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
      'base64',
    );

    let response;
    try {
      response = await httpRequest(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          // Reddit blocks generic agents, including on the token endpoint.
          'User-Agent': credentials.userAgent,
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
        timeoutMs: 15_000,
        retries: 2,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : undefined;
      throw new RedditAuthError(
        `Could not reach the Reddit token endpoint: ${err instanceof Error ? err.message : String(err)}`,
        status,
        err,
      );
    }

    if (response.status === 401) {
      // Distinguished so the settings UI can say "wrong credentials" rather than
      // "Reddit is down".
      throw new RedditAuthError(
        'Reddit rejected the client id and secret. Check them in Settings.',
        401,
      );
    }

    if (!response.ok) {
      throw new RedditAuthError(
        `Reddit token endpoint returned HTTP ${response.status}`,
        response.status,
      );
    }

    let parsed: TokenResponse;
    try {
      parsed = JSON.parse(response.body) as TokenResponse;
    } catch (err) {
      throw new RedditAuthError('Reddit token response was not JSON', response.status, err);
    }

    if (parsed.access_token === undefined || parsed.access_token === '') {
      throw new RedditAuthError(
        parsed.error === undefined
          ? 'Reddit token response contained no access_token'
          : `Reddit token request failed: ${parsed.error}`,
        response.status,
      );
    }

    const lifetime = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
    // Never produce an expiry in the past, however short the lifetime.
    const usableSeconds = Math.max(1, lifetime - EXPIRY_MARGIN_SECONDS);

    this.#token = {
      value: parsed.access_token,
      expiresAt: this.#now() + usableSeconds * 1000,
      clientId: credentials.clientId,
    };

    log.debug(
      { expiresInSeconds: usableSeconds, origin: credentials.origin },
      'Reddit token cached',
    );
    return parsed.access_token;
  }
}

export const redditTokenCache = new RedditTokenCache();
