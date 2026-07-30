/**
 * The matcher host: owns the worker thread and enforces the per-item time budget.
 *
 * A regex already backtracking cannot be interrupted from inside the thread it is
 * running on, which is the entire reason the work happens elsewhere. The host
 * watches shared memory for the item index to stop advancing, and when it does it
 * kills the thread, names the rule that was executing, drops it, and resumes the
 * batch from where it stopped. One pathological rule must not cost the other
 * forty-nine thousand items.
 */

import { Worker } from 'node:worker_threads';
import { logger } from '../logger.js';
import {
  PROGRESS_LAYOUT,
  PROGRESS_SLOTS,
  type MatchableItem,
  type RuleSpec,
  type WorkerRequest,
  type WorkerResponse,
} from './types.js';

/** Per-item budget from the spec. */
export const ITEM_BUDGET_MS = 50;

/** How often the host checks whether the worker is still moving. */
const WATCHDOG_INTERVAL_MS = 10;

/** A batch must finish within this, independent of the per-item budget. */
const BATCH_CEILING_MS = 60_000;

const log = logger.child({ component: 'rule-matcher' });

export interface TimedOutRule {
  ruleId: number;
  itemIndex: number;
}

export interface MatchOutcome {
  /** One entry per input item, in order. */
  matchedRuleIds: number[][];
  /** Rules dropped mid-run for exceeding the budget. The caller deactivates these. */
  timedOut: TimedOutRule[];
}

function workerUrl(): URL {
  // `import.meta.url` ends in .ts under tsx and .js after a build; the worker is a
  // sibling either way, so deriving the extension keeps both working without a
  // build step that copies files around.
  const self = import.meta.url;
  return new URL(self.replace(/matcher\.(ts|js)$/, (_match, ext: string) => `match-worker.${ext}`));
}

export class RuleMatcher {
  #worker: Worker | null = null;
  #progress: Int32Array;
  #buffer: SharedArrayBuffer;
  #rules: RuleSpec[] = [];

  constructor() {
    this.#buffer = new SharedArrayBuffer(PROGRESS_SLOTS * Int32Array.BYTES_PER_ELEMENT);
    this.#progress = new Int32Array(this.#buffer);
  }

  async setRules(rules: readonly RuleSpec[]): Promise<void> {
    this.#rules = [...rules];
    if (this.#worker !== null) await this.#restart();
  }

  /**
   * Match every item, dropping any rule that exceeds its budget.
   *
   * Never throws for a bad pattern: a hung rule is reported in `timedOut` so the
   * caller can deactivate it and tell the user, which is more useful than failing
   * the job.
   */
  async match(items: readonly MatchableItem[]): Promise<MatchOutcome> {
    if (items.length === 0) return { matchedRuleIds: [], timedOut: [] };
    if (this.#rules.length === 0) {
      return { matchedRuleIds: items.map(() => []), timedOut: [] };
    }

    const results: number[][] = [];
    const timedOut: TimedOutRule[] = [];
    let cursor = 0;

    // Each pass runs the remaining items; a timeout ends the pass early, drops the
    // offending rule and the next pass picks up where it stopped.
    while (cursor < items.length) {
      if (this.#rules.length === 0) {
        // Every rule has been dropped. The rest of the batch matches nothing.
        while (results.length < items.length) results.push([]);
        break;
      }

      const outcome = await this.#runPass(items.slice(cursor), cursor);

      results.push(...outcome.matchedRuleIds);
      cursor += outcome.matchedRuleIds.length;

      if (outcome.timeout === null) break;

      timedOut.push(outcome.timeout);
      this.#rules = this.#rules.filter((rule) => rule.id !== outcome.timeout?.ruleId);

      log.error(
        { ruleId: outcome.timeout.ruleId, itemIndex: outcome.timeout.itemIndex },
        'Rule exceeded its time budget and was dropped from this run',
      );

      // The item that hung is skipped: whatever it matched is unknowable, and
      // re-running it risks the same hang on another rule.
      if (cursor < items.length) {
        results.push([]);
        cursor += 1;
      }
    }

    return { matchedRuleIds: results.slice(0, items.length), timedOut };
  }

  async #runPass(
    items: readonly MatchableItem[],
    startIndex: number,
  ): Promise<{ matchedRuleIds: number[][]; timeout: TimedOutRule | null }> {
    const worker = await this.#ensureWorker();

    this.#progress[PROGRESS_LAYOUT.itemIndex] = startIndex;
    this.#progress[PROGRESS_LAYOUT.ruleId] = 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      let lastIndex = startIndex;
      let lastMovedAt = Date.now();
      const startedAt = Date.now();

      const finish = (
        value: { matchedRuleIds: number[][]; timeout: TimedOutRule | null } | null,
        err?: unknown,
      ): void => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        worker.off('message', onMessage);
        worker.off('error', onError);
        if (value !== null) resolve(value);
        else reject(err instanceof Error ? err : new Error(String(err)));
      };

