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

export interface PollSourceData {
  sourceId: number;
}

/**
 * `short` allows one *queued* job per singleton key with unlimited active ones.
 * For `poll:source` keyed by source id that means a slow source cannot accumulate
 * a backlog of identical polls; for `poll:tick` it means a worker that fell
 * behind does not run a queue of stale ticks all at once.
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
];
