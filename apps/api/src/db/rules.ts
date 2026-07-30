/**
 * Rule persistence.
 *
 * A rule's `weight` may be negative -- that is how noise is demoted, not a bug.
 */

import type { Rule, RuleScope } from '@feedhub/shared';
import { query } from './pool.js';
import type { RuleSpec } from '../scoring/types.js';

interface RuleRow {
  id: number;
  name: string;
  pattern: string;
  flags: string;
  scope: RuleScope;
  weight: number;
  alert: boolean;
  active: boolean;
  tag_filter: number[];
  last_error: string | null;
  last_error_at: Date | null;
  created_at: Date;
}

const COLUMNS = `
  id, name, pattern, flags, scope, weight, alert, active, tag_filter,
  last_error, last_error_at, created_at
`;

function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    name: row.name,
    pattern: row.pattern,
    flags: row.flags,
    scope: row.scope,
    weight: row.weight,
    alert: row.alert,
    active: row.active,
    tagFilter: row.tag_filter,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listRules(): Promise<Rule[]> {
  const { rows } = await query<RuleRow>(
    // Heaviest first: a rule list is read to understand why things rank where they
    // do, and the biggest weights are the answer most of the time.
    `SELECT ${COLUMNS} FROM rules ORDER BY abs(weight) DESC, name ASC`,
  );
  return rows.map(toRule);
}

export async function getRule(id: number): Promise<Rule | null> {
  const { rows } = await query<RuleRow>(`SELECT ${COLUMNS} FROM rules WHERE id = $1`, [id]);
  return rows[0] === undefined ? null : toRule(rows[0]);
}

export interface CreateRuleInput {
  name: string;
  pattern: string;
  flags: string;
  scope: RuleScope;
  weight: number;
  alert: boolean;
  active: boolean;
  tagFilter: readonly number[];
}

export async function createRule(input: CreateRuleInput): Promise<Rule> {
  const { rows } = await query<RuleRow>(
    `INSERT INTO rules (name, pattern, flags, scope, weight, alert, active, tag_filter)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::int[])
     RETURNING ${COLUMNS}`,
    [
      input.name,
      input.pattern,
      input.flags,
      input.scope,
      input.weight,
      input.alert,
      input.active,
      [...new Set(input.tagFilter)],
    ],
  );
  return toRule(rows[0] as RuleRow);
}

export type UpdateRuleInput = Partial<CreateRuleInput>;

export async function updateRule(id: number, patch: UpdateRuleInput): Promise<Rule | null> {
  const sets: string[] = [];
  const params: (string | number | boolean | number[])[] = [];

  const set = (column: string, value: string | number | boolean | number[], cast = ''): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  if (patch.name !== undefined) set('name', patch.name);
  if (patch.pattern !== undefined) set('pattern', patch.pattern);
  if (patch.flags !== undefined) set('flags', patch.flags);
  if (patch.scope !== undefined) set('scope', patch.scope);
  if (patch.weight !== undefined) set('weight', patch.weight);
  if (patch.alert !== undefined) set('alert', patch.alert);
  if (patch.tagFilter !== undefined) set('tag_filter', [...new Set(patch.tagFilter)], '::int[]');

  if (patch.active !== undefined) {
    set('active', patch.active);
    // Re-enabling a rule that the time budget disabled clears the explanation:
    // leaving it would report a failure that is no longer true.
    if (patch.active) sets.push('last_error = NULL', 'last_error_at = NULL');
  }

  // Editing the pattern is the user asserting the old failure no longer applies.
  if (patch.pattern !== undefined && patch.active === undefined) {
    sets.push('last_error = NULL', 'last_error_at = NULL');
  }

  if (sets.length === 0) return getRule(id);

  params.push(id);
  const { rows } = await query<RuleRow>(
    `UPDATE rules SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] === undefined ? null : toRule(rows[0]);
}

export async function deleteRule(id: number): Promise<boolean> {
  // Alerts cascade. `items.matched_rules` is left stale on purpose; the rescoring
  // job reconciles it (01-SPEC-data-model.md 2).
  const result = await query(`DELETE FROM rules WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

/** The active rules, in the shape the matcher wants. */
export async function activeRuleSpecs(): Promise<RuleSpec[]> {
  const { rows } = await query<RuleRow>(
    `SELECT ${COLUMNS} FROM rules WHERE active = true ORDER BY id`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    pattern: row.pattern,
    flags: row.flags,
    scope: row.scope,
    tagFilter: row.tag_filter,
    weight: row.weight,
  }));
}

/**
 * Deactivate a rule that exceeded its time budget, recording why.
 *
 * The user has to be able to see this: a rule that silently stopped applying is
 * worse than one that is visibly broken.
 */
export async function deactivateRuleForTimeout(id: number, message: string): Promise<void> {
  await query(
    `UPDATE rules
        SET active = false, last_error = $2, last_error_at = now()
      WHERE id = $1`,
    [id, message.slice(0, 2000)],
  );
}

export interface RuleWeight {
  id: number;
  name: string;
  weight: number;
}

/** Weights and names by id, for building a score breakdown. */
export async function ruleWeightsById(): Promise<Map<number, RuleWeight>> {
  const { rows } = await query<{ id: number; name: string; weight: number }>(
    `SELECT id, name, weight FROM rules`,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

export async function countRules(): Promise<{ total: number; active: number; alerting: number }> {
  const { rows } = await query<{ total: number; active: number; alerting: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE active)::int AS active,
            count(*) FILTER (WHERE active AND alert)::int AS alerting
       FROM rules`,
  );
  return rows[0] ?? { total: 0, active: 0, alerting: 0 };
}
