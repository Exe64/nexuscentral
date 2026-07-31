/**
 * The Nitter (X/Twitter) adapter (02-SPEC-ingestion.md 3.3).
 *
 * Explicitly best-effort and degradable. The official X API is pay-per-use with
 * no free tier since February 2026, which violates the zero-cost constraint, so
 * this goes through a self-hosted Nitter instance instead. Its failures must
 * never affect another source.
 *
 * Two things here are load-bearing:
 *
 * 1. **URL rewriting is not optional.** Item URLs and guids arrive pointing at
 *    the Nitter host. Rewriting them to x.com is what keeps `content_hash` stable
 *    when the instance changes; without it, switching instance duplicates the
 *    entire history.
 * 2. **Empty is not success.** This adapter fails by returning a well-formed feed
 *    with no items, so a zero-item run counts towards `consecutive_empty` rather
 *    than being reported as a healthy poll.
 */

import type {
  FetchContext,
  FetchResult,
  NormalizedItem,
  ResolvedSource,
  SourceAdapter,
} from '@nexuscentral/shared';
import { getRawSettings, resolveNitterBaseUrls } from '../../db/settings.js';
import { httpRequest, HttpError } from '../../lib/http.js';
import { FEED_ACCEPT_HEADER } from '../rss/discover.js';
import { FeedParseError, parseFeed } from '../rss/parse.js';

/** Public instances are unreliable; do not wait 30s on each of several. */
const PER_INSTANCE_TIMEOUT_MS = 12_000;

export const SAMPLE_ITEM_COUNT = 3;

const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/** `RT by @someone: ` — Nitter's retweet marker. */
const RETWEET_PREFIX = /^RT by @([A-Za-z0-9_]+):\s*/;

export class NitterNotConfiguredError extends Error {
  constructor() {
    super(
      'No Nitter instances are configured. Add one in Settings, or set NITTER_BASE_URLS. X support needs a self-hosted instance.',
    );
    this.name = 'NitterNotConfiguredError';
  }
}

export class NitterUnavailableError extends Error {
  /** What each instance did, so the UI can say more than "it failed". */
  readonly attempts: { baseUrl: string; reason: string }[];

  constructor(attempts: { baseUrl: string; reason: string }[]) {
    super(
      attempts.length === 0
        ? 'No Nitter instance was tried'
        : `No Nitter instance returned a parseable feed: ${attempts
            .map((attempt) => `${attempt.baseUrl} (${attempt.reason})`)
            .join('; ')}`,
    );
    this.name = 'NitterUnavailableError';
    this.attempts = attempts;
  }
}

export class NitterAdapter implements SourceAdapter {
  readonly kind = 'nitter' as const;

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { source, signal, logger } = ctx;

    const { urls } = resolveNitterBaseUrls(await getRawSettings());
    if (urls.length === 0) throw new NitterNotConfiguredError();

    const handle = normalizeHandle(source.identifier);
    const attempts: { baseUrl: string; reason: string }[] = [];

    // Ordered: self-hosted first. Stop at the first instance that parses.
    for (const baseUrl of urls) {
      const feedUrl = buildFeedUrl(baseUrl, handle);

      try {
        const response = await httpRequest(feedUrl, {
          headers: { Accept: FEED_ACCEPT_HEADER },
          timeoutMs: PER_INSTANCE_TIMEOUT_MS,
          // Rotating to the next instance is a better use of the time than
          // retrying one that just failed.
          retries: 0,
          ...(signal === undefined ? {} : { signal }),
        });

        if (!response.ok) {
          attempts.push({ baseUrl, reason: `HTTP ${response.status}` });
          continue;
        }

        // Reuse the RSS parser rather than duplicating one.
        const parsed = await parseFeed(response.body, response.url);
        const items = parsed.items.map((item) => rewriteToX(item, handle));

        if (items.length === 0) {
          // Reported, not thrown: an account really can have no posts, and the
          // consecutive_empty counter is what distinguishes the two cases over
          // time.
          logger.warn(
            { sourceId: source.id, baseUrl, handle },
            'Nitter returned a well-formed but empty feed; this is how the instance dies silently',
          );
        }

        return { items };
      } catch (err) {
        if (err instanceof FeedParseError) {
          attempts.push({ baseUrl, reason: 'response was not a feed' });
          continue;
        }
        if (err instanceof HttpError) {
          attempts.push({ baseUrl, reason: `${err.kind}: ${err.message}` });
          continue;
        }
        throw err;
      }
    }

