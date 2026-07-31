/**
 * The RSS/Atom adapter (02-SPEC-ingestion.md 3.1).
 *
 * Unrestricted and the backbone of the system, which is exactly why it must be a
 * good citizen: conditional requests are mandatory, the body is capped, and the
 * User-Agent is descriptive.
 */

import type {
  FetchContext,
  FetchResult,
  NormalizedItem,
  ResolvedSource,
  SourceAdapter,
} from '@nexuscentral/shared';
import { DEFAULT_MAX_BYTES, httpRequest, HttpError } from '../../lib/http.js';
import {
  extractFeedLinks,
  extractHtmlTitle,
  extractIconUrl,
  fallbackFeedUrls,
  FEED_ACCEPT_HEADER,
  isXmlContentType,
  looksLikeFeed,
} from './discover.js';
import { FeedParseError, parseFeed, type ParsedFeed } from './parse.js';

/** Per-request budget during resolution, so several candidates fit the route's 15s. */
const RESOLVE_TIMEOUT_MS = 8_000;

/** A page listing a dozen feeds is a category index; showing them all is noise. */
const MAX_CANDIDATES = 5;

export const SAMPLE_ITEM_COUNT = 3;

export class RssAdapter implements SourceAdapter {
  readonly kind = 'rss' as const;

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const { source, signal, logger, conditional } = ctx;

    const response = await httpRequest(source.identifier, {
      headers: {
        Accept: FEED_ACCEPT_HEADER,
        'If-None-Match': conditional?.etag,
        'If-Modified-Since': conditional?.lastModified,
      },
      signal,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    if (response.status === 304) {
      // Nothing changed: do not touch the item store.
      return { items: [], notModified: true };
    }

    if (!response.ok) {
      throw new HttpError('status', `HTTP ${response.status}`, source.identifier, response.status);
    }

    const parsed = await parseFeed(response.body, response.url);

    if (parsed.undatedCount > 0) {
      logger.warn(
        { sourceId: source.id, undatedCount: parsed.undatedCount },
        'Feed items had no usable date and fell back to now(); dedup carries more weight here',
      );
    }
    if (parsed.skippedCount > 0) {
      logger.warn(
        { sourceId: source.id, skippedCount: parsed.skippedCount },
        'Feed items had no usable URL and were skipped',
      );
    }

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');

    return {
      items: parsed.items,
      ...(etag === null ? {} : { etag }),
      ...(lastModified === null ? {} : { lastModified }),
    };
  }

  /**
   * Accepts a page URL, not just a feed URL. Detection order per the spec:
   * an XML response is the feed; otherwise look for `<link rel="alternate">`;
   * otherwise try the conventional paths.
   */
  async resolve(input: string): Promise<ResolvedSource[]> {
    const entryUrl = normalizeInputUrl(input);

    const response = await httpRequest(entryUrl, {
      headers: { Accept: FEED_ACCEPT_HEADER },
      timeoutMs: RESOLVE_TIMEOUT_MS,
      retries: 1,
    });

    if (!response.ok) {
      throw new HttpError('status', `HTTP ${response.status}`, entryUrl, response.status);
    }

    // 1. The URL responds with XML: it is the feed.
    if (isXmlContentType(response.contentType) || looksLikeFeed(response.body)) {
      const parsed = await parseFeed(response.body, response.url);
      return [toResolvedSource(response.url, parsed)];
    }

    // 2. An HTML page: read its advertised feeds.
    const html = response.body;
    const pageIcon = extractIconUrl(html, response.url);
    const pageTitle = extractHtmlTitle(html);

    const advertised = extractFeedLinks(html, response.url).slice(0, MAX_CANDIDATES);
    const candidates = await this.#resolveCandidates(advertised, pageIcon, pageTitle);
    if (candidates.length > 0) return candidates;

    // 3. Nothing advertised: try the conventional paths. Stop at the first hit
    // rather than probing all four -- the rest would be the same feed.
    for (const guess of fallbackFeedUrls(response.url)) {
      const candidate = await this.#tryCandidate(guess, pageIcon, pageTitle);
      if (candidate !== null) return [candidate];
    }

    return [];
  }

  async #resolveCandidates(
    urls: string[],
    fallbackIcon: string | undefined,
    fallbackTitle: string | undefined,
  ): Promise<ResolvedSource[]> {
    // Concurrent: a page advertising five feeds should not cost five round trips
    // in series inside a 15s budget.
    const settled = await Promise.all(
      urls.map((url) => this.#tryCandidate(url, fallbackIcon, fallbackTitle)),
    );
    return settled.filter((candidate): candidate is ResolvedSource => candidate !== null);
  }

  /** Returns null instead of throwing: one dead candidate must not sink the others. */
  async #tryCandidate(
    url: string,
    fallbackIcon: string | undefined,
    fallbackTitle: string | undefined,
  ): Promise<ResolvedSource | null> {
    try {
      const response = await httpRequest(url, {
        headers: { Accept: FEED_ACCEPT_HEADER },
        timeoutMs: RESOLVE_TIMEOUT_MS,
        retries: 0,
      });
      if (!response.ok) return null;
      if (!isXmlContentType(response.contentType) && !looksLikeFeed(response.body)) return null;

      const parsed = await parseFeed(response.body, response.url);
      return toResolvedSource(response.url, parsed, fallbackIcon, fallbackTitle);
    } catch (err) {
      if (err instanceof FeedParseError || err instanceof HttpError) return null;
      throw err;
    }
  }
}

/**
 * A bare hostname is what people paste. Assume https rather than rejecting it --
 * and never assume http, which would downgrade a site that only serves TLS.
 */
export function normalizeInputUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

function toResolvedSource(
  feedUrl: string,
  parsed: ParsedFeed,
  fallbackIcon?: string,
  fallbackTitle?: string,
): ResolvedSource {
  const title = parsed.title ?? fallbackTitle ?? hostnameOf(feedUrl);
  const siteUrl = parsed.siteUrl ?? originOf(feedUrl);
  const iconUrl = parsed.iconUrl ?? fallbackIcon ?? faviconOf(feedUrl);

  return {
    kind: 'rss',
    identifier: feedUrl,
    title,
    ...(siteUrl === undefined ? {} : { siteUrl }),
    ...(iconUrl === undefined ? {} : { iconUrl }),
    // Seeing real items before committing is what makes adding a source safe.
    sampleItems: parsed.items.slice(0, SAMPLE_ITEM_COUNT) satisfies NormalizedItem[],
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function faviconOf(url: string): string | undefined {
  const origin = originOf(url);
  return origin === undefined ? undefined : `${origin}/favicon.ico`;
}

export const rssAdapter = new RssAdapter();
