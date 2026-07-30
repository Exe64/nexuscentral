/**
 * The regex matching worker.
 *
 * Runs on its own thread so a catastrophically backtracking pattern hangs this
 * thread and not the poller (02-SPEC-ingestion.md 5.3). It writes its position
 * into shared memory before every `test()` so the host can name the offending rule
 * after killing the thread -- a postMessage per rule would flood the channel.
 *
 * Every project import here is type-only, and so erased at compile time. That is
 * deliberate: a worker thread does not inherit the parent's module loader, so a
 * runtime import of a sibling `.ts` module would fail to resolve. The shared-memory
 * layout arrives through `workerData` for the same reason -- importing the
 * constants would reintroduce exactly that dependency.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type {
  MatchableItem,
  RuleScopeName,
  RuleSpec,
  WorkerRequest,
  WorkerResponse,
} from './types.js';

if (parentPort === null) {
  throw new Error('match-worker must be started as a worker thread');
}

const port = parentPort;

const data = workerData as {
  progress: SharedArrayBuffer;
  slots: { itemIndex: number; ruleId: number };
};

const progress = new Int32Array(data.progress);
const ITEM_INDEX = data.slots.itemIndex;
const RULE_ID = data.slots.ruleId;

interface Compiled {
  spec: RuleSpec;
  regex: RegExp;
}

/** Compiled once per rule set, not once per item. */
let compiled: Compiled[] = [];

function subject(item: MatchableItem, scope: RuleScopeName): string {
  if (scope === 'title') return item.title;
  if (scope === 'summary') return item.summary ?? '';
  if (scope === 'author') return item.author ?? '';
  return `${item.title}\n${item.summary ?? ''}`;
}

function appliesTo(spec: RuleSpec, item: MatchableItem): boolean {
  if (spec.tagFilter.length === 0) return true;
  return spec.tagFilter.some((tagId) => item.tagIds.includes(tagId));
}

port.on('message', (message: WorkerRequest) => {
  try {
    if (message.type === 'rules') {
      compiled = message.rules.map((spec) => ({
        spec,
        regex: new RegExp(spec.pattern, spec.flags),
      }));
      port.postMessage({ type: 'ready' } satisfies WorkerResponse);
      return;
    }

    const matchedRuleIds: number[][] = [];

    for (let index = 0; index < message.items.length; index += 1) {
      const item = message.items[index] as MatchableItem;

      // Absolute index, so the host can resume the batch after killing this thread.
      progress[ITEM_INDEX] = message.startIndex + index;

      const matched: number[] = [];
      for (const { spec, regex } of compiled) {
        if (!appliesTo(spec, item)) continue;

        progress[RULE_ID] = spec.id;

        // `lastIndex` is never carried: the g and y flags are rejected upstream,
        // so `test` is stateless here.
        if (regex.test(subject(item, spec.scope))) matched.push(spec.id);
      }

      // Zero means "between items": the host uses it to tell a genuine hang from
      // an ordinary pause between messages.
      progress[RULE_ID] = 0;
      matchedRuleIds.push(matched);
    }

    port.postMessage({ type: 'result', matchedRuleIds } satisfies WorkerResponse);
  } catch (err) {
    port.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
});
