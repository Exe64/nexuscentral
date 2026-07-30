/**
 * OPML import.
 *
 * Feed URLs are trusted rather than validated by fetching each one: importing a
 * 200-feed OPML would otherwise mean 200 requests before the user sees anything.
 * The first poll cycle discovers what is dead, and the source-health surface is
 * where that belongs.
 */

import { createSource, findSourceByIdentity } from '../db/sources.js';
import { ensureTagsByName } from '../db/tags.js';
import { DEFAULT_POLL_SECONDS } from '../lib/interval.js';
import { slugify } from '../lib/slug.js';
import { logger } from '../logger.js';
import type { OpmlDocument } from '../opml/index.js';

export interface ImportOptions {
  /** Applied to every imported source, on top of its OPML folders. */
  tagIds: readonly number[];
  importCategoriesAsTags: boolean;
}

export interface ImportResult {
  created: number;
  /** Feeds already tracked. Re-importing an OPML must be a no-op, not an error. */
  alreadyTracked: number;
  failed: { xmlUrl: string; reason: string }[];
  createdSourceIds: number[];
  tagsUsed: number;
  /** Outlines that carried no usable xmlUrl. */
  skippedOutlines: number;
}

export async function importOpml(
  document: OpmlDocument,
  options: ImportOptions,
): Promise<ImportResult> {
  const log = logger.child({ component: 'opml-import' });

  const tagsBySlug = options.importCategoriesAsTags
    ? await ensureTagsByName(document.feeds.flatMap((feed) => feed.categories))
    : new Map();

  const result: ImportResult = {
    created: 0,
    alreadyTracked: 0,
    failed: [],
    createdSourceIds: [],
    tagsUsed: tagsBySlug.size,
    skippedOutlines: document.skipped,
  };

  for (const feed of document.feeds) {
    try {
      const existing = await findSourceByIdentity('rss', feed.xmlUrl);
      if (existing !== null) {
        result.alreadyTracked += 1;
        continue;
      }

      const categoryTagIds = feed.categories
        .map((name) => tagsBySlug.get(slugify(name))?.id)
        .filter((id): id is number => id !== undefined);

      const source = await createSource({
        kind: 'rss',
        identifier: feed.xmlUrl,
        title: feed.title,
        siteUrl: feed.htmlUrl ?? null,
        pollIntervalSeconds: DEFAULT_POLL_SECONDS,
        tagIds: [...new Set([...options.tagIds, ...categoryTagIds])],
      });

      result.created += 1;
      result.createdSourceIds.push(source.id);
    } catch (err) {
      // One bad outline must not abort the import; report it per-feed so the user
      // can see which lines of their file did not make it.
      const reason = err instanceof Error ? err.message : String(err);
      result.failed.push({ xmlUrl: feed.xmlUrl, reason });
      log.warn({ xmlUrl: feed.xmlUrl, err }, 'Skipped an OPML entry');
    }
  }

  // New sources have last_run_at NULL, so the next poll:tick picks them all up
  // with per-job jitter. Enqueueing here would stampede on a large import.
  log.info(
    {
      created: result.created,
      alreadyTracked: result.alreadyTracked,
      failed: result.failed.length,
    },
    'OPML import complete',
  );

  return result;
}
