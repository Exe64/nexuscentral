/**
 * The authenticated Reddit transport.
 *
 * Every data call goes through here so that no code path can accidentally skip
 * the budget or hit an unauthenticated endpoint. All requests target
 * oauth.reddit.com; `www.reddit.com` is only ever used for the token.
 */

import { httpRequest, HttpError } from '../../lib/http.js';
import type { RedditCredentials } from '../../db/settings.js';
import { redditBudget, type RedditBudget } from './budget.js';
import { redditTokenCache, type RedditTokenCache } from './auth.js';

export const OAUTH_BASE = 'https://oauth.reddit.com';

/** Reddit answers a listing in well under this; the runner's ceiling is 30s. */
const REQUEST_TIMEOUT_MS = 20_000;

export class RedditApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RedditApiError';
    this.status = status;
  }
}

export interface RedditRequestOptions {
  credentials: RedditCredentials;
  signal?: AbortSignal | undefined;
  /** Injected in tests. */
  budget?: RedditBudget;
  tokens?: RedditTokenCache;
}

/**
 * `GET {path}` against the OAuth host, returning parsed JSON.
 *
 * A 401 invalidates the cached token and is retried once: a token can be revoked
 * mid-lifetime, and failing the whole poll over that would be needless.
 */
export async function redditGet<T>(path: string, options: RedditRequestOptions): Promise<T> {
  const budget = options.budget ?? redditBudget;
  const tokens = options.tokens ?? redditTokenCache;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await tokens.getToken(options.credentials, options.signal);

    await budget.acquire(options.signal);
    let response;
    try {
      response = await httpRequest(`${OAUTH_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          // Reddit blocks generic agents. This must be descriptive and stable.
          'User-Agent': options.credentials.userAgent,
          Accept: 'application/json',
        },
        timeoutMs: REQUEST_TIMEOUT_MS,
        // The budget decides when to back off; retrying inside the HTTP client
        // would spend requests the budget has not been told about.
        retries: 0,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (err) {
      throw new RedditApiError(
        err instanceof Error ? err.message : String(err),
        err instanceof HttpError ? err.status : undefined,
        err,
      );
    } finally {
      budget.release();
    }

    // The headers are authoritative even on an error response, so read them
    // before deciding what to do about the status.
    budget.observe(response.headers);

    if (response.status === 401 && attempt === 0) {
      tokens.invalidate();
      continue;
    }

    if (response.status === 429) {
      throw new RedditApiError('Reddit rate limited the request', 429);
    }

    if (response.status === 403) {
      throw new RedditApiError(
        'Reddit refused access. The subreddit may be private, quarantined or banned.',
        403,
      );
    }

    if (response.status === 404) {
      throw new RedditApiError('Reddit returned 404. The subreddit may not exist.', 404);
    }

    if (!response.ok) {
      throw new RedditApiError(`Reddit returned HTTP ${response.status}`, response.status);
    }

    try {
      return JSON.parse(response.body) as T;
    } catch (err) {
      throw new RedditApiError('Reddit response was not JSON', response.status, err);
    }
  }

  throw new RedditApiError('Reddit rejected the access token twice', 401);
}
