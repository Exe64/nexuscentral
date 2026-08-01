import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only, so it is erased and does not defeat vi.resetModules().
import type * as WorkerModule from '../../src/worker/index.js';

/**
 * The HTTP server starts listening before the worker finishes starting, so a
 * source can be created while pg-boss is still coming up. An enqueue in that
 * window must wait for the queues rather than be dropped: the alternative is a
 * source that silently never gets its first poll, with only a log line to show.
 */

interface SentJob {
  name: string;
  data: unknown;
  options: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  sent: [] as SentJob[],
  workRegistrations: [] as string[],
  schedules: [] as string[],
  queues: [] as string[],
  /** How long `start()` takes, so a test can enqueue during the gap. */
  startDelayMs: 0,
  startShouldFail: false,
  stopped: 0,
}));

vi.mock('pg-boss', () => {
  class FakePgBoss {
    on(): void {}

    async start(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, state.startDelayMs));
      if (state.startShouldFail) throw new Error('cannot reach postgres');
    }

    async createQueue(name: string): Promise<void> {
      state.queues.push(name);
    }

    async work(name: string): Promise<string> {
      state.workRegistrations.push(name);
      return name;
    }

    async schedule(name: string): Promise<void> {
      state.schedules.push(name);
    }

    async send(name: string, data: unknown, options: Record<string, unknown>): Promise<string> {
      state.sent.push({ name, data, options });
      return `job-${state.sent.length}`;
    }

    async stop(): Promise<void> {
      state.stopped += 1;
    }
  }
  return { default: FakePgBoss };
});

beforeEach(() => {
  state.sent = [];
  state.workRegistrations = [];
  state.schedules = [];
  state.queues = [];
  state.startDelayMs = 0;
  state.startShouldFail = false;
  state.stopped = 0;
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Re-imported per test: the module keeps its pg-boss instance in module state. */
async function loadWorker(): Promise<typeof WorkerModule> {
  return import('../../src/worker/index.js');
}

/**
 * Spelled out rather than derived from QUEUE_DEFINITIONS: adding a queue should
 * mean editing this line and thinking about whether it needs a handler and a
 * schedule. Derived, it would pass silently for a queue nobody wired up.
 */
const EXPECTED_QUEUES = [
  'poll:tick',
  'poll:source',
  'score:items',
  'rescore:all',
  'score:refresh',
  'enrich:images',
  'retention:items',
  'retention:raw',
  'vacuum:analyze',
  'deliver:alerts',
];

describe('startWorker', () => {
  it('creates every queue, registers a handler for each and schedules the crons', async () => {
    const worker = await loadWorker();
    await worker.startWorker();

    expect(state.queues).toEqual(EXPECTED_QUEUES);
    // A queue with no handler would accept jobs and never run them. Compared as
    // a set: which order handlers are registered in is arbitrary, and pinning it
    // in two places just means editing both when one moves.
    expect([...state.workRegistrations].sort()).toEqual([...EXPECTED_QUEUES].sort());
    expect(state.schedules).toEqual([
      'poll:tick',
      'score:refresh',
      // Hourly: polls alone are not a reliable trigger, because an instance
      // whose sources all answer 304 inserts nothing and would never backfill.
      'enrich:images',
      // Nightly, ten minutes apart so the raw purge is not fighting the delete
      // for locks; the vacuum runs weekly, after a night of deletes.
      'retention:items',
      'retention:raw',
      'vacuum:analyze',
    ]);

    await worker.stopWorker();
  });

  it('is idempotent — a second call reuses the running instance', async () => {
    const worker = await loadWorker();
    const first = await worker.startWorker();
    const second = await worker.startWorker();

    expect(second).toBe(first);
    expect(state.queues).toHaveLength(EXPECTED_QUEUES.length);

    await worker.stopWorker();
  });

  it('does not start twice when two callers race', async () => {
    state.startDelayMs = 30;
    const worker = await loadWorker();

    const [a, b] = await Promise.all([worker.startWorker(), worker.startWorker()]);

    expect(a).toBe(b);
    expect(state.queues).toHaveLength(EXPECTED_QUEUES.length);

    await worker.stopWorker();
  });
});

describe('enqueuePoll during startup', () => {
  it('waits for the queues instead of dropping the job', async () => {
    state.startDelayMs = 50;
    const worker = await loadWorker();

    // Exactly what index.ts does: start the worker without awaiting it, so the
    // server can begin serving immediately.
    const starting = worker.startWorker();

    // ...and exactly what POST /api/sources does, in the window before it is up.
    const jobId = await worker.enqueuePoll(42, { immediate: true });

    await starting;

    expect(jobId).not.toBeNull();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({
      name: 'poll:source',
      data: { sourceId: 42 },
      options: { startAfter: 0, singletonKey: '42', retryLimit: 0 },
    });

    await worker.stopWorker();
  });

  it('reports "not queued" rather than throwing when no worker runs here', async () => {
    const worker = await loadWorker();

    // WORKER_ENABLED=false in another process: startWorker was never called.
    await expect(worker.enqueuePoll(7)).resolves.toBeNull();
    expect(state.sent).toHaveLength(0);
  });

  it('reports "not queued" when startup failed', async () => {
    state.startShouldFail = true;
    const worker = await loadWorker();

    await expect(worker.startWorker()).rejects.toThrow(/cannot reach postgres/);
    await expect(worker.enqueuePoll(7)).resolves.toBeNull();
  });

  it('allows a retry after a failed startup', async () => {
    state.startShouldFail = true;
    const worker = await loadWorker();
    await expect(worker.startWorker()).rejects.toThrow();

    // A cleared start promise is what makes the second attempt real rather than
    // a replay of the first failure.
    state.startShouldFail = false;
    await expect(worker.startWorker()).resolves.toBeDefined();
    expect(state.queues).toHaveLength(EXPECTED_QUEUES.length);

    await worker.stopWorker();
  });
});

describe('enqueuePoll options', () => {
  it('jitters a scheduled poll and keeps one queued job per source', async () => {
    const worker = await loadWorker();
    await worker.startWorker();

    await worker.enqueuePoll(11);

    const [job] = state.sent;
    const startAfter = job?.options['startAfter'] as number;
    // Jitter spreads sources enqueued on the same minute boundary.
    expect(startAfter).toBeGreaterThanOrEqual(0);
    expect(startAfter).toBeLessThanOrEqual(20);
    expect(job?.options['singletonKey']).toBe('11');
    expect(job?.options['expireInSeconds']).toBe(60);

    await worker.stopWorker();
  });
});

describe('stopWorker', () => {
  it('waits for a startup in flight rather than leaving pg-boss half-started', async () => {
    state.startDelayMs = 40;
    const worker = await loadWorker();

    const starting = worker.startWorker();
    await worker.stopWorker();
    await starting;

    expect(state.stopped).toBe(1);
  });

  it('does nothing when no worker was ever started', async () => {
    const worker = await loadWorker();
    await worker.stopWorker();
    expect(state.stopped).toBe(0);
  });
});
