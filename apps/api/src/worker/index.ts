/**
 * The worker: a `pg-boss` instance, its queues, and its handlers.
 *
 * The API server and the worker share a process by default, controlled by
 * `WORKER_ENABLED`. They stay separable: nothing here imports from the HTTP layer.
 */

import PgBoss from 'pg-boss';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { listDueSourceIds } from '../db/sources.js';
import { pollSource } from '../ingest/runner.js';
import { refreshScores, rescoreRecent, scoreItems } from '../scoring/rescore.js';
import {
  POLL_CONCURRENCY,
  POLL_JITTER_SECONDS,
  POLL_TIMEOUT_SECONDS,
  QUEUE,
  QUEUE_DEFINITIONS,
  RESCORE_DEBOUNCE_SECONDS,
  RESCORE_TIMEOUT_SECONDS,
  SCORE_BATCH_SIZE,
  type PollSourceData,
  type RescoreData,
  type ScoreItemsData,
} from './queues.js';

const log = logger.child({ component: 'worker' });

let boss: PgBoss | null = null;

/**
 * Set by `startWorker` before it awaits anything, so a request that arrives
 * during startup can wait for the queues instead of finding a null instance.
 *
 * The HTTP server starts listening before the worker is ready -- deliberately,
 * so `/api/health` can report an unreachable database rather than hanging. That
 * leaves a window in which a source can be created, and without this a poll
 * enqueued in that window would be dropped with only a log line to show for it.
 */
let startPromise: Promise<PgBoss> | null = null;

export function getBoss(): PgBoss | null {
  return boss;
}

/** Resolves once the queues exist, or null when no worker runs in this process. */
async function readyBoss(): Promise<PgBoss | null> {
  if (boss !== null) return boss;
  if (startPromise === null) return null;
  try {
    return await startPromise;
  } catch {
    // startWorker already logged the failure; the caller reports "not queued".
    return null;
  }
}

/**
 * Enqueue a poll for one source, jittered.
 *
 * Exposed so `POST /api/sources/:id/poll` can force an immediate poll through
 * the same queue rather than running one inline on the request thread.
 */
export async function enqueuePoll(
  sourceId: number,
  options: { immediate?: boolean } = {},
): Promise<string | null> {
  const instance = await readyBoss();
  if (instance === null) {
    log.warn({ sourceId }, 'Cannot enqueue a poll: no worker is running in this process');
    return null;
  }

  const startAfter = options.immediate === true ? 0 : jitterSeconds();

  return instance.send(QUEUE.pollSource, { sourceId } satisfies PollSourceData, {
    startAfter,
    // One queued poll per source at a time; see QUEUE_DEFINITIONS.
    singletonKey: String(sourceId),
    expireInSeconds: POLL_TIMEOUT_SECONDS,
    retryLimit: 0,
  });
}

function jitterSeconds(): number {
  return Math.floor(Math.random() * (POLL_JITTER_SECONDS + 1));
}

/**
 * Request a rescore of the last 30 days, debounced.
 *
 * Called on every rule create, update and delete. The queue's `short` policy plus
 * the delay mean several rapid edits collapse into the one job already waiting,
 * rather than queueing five.
 */
export async function enqueueRescore(reason: string): Promise<string | null> {
  const instance = await readyBoss();
  if (instance === null) {
    log.warn({ reason }, 'Cannot enqueue a rescore: no worker is running in this process');
    return null;
  }

  return instance.send(QUEUE.rescoreAll, { reason } satisfies RescoreData, {
    startAfter: RESCORE_DEBOUNCE_SECONDS,
    singletonKey: 'all',
    expireInSeconds: RESCORE_TIMEOUT_SECONDS,
    retryLimit: 0,
  });
}

/** Score the items a poll just inserted. */
async function enqueueScoreItems(itemIds: readonly string[]): Promise<void> {
  if (itemIds.length === 0) return;

  const instance = await readyBoss();
  if (instance === null) return;

  await instance.send(QUEUE.scoreItems, { itemIds: [...itemIds] } satisfies ScoreItemsData);
}

/** `poll:tick` -- enqueue every due source. */
async function handleTick(): Promise<void> {
  const dueIds = await listDueSourceIds();
  if (dueIds.length === 0) {
    log.debug('Tick: no sources due');
    return;
  }

  const enqueued = await Promise.all(dueIds.map((id) => enqueuePoll(id)));
  // `send` returns null when the singleton policy rejected a duplicate, which is
  // the intended outcome for a source whose previous poll is still queued.
  const accepted = enqueued.filter((id) => id !== null).length;

  log.info({ due: dueIds.length, enqueued: accepted }, 'Tick: enqueued due sources');
}

