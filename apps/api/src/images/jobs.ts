/**
 * Backfilling preview images for items whose feed carried none.
 *
 * Runs as its own job rather than inside the poll, for two reasons. A poll has a
 * 30s ceiling and must not spend it on twenty article fetches; and the work is
 * naturally resumable -- `image_checked_at` records that an item was tried, so a
 * job killed halfway simply picks up where it stopped.
 *
 * The batch is bounded and the job re-enqueues itself while work remains. That
 * is what lets a database already full of items drain gradually instead of
 * firing thousands of requests the first time this ships.
 */

import { query } from '../db/pool.js';
import { logger } from '../logger.js';
import { fetchOgImage } from './og.js';

const log = logger.child({ component: 'images' });

/** Items per job. Small enough that one run is quick and easy to interrupt. */
export const BATCH_SIZE = 25;

/**
 * Concurrent article fetches.
 *
 * Deliberately low. These go to whatever hosts the feeds name, and a self-hosted
 * aggregator has no business opening twenty connections to someone's blog.
 */
export const CONCURRENCY = 3;

export interface EnrichResult {
  considered: number;
  found: number;
  /** True when more rows were waiting, so the caller re-enqueues. */
  more: boolean;
  durationMs: number;
}

/**
 * Fill in images for one batch of pending items.
 *
 * "Pending" is `image_url IS NULL AND image_checked_at IS NULL`, which the
 * partial index in 005 covers exactly. Every item in the batch is stamped
 * whether or not an image was found: most articles that lack one will always
 * lack one, and without the stamp this job would retry them forever.
 */
export async function enrichPendingImages(limit = BATCH_SIZE): Promise<EnrichResult> {
  const startedAt = Date.now();

  const { rows } = await query<{ id: string; url: string }>(
    `SELECT id, url
       FROM items
      WHERE image_url IS NULL AND image_checked_at IS NULL
      ORDER BY published_at DESC
      LIMIT $1`,
    [limit + 1],
  );

  // One extra row is fetched purely to answer "is there more?" without a second
  // count query over the same predicate.
  const more = rows.length > limit;
  const batch = rows.slice(0, limit);

  if (batch.length === 0) {
    return { considered: 0, found: 0, more: false, durationMs: Date.now() - startedAt };
  }

  const found = new Map<string, string>();
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
      for (;;) {
        const next = batch[cursor++];
        if (next === undefined) return;
        const image = await fetchOgImage(next.url);
        if (image !== null) found.set(next.id, image);
      }
    }),
  );

  // One statement for the whole batch. Stamping row by row would leave a job
  // that dies mid-batch having re-fetched everything it already tried.
  await query(
    `UPDATE items AS i
        SET image_url = COALESCE(v.image, i.image_url),
            image_checked_at = now()
       FROM unnest($1::bigint[], $2::text[]) AS v(id, image)
      WHERE i.id = v.id`,
    [batch.map((row) => row.id), batch.map((row) => found.get(row.id) ?? null)],
  );

  const result: EnrichResult = {
    considered: batch.length,
    found: found.size,
    more,
    durationMs: Date.now() - startedAt,
  };

  log.info(result, 'Preview images backfilled');
  return result;
}
