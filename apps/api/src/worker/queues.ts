/**
 * Queue names and their policies, in one place.
 *
 * `pg-boss` is used rather than BullMQ so a single-user deployment does not need
 * a Redis container (decision D4).
 */

import type PgBoss from 'pg-boss';

export const QUEUE = {
  /** Runs every minute and enqueues a poll for every source that is due. */
  pollTick: 'poll:tick',
  /** One job per source. */
  pollSource: 'poll:source',
  /** Score the items a poll just inserted. */
  scoreItems: 'score:items',
  /** Re-evaluate every pattern over the last 30 days. Debounced. */
  rescoreAll: 'rescore:all',
  /** Hourly arithmetic-only recompute, because the decay term drifts. */
  scoreRefresh: 'score:refresh',
  /** Push whatever alerts are pending, as one grouped notification. */
  deliverAlerts: 'deliver:alerts',
  /** Nightly: delete unstarred items past the retention window. */
  retentionItems: 'retention:items',
  /** Nightly: drop the stored upstream payload once it stops being useful. */
  retentionRaw: 'retention:raw',
  /** Weekly: refresh the statistics the reader's indexes depend on. */
  vacuumAnalyze: 'vacuum:analyze',
} as const;

/** Concurrent `poll:source` jobs (02-SPEC-ingestion.md 7). */
export const POLL_CONCURRENCY = 4;

/** Per-job timeout. */
export const POLL_TIMEOUT_SECONDS = 60;

/**
 * Jitter window. Without it, every source enqueued on the minute boundary
 * stampedes at once.
 */
export const POLL_JITTER_SECONDS = 20;

/**
 * How long a rescore request waits before running.
 *
 * This is the debounce: the queue policy allows one queued job at a time, so
 * several rule edits inside this window collapse into the single job already
 * waiting rather than queueing five.
 */
export const RESCORE_DEBOUNCE_SECONDS = 5;

/** A 50k-item rescore should take seconds; this is headroom, not a target. */
export const RESCORE_TIMEOUT_SECONDS = 300;

/** How many poll results one scoring job absorbs, to avoid a worker thread each. */
export const SCORE_BATCH_SIZE = 10;

/**
 * How long a delivery waits before running.
 *
 * This is the grouping window. With the `short` policy below, every alert raised
 * inside it collapses into the one job already queued, so two polls seconds apart
 * produce one notification. Short enough that the spec's "delivers within 60 s"
 * has room for the delivery itself and up to three retries.
 */
export const DELIVER_DEBOUNCE_SECONDS = 10;

export const DELIVER_TIMEOUT_SECONDS = 120;

/**
 * Retention runs against the whole table, and a vacuum on a large one is not
 * quick. Generous, because being killed halfway through a batched delete leaves
 * the work half done and the next run has to redo it.
 */
export const RETENTION_TIMEOUT_SECONDS = 1_800;

export interface PollSourceData {
  sourceId: number;
}

export interface ScoreItemsData {
  itemIds: string[];
}

export interface RescoreData {
  reason: string;
}

/**
 * `short` allows one *queued* job per singleton key with unlimited active ones.
 * For `poll:source` keyed by source id that means a slow source cannot accumulate
 * a backlog of identical polls; for `poll:tick` it means a worker that fell
 * behind does not run a queue of stale ticks all at once; for `rescore:all` it is
 * the debounce.
 */
export const QUEUE_DEFINITIONS: PgBoss.Queue[] = [
  {
    name: QUEUE.pollTick,
    policy: 'short',
    // The tick only reads which sources are due; re-running it is cheap and the
    // next tick is a minute away, so a retry buys nothing.
    retryLimit: 0,
    expireInSeconds: 30,
  },
  {
    name: QUEUE.pollSource,
    policy: 'short',
    // The runner already records the failure and extends the interval by
    // `2 ^ consecutive_failures`. A queue-level retry would double-count it.
    retryLimit: 0,
    expireInSeconds: POLL_TIMEOUT_SECONDS,
  },
  {
    name: QUEUE.scoreItems,
    policy: 'standard',
    // Worth one retry: a transient database error here would leave new items
    // unscored and invisible to a score-sorted feed.
    retryLimit: 2,
    retryDelay: 5,
    expireInSeconds: 120,
  },
  {
    name: QUEUE.rescoreAll,
    policy: 'short',
    retryLimit: 0,
    expireInSeconds: RESCORE_TIMEOUT_SECONDS,
  },
  {
    name: QUEUE.scoreRefresh,
    policy: 'short',
    retryLimit: 0,
    expireInSeconds: RESCORE_TIMEOUT_SECONDS,
  },
  {
    name: QUEUE.retentionItems,
    policy: 'short',
    // No retry: the next run is tomorrow, and a purge that failed on a lock will
    // simply pick up the same rows then.
    retryLimit: 0,
    expireInSeconds: RETENTION_TIMEOUT_SECONDS,
  },
  {
    name: QUEUE.retentionRaw,
    policy: 'short',
    retryLimit: 0,
    expireInSeconds: RETENTION_TIMEOUT_SECONDS,
  },
  {
    name: QUEUE.vacuumAnalyze,
    policy: 'short',
    retryLimit: 0,
    expireInSeconds: RETENTION_TIMEOUT_SECONDS,
  },
  {
    name: QUEUE.deliverAlerts,
    // `short` is the grouping: one queued delivery at a time, so a burst of polls
    // produces one notification rather than one per poll.
    policy: 'short',
    // The handler owns the 1s/5s/25s retry, because a queue-level retry would
    // re-read the pending set and could group differently on the second attempt.
    retryLimit: 0,
    expireInSeconds: DELIVER_TIMEOUT_SECONDS,
  },
];