/** `poll:source` -- run up to POLL_CONCURRENCY polls at a time. */
async function handlePollBatch(jobs: PgBoss.Job<PollSourceData>[]): Promise<void> {
  // pollSource never throws, so one bad source cannot fail the batch and put its
  // siblings back on the queue.
  const outcomes = await Promise.all(jobs.map((job) => pollSource(job.data.sourceId)));

  // Scoring is its own job so a slow rule set cannot eat into the poll timeout.
  const insertedIds = outcomes.flatMap((outcome) => outcome.insertedIds);
  await enqueueScoreItems(insertedIds);
}

/**
 * `score:items` -- score newly inserted items.
 *
 * Several polls' worth of ids are merged into one run: each run spins up a worker
 * thread for the regexes, and doing that per poll would be wasteful.
 */
async function handleScoreItems(jobs: PgBoss.Job<ScoreItemsData>[]): Promise<void> {
  const itemIds = [...new Set(jobs.flatMap((job) => job.data.itemIds))];
  if (itemIds.length === 0) return;

  const result = await scoreItems(itemIds);
  log.info({ ...result, jobs: jobs.length }, 'Scored newly ingested items');
}

/** `rescore:all` -- re-evaluate every pattern over the last 30 days. */
async function handleRescoreAll(jobs: PgBoss.Job<RescoreData>[]): Promise<void> {
  const reasons = [...new Set(jobs.map((job) => job.data.reason))];
  const result = await rescoreRecent();

  // Alerts are never generated here. Turning on alerting for a rule must not fire
  // hundreds of notifications about items already read.
  log.info({ ...result, reasons }, 'Rescored recent items');
}

/** `score:refresh` -- hourly, arithmetic only. */
async function handleScoreRefresh(): Promise<void> {
  const result = await refreshScores();
  log.info(result, 'Refreshed scores');
}

export async function startWorker(): Promise<PgBoss> {
  if (boss !== null) return boss;
  // Assigned synchronously so a concurrent enqueue has something to await.
  if (startPromise !== null) return startPromise;

  startPromise = start();
  try {
    return await startPromise;
  } catch (err) {
    // Clear it so a later call can retry rather than replaying the failure.
    startPromise = null;
    throw err;
  }
}

async function start(): Promise<PgBoss> {
  const instance = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Its own schema, so `pg_dump` of the application tables stays readable and
    // the job tables are obviously not application data.
    schema: 'pgboss',
    application_name: 'nexuscentral-worker',
    max: 4,
  });

  instance.on('error', (err) => {
    log.error({ err }, 'pg-boss error');
  });

  await instance.start();

  for (const definition of QUEUE_DEFINITIONS) {
    await instance.createQueue(definition.name, definition);
  }

  await instance.work(QUEUE.pollTick, { batchSize: 1 }, handleTick);
  await instance.work(QUEUE.pollSource, { batchSize: POLL_CONCURRENCY }, handlePollBatch);
  await instance.work(QUEUE.scoreItems, { batchSize: SCORE_BATCH_SIZE }, handleScoreItems);
  await instance.work(QUEUE.rescoreAll, { batchSize: 1 }, handleRescoreAll);
  await instance.work(QUEUE.scoreRefresh, { batchSize: 1 }, handleScoreRefresh);

  // Every minute. The tick itself is cheap; the jitter on each enqueued poll is
  // what spreads the actual work out.
  await instance.schedule(QUEUE.pollTick, '* * * * *');
  // Hourly, because the decay term drifts with time even when nothing changed.
  await instance.schedule(QUEUE.scoreRefresh, '7 * * * *');

  boss = instance;
  log.info({ concurrency: POLL_CONCURRENCY }, 'Worker started');
  return instance;
}

/**
 * Queue depth for `GET /api/health`.
 *
 * Zeroes when no worker runs in this process: reporting an empty queue is
 * accurate from here, and the health endpoint must not fail because the queues
 * live somewhere else.
 */
export async function queueDepth(): Promise<{ pending: number; failed: number }> {
  if (boss === null) return { pending: 0, failed: 0 };

  try {
    const [pending, failed] = await Promise.all([
      boss.getQueueSize(QUEUE.pollSource),
      boss.getQueueSize(QUEUE.pollSource, { before: 'failed' }),
    ]);
    return { pending, failed };
  } catch (err) {
    log.warn({ err }, 'Could not read queue depth');
    return { pending: 0, failed: 0 };
  }
}

export async function stopWorker(): Promise<void> {
  // A shutdown signal can arrive mid-startup; wait for the instance rather than
  // leaving a half-started pg-boss holding connections.
  const instance = boss ?? (startPromise === null ? null : await startPromise.catch(() => null));
  if (instance === null) return;

  boss = null;
  startPromise = null;
  // Let in-flight polls finish rather than orphaning them as active jobs.
  await instance.stop({ graceful: true, wait: true, timeout: 15_000 });
  log.info('Worker stopped');
}
