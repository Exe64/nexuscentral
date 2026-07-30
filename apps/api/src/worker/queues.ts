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
];
