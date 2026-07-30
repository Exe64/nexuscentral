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
import {
  POLL_CONCURRENCY,
  POLL_JITTER_SECONDS,
  POLL_TIMEOUT_SECONDS,
  QUEUE,
  QUEUE_DEFINITIONS,
  type PollSourceData,
} from './queues.js';

const log = logger.child({ component: 'worker' });

let boss: PgBoss | null = null;

export function getBoss(): PgBoss | null {
  return boss;
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
  if (boss === null) {
    log.warn({ sourceId }, 'Cannot enqueue a poll: the worker is not running');
    return null;
  }

  const startAfter = options.immediate === true ? 0 : jitterSeconds();

  return boss.send(QUEUE.pollSource, { sourceId } satisfies PollSourceData, {
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
  await Promise.all(jobs.map((job) => pollSource(job.data.sourceId)));
}

export async function startWorker(): Promise<PgBoss> {
  if (boss !== null) return boss;

  const instance = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Its own schema, so `pg_dump` of the application tables stays readable and
    // the job tables are obviously not application data.
    schema: 'pgboss',
    application_name: 'feedhub-worker',
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

  // Every minute. The tick itself is cheap; the jitter on each enqueued poll is
  // what spreads the actual work out.
  await instance.schedule(QUEUE.pollTick, '* * * * *');

  boss = instance;
  log.info({ concurrency: POLL_CONCURRENCY }, 'Worker started');
  return instance;
}

export async function stopWorker(): Promise<void> {
  if (boss === null) return;
  const instance = boss;
  boss = null;
  // Let in-flight polls finish rather than orphaning them as active jobs.
  await instance.stop({ graceful: true, wait: true, timeout: 15_000 });
  log.info('Worker stopped');
}
