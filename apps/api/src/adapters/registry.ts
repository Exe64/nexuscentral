/**
 * Adapter registry and kind detection.
 *
 * `POST /api/sources/resolve` takes one free-text input and works out what it is
 * (03-SPEC-api.md 2). Detection is pure and independent of whether the matching
 * adapter exists yet.
 */

import type { ResolvedSource, SourceAdapter, SourceKind } from '@nexuscentral/shared';
import { normalizeInputUrl, rssAdapter } from './rss/index.js';
import { redditFeedUrl } from './rss/reddit.js';
import { redditAdapter, RedditNotConfiguredError } from './reddit/index.js';
import { nitterAdapter, NitterNotConfiguredError } from './nitter/index.js';
import { HttpError } from '../http/errors.js';

const ADAPTERS: Record<SourceKind, SourceAdapter> = {
  rss: rssAdapter,
  reddit: redditAdapter,
  nitter: nitterAdapter,
};

export function getAdapter(kind: SourceKind): SourceAdapter | undefined {
  return ADAPTERS[kind];
}

export function requireAdapter(kind: SourceKind): SourceAdapter {
  const adapter = ADAPTERS[kind];
  if (adapter === undefined) {
    throw HttpError.validation(`${kind} sources are not supported by this build.`);
  }
  return adapter;
}

const REDDIT_PATTERNS = [
  // r/name, /r/name
  /^\/?r\/([a-z0-9_]{2,21})\/?$/i,
  // A reddit URL, with or without a scheme
  /^(?:https?:\/\/)?(?:www\.|old\.|new\.|np\.)?reddit\.com\/r\/([a-z0-9_]{2,21})/i,
];

const X_PATTERNS = [
  // @handle
  /^@([a-z0-9_]{1,15})$/i,
  // x.com/handle or twitter.com/handle
  /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([a-z0-9_]{1,15})\/?(?:$|\?)/i,
];

export interface DetectedInput {
  kind: SourceKind;
  /** The canonical identifier for that kind, when detection could extract one. */
  identifier?: string;
}

/**
 * Detection order matters: a reddit.com URL is a subreddit, not a web page to
 * scrape for a feed, and an x.com URL must never fall through to RSS.
 */
export function detectKind(input: string): DetectedInput {
  const trimmed = input.trim();

  for (const pattern of REDDIT_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match?.[1] !== undefined) {
      // Bare, lowercase, no `r/` prefix (01-SPEC-data-model.md 1.2).
      return { kind: 'reddit', identifier: match[1].toLowerCase() };
    }
  }

  for (const pattern of X_PATTERNS) {
    const match = pattern.exec(trimmed);
    const handle = match?.[1]?.toLowerCase();
    // `x.com/i/...` and `x.com/home` are not accounts.
    if (handle !== undefined && !['i', 'home', 'search', 'explore'].includes(handle)) {
      return { kind: 'nitter', identifier: handle };
    }
  }

  return { kind: 'rss' };
}

/** Dispatch resolution to the adapter for the detected kind. */
export async function resolveInput(input: string): Promise<ResolvedSource[]> {
  if (input.trim() === '') {
    throw HttpError.validation('Enter a feed URL, a blog address, a subreddit or an X handle.');
  }

  const detected = detectKind(input);
  const adapter = requireAdapter(detected.kind);

  try {
    return await adapter.resolve(detected.identifier ?? input);
  } catch (err) {
    // A subreddit without credentials is not a dead end: the public Atom feed
    // needs none. Refusing here would be the wrong answer to the wrong question,
    // since OAuth registration takes weeks and the feed works today. What the
    // fallback cannot carry is `ups` and `num_comments`, so these resolve as
    // `rss` sources with no engagement term -- which is exactly what they are,
    // and what makes moving them to `reddit` worthwhile once credentials exist.
    if (err instanceof RedditNotConfiguredError) {
      return await rssAdapter.resolve(redditFallbackUrl(input, detected.identifier));
    }

    // Nitter has no such fallback: the instance list *is* the fallback. Missing
    // configuration is the operator's to fix, not an upstream failure, and must
    // not read as a 502 with a message about the network.
    if (err instanceof NitterNotConfiguredError) {
      throw HttpError.validation(err.message, { kind: detected.kind, configured: false });
    }
    throw err;
  }
}

/**
 * The feed URL to try when Reddit credentials are missing.
 *
 * Prefers the input, because `detectKind` reduces a URL to a bare subreddit name
 * and that throws away the listing and the query: `/r/x/top?t=week` would come
 * back as plain `/r/x`. Falls back to building one from the name for inputs like
 * `r/steamdeck`, which is not a URL at all.
 */
function redditFallbackUrl(input: string, identifier: string | undefined): string {
  return (
    redditFeedUrl(normalizeInputUrl(input)) ??
    `https://www.reddit.com/r/${identifier ?? ''}/new.rss`
  );
}