      const watchdog = setInterval(() => {
        const current = this.#progress[PROGRESS_LAYOUT.itemIndex] ?? startIndex;

        if (current !== lastIndex) {
          lastIndex = current;
          lastMovedAt = Date.now();
          return;
        }

        const stuckFor = Date.now() - lastMovedAt;
        const overBudget = stuckFor > ITEM_BUDGET_MS;
        const overCeiling = Date.now() - startedAt > BATCH_CEILING_MS;
        if (!overBudget && !overCeiling) return;

        // Read the rule *before* terminating: the thread stops writing after that.
        const ruleId = this.#progress[PROGRESS_LAYOUT.ruleId] ?? 0;
        if (ruleId === 0 && !overCeiling) {
          // Between items rather than inside a rule; not a hang.
          lastMovedAt = Date.now();
          return;
        }

        void this.#kill();

        finish({
          // Everything before the stuck item is lost with the thread; the caller
          // resumes from `itemIndex`, so report nothing for this pass.
          matchedRuleIds: [],
          timeout: { ruleId, itemIndex: current },
        });
      }, WATCHDOG_INTERVAL_MS);

      const onMessage = (message: WorkerResponse): void => {
        if (message.type === 'result') {
          finish({ matchedRuleIds: message.matchedRuleIds, timeout: null });
          return;
        }
        if (message.type === 'error') {
          finish(null, new Error(`Rule matching failed: ${message.message}`));
        }
      };

      const onError = (err: Error): void => {
        finish(null, err);
      };

      worker.on('message', onMessage);
      worker.on('error', onError);

      worker.postMessage({
        type: 'batch',
        items: [...items],
        startIndex,
      } satisfies WorkerRequest);
    });
  }

  async #ensureWorker(): Promise<Worker> {
    if (this.#worker !== null) return this.#worker;

    const worker = new Worker(workerUrl(), {
      workerData: { progress: this.#buffer, slots: PROGRESS_LAYOUT },
      // Keeps a hung thread from holding the process open at shutdown.
      stdout: true,
      stderr: true,
    });

    worker.unref();
    this.#worker = worker;

    await new Promise<void>((resolve, reject) => {
      const onMessage = (message: WorkerResponse): void => {
        if (message.type === 'ready') {
          worker.off('message', onMessage);
          worker.off('error', onError);
          resolve();
        }
      };
      const onError = (err: Error): void => {
        worker.off('message', onMessage);
        reject(err);
      };
      worker.on('message', onMessage);
      worker.once('error', onError);

      worker.postMessage({ type: 'rules', rules: this.#rules } satisfies WorkerRequest);
    });

    return worker;
  }

  async #kill(): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    if (worker !== null) await worker.terminate();
  }

  async #restart(): Promise<void> {
    await this.#kill();
  }

  async stop(): Promise<void> {
    await this.#kill();
  }
}
