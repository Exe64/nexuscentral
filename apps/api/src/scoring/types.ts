/**
 * Types shared between the matcher host and its worker thread.
 *
 * Kept in a module with no runtime dependencies: the worker must not import
 * anything that reaches the environment, the logger or the database pool.
 */

import type { RuleScope } from '@feedhub/shared';

/** Re-exported so the worker can name the type without importing @feedhub/shared. */
export type RuleScopeName = RuleScope;

export interface RuleSpec {
  id: number;
  pattern: string;
  flags: string;
  scope: RuleScope;
  /** When non-empty, the rule only applies to items whose source carries one of these tags. */
  tagFilter: number[];
  weight: number;
  name: string;
}

export interface MatchableItem {
  title: string;
  summary: string | null;
  author: string | null;
  /** Tags of the item's source, for `tagFilter`. */
  tagIds: number[];
}

export type WorkerRequest =
  | { type: 'rules'; rules: RuleSpec[] }
  | { type: 'batch'; items: MatchableItem[]; startIndex: number };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; matchedRuleIds: number[][] }
  | { type: 'error'; message: string };

/**
 * Progress slots in the SharedArrayBuffer.
 *
 * The worker writes these before each `test()`. When the host sees the item index
 * stop advancing it can identify the offending rule *after* terminating the
 * thread, which a postMessage-per-rule protocol could not do without flooding
 * the channel.
 *
 * Passed to the worker through `workerData` rather than imported: a worker thread
 * does not inherit the parent's module loader, so it must not import anything of
 * ours at runtime.
 */
export const PROGRESS_LAYOUT = { itemIndex: 0, ruleId: 1 } as const;
export const PROGRESS_SLOTS = 2;
