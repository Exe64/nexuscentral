/**
 * Adapter registry and kind detection.
 *
 * `POST /api/sources/resolve` takes one free-text input and works out what it is
 * (03-SPEC-api.md 2). Detection is pure and independent of whether the matching
 * adapter exists yet.
 */

import type { ResolvedSource, SourceAdapter, SourceKind } from '@feedhub/shared';
import { rssAdapter } from './rss/index.js';
import { HttpError } from '../http/errors.js';

/** Reddit and Nitter adapters land in Phase 2. */
const ADAPTERS: Partial<Record<SourceKind, SourceAdapter>> = {
  rss: rssAdapter,
};

export function getAdapter(kind: SourceKind): SourceAdapter | undefined {
  return ADAPTERS[kind];
}

export function requireAdapter(kind: SourceKind): SourceAdapter {
  const adapter = ADAPTERS[kind];
  if (adapter === undefined) {
    throw HttpError.validation(
      `${kind} sources are not supported by this build yet. RSS and Atom feeds work today.`,
    );
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
  return adapter.resolve(detected.identifier ?? input);
}