    logger.warn({ sourceId: source.id, handle, attempts }, 'Every Nitter instance failed');
    throw new NitterUnavailableError(attempts);
  }

  async resolve(input: string): Promise<ResolvedSource[]> {
    const { urls } = resolveNitterBaseUrls(await getRawSettings());
    if (urls.length === 0) throw new NitterNotConfiguredError();

    const handle = normalizeHandle(input);
    if (!HANDLE_PATTERN.test(handle)) {
      throw new NitterUnavailableError([
        { baseUrl: '-', reason: `"${input}" is not a valid X handle` },
      ]);
    }

    const attempts: { baseUrl: string; reason: string }[] = [];

    for (const baseUrl of urls) {
      const feedUrl = buildFeedUrl(baseUrl, handle);
      try {
        const response = await httpRequest(feedUrl, {
          headers: { Accept: FEED_ACCEPT_HEADER },
          timeoutMs: PER_INSTANCE_TIMEOUT_MS,
          retries: 0,
        });
        if (!response.ok) {
          attempts.push({ baseUrl, reason: `HTTP ${response.status}` });
          continue;
        }

        const parsed = await parseFeed(response.body, response.url);
        const items = parsed.items.map((item) => rewriteToX(item, handle));

        return [
          {
            kind: 'nitter',
            identifier: handle,
            // The feed title is "handle / Name"; the handle is what identifies it.
            title: `@${handle}`,
            siteUrl: `https://x.com/${handle}`,
            sampleItems: items.slice(0, SAMPLE_ITEM_COUNT),
          },
        ];
      } catch (err) {
        if (err instanceof FeedParseError) {
          attempts.push({ baseUrl, reason: 'response was not a feed' });
          continue;
        }
        if (err instanceof HttpError) {
          attempts.push({ baseUrl, reason: `${err.kind}: ${err.message}` });
          continue;
        }
        throw err;
      }
    }

    throw new NitterUnavailableError(attempts);
  }
}

/**
 * Canonical identifier: bare, lowercase, no `@`.
 *
 * Strips any scheme and host rather than matching known ones, because a Nitter
 * instance can live on any domain and the handle is always the first path segment.
 */
export function normalizeHandle(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/[^/]*\/?/i, '')
    .replace(/^@/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

export function buildFeedUrl(baseUrl: string, handle: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${handle}/rss`;
}

/**
 * Rewrite a Nitter item so nothing in it refers to the instance.
 *
 * The URL *and* the guid both have to move: the guid is what deduplication
 * prefers, so leaving it pointing at the old host would reinsert the whole
 * timeline on an instance change even with the URL fixed.
 */
export function rewriteToX(item: NormalizedItem, handle: string): NormalizedItem {
  const url = toXUrl(item.url, handle);
  const guid = item.guid === undefined ? undefined : toXUrl(item.guid, handle);

  const { title, retweetedBy } = stripRetweetPrefix(item.title);

  return {
    ...item,
    url,
    title,
    ...(guid === undefined ? {} : { guid }),
    raw: {
      // Keep the original payload for debugging, and record what we derived.
      nitter: item.raw,
      handle,
      retweet: retweetedBy !== null,
      ...(retweetedBy === null ? {} : { retweetedBy }),
    },
  };
}

/**
 * Map a Nitter status URL onto x.com, preserving the path.
 *
 * The `#m` fragment Nitter appends is dropped -- canonicalisation would drop it
 * anyway, but the guid does not go through canonicalisation, so it has to go here.
 */
export function toXUrl(raw: string, handle: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Not a URL at all: synthesise something stable and instance-independent.
    return `https://x.com/${handle}/status/${encodeURIComponent(raw)}`;
  }

  // The `#m` Nitter appends is a fragment, so `pathname` already excludes it.
  const path = parsed.pathname.replace(/\/+$/, '');
  return `https://x.com${path === '' ? `/${handle}` : path}`;
}

function stripRetweetPrefix(title: string): { title: string; retweetedBy: string | null } {
  const match = RETWEET_PREFIX.exec(title);
  if (match === null) return { title, retweetedBy: null };
  return { title: title.slice(match[0].length), retweetedBy: match[1] ?? null };
}

export const nitterAdapter = new NitterAdapter();
