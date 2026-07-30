/**
 * Feed parsing, shared by the RSS and Nitter adapters.
 *
 * Nitter serves RSS, so it reuses this parser rather than duplicating one
 * (02-SPEC-ingestion.md 3.3). Keep this module free of HTTP and of any
 * source-specific behaviour.
 */

import Parser from 'rss-parser';
import type { NormalizedItem } from '@feedhub/shared';
import { SUMMARY_MAX_LENGTH, toPlainTitle, toSummary } from '../../lib/text.js';

/**
 * `rss-parser`'s own types are `any`-heavy. Narrowing to the fields actually
 * read keeps the rest of the codebase honest about what a feed guarantees --
 * which is very little.
 */
interface RawFeedItem {
  title?: string;
  link?: string;
  guid?: string;
  id?: string;
  isoDate?: string;
  pubDate?: string;
  updated?: string;
  published?: string;
  creator?: string;
  author?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
  'content:encoded'?: string;
  'dc:creator'?: string;
}

interface RawFeed {
  title?: string;
  description?: string;
  link?: string;
  image?: { url?: string };
  itunes?: { image?: string };
  items?: RawFeedItem[];
}

export interface ParsedFeed {
  title?: string;
  siteUrl?: string;
  iconUrl?: string;
  description?: string;
  items: NormalizedItem[];
  /** Items that fell all the way through the date chain to `now()`. */
  undatedCount: number;
  /** Items dropped because they carried no usable URL. */
  skippedCount: number;
}

export class FeedParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FeedParseError';
  }
}

const parser = new Parser({
  customFields: {
    item: ['content:encoded', 'dc:creator', 'updated', 'published', 'summary', 'id'],
  },
});

/** `isoDate` -> `pubDate` -> `updated` -> `now()` (02-SPEC-ingestion.md 3.1). */
function resolvePublishedAt(item: RawFeedItem): { date: Date; wasMissing: boolean } {
  for (const candidate of [item.isoDate, item.pubDate, item.updated, item.published]) {
    if (candidate === undefined || candidate === '') continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return { date: parsed, wasMissing: false };
  }
  // A feed with no usable dates is unreliable, which makes dedup carry more
  // weight -- the caller logs this at WARN.
  return { date: new Date(), wasMissing: true };
}

function resolveUrl(raw: string | undefined, base: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (base === undefined) return trimmed;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed;
  }
}

/**
 * Atom uses `id`, RSS uses `guid`, and some feeds put the permalink in both. A
 * guid equal to the link adds nothing, so it is dropped: the hash falls back to
 * the canonicalised URL, which strips tracking parameters the raw guid would not.
 */
function resolveGuid(item: RawFeedItem, url: string): string | undefined {
  const raw = item.guid ?? item.id;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === url) return undefined;
  return trimmed;
}

function resolveSummary(item: RawFeedItem): string | undefined {
  const source =
    item['content:encoded'] ?? item.content ?? item.summary ?? item.contentSnippet ?? undefined;
  return toSummary(source, SUMMARY_MAX_LENGTH);
}

function resolveAuthor(item: RawFeedItem): string | undefined {
  const raw = item.creator ?? item['dc:creator'] ?? item.author;
  if (raw === undefined) return undefined;
  const cleaned = toPlainTitle(raw);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Parse a feed document. `baseUrl` resolves relative item links, which Atom
 * permits and several generators emit.
 *
 * Throws `FeedParseError` for a document that is not a feed at all. A feed that
 * parses but contains unusable entries is not an error: the entries are counted
 * and skipped, because one broken item must not lose the other forty.
 */
export async function parseFeed(xml: string, baseUrl?: string): Promise<ParsedFeed> {
  let feed: RawFeed;
  try {
    feed = (await parser.parseString(xml)) as RawFeed;
  } catch (err) {
    throw new FeedParseError(
      err instanceof Error ? err.message : 'Feed did not parse as RSS or Atom',
      err,
    );
  }

  const siteUrl = resolveUrl(feed.link, baseUrl);
  const items: NormalizedItem[] = [];
  let undatedCount = 0;
  let skippedCount = 0;

  for (const raw of feed.items ?? []) {
    const url = resolveUrl(raw.link, siteUrl ?? baseUrl);
    if (url === undefined) {
      skippedCount += 1;
      continue;
    }

    const { date, wasMissing } = resolvePublishedAt(raw);
    if (wasMissing) undatedCount += 1;

    const title = raw.title === undefined ? '' : toPlainTitle(raw.title);
    const guid = resolveGuid(raw, url);
    const summary = resolveSummary(raw);
    const author = resolveAuthor(raw);

    items.push({
      url,
      // `title` is NOT NULL in the schema and an empty heading renders as a
      // blank row, so fall back to something clickable.
      title: title.length > 0 ? title : url,
      ...(summary === undefined ? {} : { summary }),
      ...(author === undefined ? {} : { author }),
      publishedAt: date,
      ...(guid === undefined ? {} : { guid }),
      raw,
    });
  }

  const feedTitle = feed.title === undefined ? undefined : toPlainTitle(feed.title);
  const iconUrl = resolveUrl(feed.image?.url ?? feed.itunes?.image, siteUrl ?? baseUrl);
  const description = feed.description === undefined ? undefined : toSummary(feed.description, 300);

  return {
    ...(feedTitle === undefined || feedTitle.length === 0 ? {} : { title: feedTitle }),
    ...(siteUrl === undefined ? {} : { siteUrl }),
    ...(iconUrl === undefined ? {} : { iconUrl }),
    ...(description === undefined ? {} : { description }),
    items,
    undatedCount,
    skippedCount,
  };
}
