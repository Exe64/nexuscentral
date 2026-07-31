/**
 * Retention and vacuum (01-SPEC-data-model.md 3).
 *
 * Three jobs that keep the database from growing without bound:
 *
 * - **`retention:items`** deletes items past the retention window. Starred items
 *   are exempt: starring is the user saying "keep this", and a retention policy
 *   that deletes it anyway is a bug people only discover once.
 * - **`retention:raw`** nulls the original payload after a week. `raw` exists to
 *   debug an adapter, which is a thing you do days after a poll, not months.
 * - **`vacuum:analyze`** weekly, because a table that deletes tens of thousands
 *   of rows a night needs its statistics refreshed or the planner starts choosing
 *   sequential scans over the indexes the reader depends on.
 */

import { query } from '../db/pool.js';
import { getRawSettings } from '../db/settings.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'retention' });

/** Deleted in batches so one night's purge cannot hold a lock for minutes. */
export const DELETE_BATCH = 5_000;

/** `raw` is for debugging an adapter, which happens within days. */
export const RAW_RETENTION_DAYS = 7;

export interface PurgeResult {
  deleted: number;
  batches: number;
  durationMs: number;
  /** The cutoff used, so the log line says what "old" meant on this run. */
  olderThan: string;
}

/**
 * Delete unstarred items past the retention window.
 *
 * Batched with a self-limiting delete rather than one statement: 200k rows in a
 * single transaction takes a long lock on the table the reader is querying, and
 * `alerts` cascades from it. Several smaller transactions leave gaps for
 * everything else to run in.
 */
export async function purgeOldItems(now = new Date()): Promise<PurgeResult> {
  const startedAt = Date.now();
  const settings = await getRawSettings();
  const cutoff = new Date(now.getTime() - settings.itemsRetentionDays * 86_400_000);

  let deleted = 0;
  let batches = 0;

  for (;;) {
    const result = await query(
      `DELETE FROM items
        WHERE id IN (
          SELECT id FROM items
           WHERE published_at < $1::timestamptz AND starred = false
           LIMIT $2
        )`,
      [cutoff.toISOString(), DELETE_BATCH],
    );

    const count = result.rowCount ?? 0;
    deleted += count;
    batches += 1;

    if (count < DELETE_BATCH) break;
  }

  const outcome: PurgeResult = {
    deleted,
    batches,
    durationMs: Date.now() - startedAt,
    olderThan: cutoff.toISOString(),
  };

  if (deleted > 0)
    log.info({ ...outcome, retentionDays: settings.itemsRetentionDays }, 'Purged old items');
  else log.debug(outcome, 'Nothing to purge');

  return outcome;
}

/** Drop the stored upstream payload once it has stopped being useful. */
export async function purgeRawPayloads(now = new Date()): Promise<{ cleared: number }> {
  const cutoff = new Date(now.getTime() - RAW_RETENTION_DAYS * 86_400_000);

  const result = await query(
    `UPDATE items SET raw = NULL
      WHERE raw IS NOT NULL AND fetched_at < $1::timestamptz`,
    [cutoff.toISOString()],
  );

  const cleared = result.rowCount ?? 0;
  if (cleared > 0) log.info({ cleared, olderThan: cutoff.toISOString() }, 'Cleared raw payloads');
  return { cleared };
}

/**
 * `VACUUM ANALYZE items`.
 *
 * Cannot run inside a transaction, and `query` does not open one, so this is
 * fine as written -- but it is the reason this is its own function rather than
 * one more statement in the purge above.
 */
export async function vacuumItems(): Promise<{ durationMs: number }> {
  const startedAt = Date.now();
  await query('VACUUM ANALYZE items');
  const durationMs = Date.now() - startedAt;
  log.info({ durationMs }, 'Vacuumed items');
  return { durationMs };
}
