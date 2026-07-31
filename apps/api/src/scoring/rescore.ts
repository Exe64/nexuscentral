/**
 * Rescoring jobs (02-SPEC-ingestion.md 5.2, 01-SPEC-data-model.md 3).
 *
 * Two different jobs, because they cost very different amounts:
 *
 * - **`rescore:all`** re-evaluates every pattern against the last 30 days. Runs on
 *   rule create/update/delete, debounced.
 * - **`score:refresh`** recomputes the arithmetic for the last 7 days, reusing the
 *   `matched_rules` already stored. Scores drift because the decay term depends on
 *   time, not because matches change, so re-running regexes hourly would be waste.
 *   Beyond 7 days the decay floor makes further recomputation pointless.
 *
 * Neither job ever creates an alert. Turning on alerting for a rule must not fire
 * hundreds of notifications about things already read (02-SPEC-ingestion.md 6).
 */

import type { SourceKind } from '@nexuscentral/shared';
import { query, transaction } from '../db/pool.js';
import { activeRuleSpecs, deactivateRuleForTimeout, ruleWeightsById } from '../db/rules.js';
import { logger } from '../logger.js';
import { computeScore, type MatchedRule } from './engine.js';
import { ITEM_BUDGET_MS, RuleMatcher } from './matcher.js';
import type { MatchableItem, RuleSpec } from './types.js';

/** One transaction per batch, per the data-model spec. */
export const BATCH_SIZE = 500;

export const RESCORE_WINDOW_DAYS = 30;
export const REFRESH_WINDOW_DAYS = 7;

const log = logger.child({ component: 'scoring' });

interface ScorableRow {
  id: string;
  title: string;
  summary: string | null;
  author: string | null;
  published_at: Date;
  engagement_score: number | null;
  matched_rules: number[];
  source_kind: SourceKind;
  source_weight: number;
  tag_ids: number[];
}

const SCORABLE_COLUMNS = `
  i.id, i.title, i.summary, i.author, i.published_at, i.engagement_score, i.matched_rules,
  s.kind AS source_kind, s.weight AS source_weight,
  coalesce(
    (SELECT array_agg(st.tag_id) FROM source_tags st WHERE st.source_id = i.source_id),
    '{}'
  ) AS tag_ids
`;

export interface ScoringRunResult {
  scanned: number;
  updated: number;
  durationMs: number;
  /** Rules deactivated mid-run for exceeding the per-item budget. */
  deactivatedRuleIds: number[];
}

/**
 * Write a batch of scores in one statement.
 *
 * `matched_rules` travels as text so a single `unnest` can carry it: PostgreSQL
 * cannot unnest a multidimensional array into per-row arrays.
 */
async function writeBatch(
  rows: { id: string; score: number; matched: number[] }[],
): Promise<number> {
  if (rows.length === 0) return 0;

  return transaction(async (client) => {
    const result = await client.query(
      `UPDATE items AS i
          SET score = b.score,
              matched_rules = b.matched::int[],
              scored_at = now()
         FROM unnest($1::bigint[], $2::numeric[], $3::text[]) AS b(id, score, matched)
        WHERE i.id = b.id`,
      [
        rows.map((row) => row.id),
        rows.map((row) => row.score),
        rows.map((row) => `{${row.matched.join(',')}}`),
      ],
    );
    return result.rowCount ?? 0;
  });
}

function toMatchable(row: ScorableRow): MatchableItem {
  return { title: row.title, summary: row.summary, author: row.author, tagIds: row.tag_ids };
}

/**
 * Re-evaluate every active pattern against recent items.
 *
 * Keyset pagination rather than OFFSET: the scan has to stay linear at 50k rows,
 * and a concurrent insert must not shift the window.
 *
 * The cursor is the item id alone, deliberately. An earlier version paged on
 * `(published_at, id)` and silently skipped rows: PostgreSQL stores `timestamptz`
 * to the microsecond, `pg` hands it back as a JavaScript Date truncated to the
 * millisecond, and sending that back as the cursor bound excluded every row whose
 * true timestamp fell in the truncated remainder. Two items sharing a timestamp
 * was enough to lose one. Ids are exact and unique, and a full-window scan does
 * not care what order it visits rows in.
 */
export async function rescoreRecent(
  options: { windowDays?: number; itemIds?: readonly string[] } = {},
): Promise<ScoringRunResult> {
  const startedAt = Date.now();
  const windowDays = options.windowDays ?? RESCORE_WINDOW_DAYS;

  const matcher = new RuleMatcher();
  let specs: RuleSpec[] = await activeRuleSpecs();
  await matcher.setRules(specs);

  const weights = new Map(specs.map((spec) => [spec.id, spec]));
  const deactivatedRuleIds: number[] = [];
  const now = new Date();

  let scanned = 0;
  let updated = 0;
  let cursor: string | null = null;
  // Pinned once: `now()` evaluated per batch would slide the window mid-scan.
  const windowStart = windowStartFor(windowDays, now);

  try {
    for (;;) {
      const rows = await fetchBatch({ windowStart, cursor, itemIds: options.itemIds });
      if (rows.length === 0) break;

      const outcome = await matcher.match(rows.map(toMatchable));

      // A rule that blew its budget is deactivated and dropped from this run. The
      // job continues: one bad pattern must not cost the other 49,999 items.
      for (const timeout of outcome.timedOut) {
        const spec = weights.get(timeout.ruleId);
        await deactivateRuleForTimeout(
          timeout.ruleId,
          `Pattern exceeded the ${ITEM_BUDGET_MS}ms matching budget on a single item and was disabled. ` +
            'Simplify it -- nested repetition such as "(\\w+)+" is the usual cause.',
        );
        deactivatedRuleIds.push(timeout.ruleId);
        specs = specs.filter((candidate) => candidate.id !== timeout.ruleId);
        weights.delete(timeout.ruleId);
        log.error({ ruleId: timeout.ruleId, ruleName: spec?.name }, 'Rule disabled by the matcher');
      }

      const writes = rows.map((row, index) => {
        const matched = outcome.matchedRuleIds[index] ?? [];
        const matchedRules: MatchedRule[] = matched
          .map((id) => weights.get(id))
          .filter((spec): spec is RuleSpec => spec !== undefined)
          .map((spec) => ({ id: spec.id, name: spec.name, weight: spec.weight }));

        const { score } = computeScore({
          matchedRules,
          engagementScore: row.engagement_score,
          sourceKind: row.source_kind,
          sourceWeight: row.source_weight,
          publishedAt: row.published_at,
          now,
        });

        return { id: row.id, score, matched: matchedRules.map((rule) => rule.id) };
      });

      updated += await writeBatch(writes);
      scanned += rows.length;

      cursor = (rows[rows.length - 1] as ScorableRow).id;

      // An explicit id list is a single batch by construction.
      if (options.itemIds !== undefined) break;
      if (rows.length < BATCH_SIZE) break;
    }
  } finally {
    await matcher.stop();
  }

  const result: ScoringRunResult = {
    scanned,
    updated,
    durationMs: Date.now() - startedAt,
    deactivatedRuleIds,
  };
  log.info({ ...result, windowDays }, 'Rescore complete');
  return result;
}

/** The window boundary, computed once per run so it cannot slide between batches. */
function windowStartFor(windowDays: number, now: Date): Date {
  return new Date(now.getTime() - windowDays * 86_400_000);
}

async function fetchBatch(options: {
  windowStart: Date;
  cursor: string | null;
  itemIds?: readonly string[] | undefined;
}): Promise<ScorableRow[]> {
  if (options.itemIds !== undefined) {
    if (options.itemIds.length === 0) return [];
    const { rows } = await query<ScorableRow>(
      `SELECT ${SCORABLE_COLUMNS}
         FROM items i JOIN sources s ON s.id = i.source_id
        WHERE i.id = ANY($1::bigint[])`,
      [[...options.itemIds]],
    );
    return rows;
  }

  const params: (string | number | Date)[] = [options.windowStart];
  let keyset = '';
  if (options.cursor !== null) {
    params.push(options.cursor);
    // Ids only: exact, unique, and immune to the timestamp truncation that a
    // (published_at, id) cursor suffers from.
    keyset = `AND i.id < $${params.length}::bigint`;
  }
  params.push(BATCH_SIZE);

  const { rows } = await query<ScorableRow>(
    `SELECT ${SCORABLE_COLUMNS}
       FROM items i JOIN sources s ON s.id = i.source_id
      WHERE i.published_at > $1::timestamptz
      ${keyset}
      ORDER BY i.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Recompute scores from the matches already stored -- no regex execution.
 *
 * Also drops rule ids that no longer exist. A deleted rule leaves stale ids in
 * `items.matched_rules`, and reconciling them here is free.
 */
export async function refreshScores(
  options: { windowDays?: number } = {},
): Promise<ScoringRunResult> {
  const startedAt = Date.now();
  const windowDays = options.windowDays ?? REFRESH_WINDOW_DAYS;

  const weights = await ruleWeightsById();
  const now = new Date();

  let scanned = 0;
  let updated = 0;
  let cursor: string | null = null;
  const windowStart = windowStartFor(windowDays, now);

  for (;;) {
    const rows = await fetchBatch({ windowStart, cursor });
    if (rows.length === 0) break;

    const writes = rows.map((row) => {
      const matchedRules: MatchedRule[] = row.matched_rules
        .map((id) => weights.get(id))
        .filter((rule): rule is NonNullable<typeof rule> => rule !== undefined);

      const { score } = computeScore({
        matchedRules,
        engagementScore: row.engagement_score,
        sourceKind: row.source_kind,
        sourceWeight: row.source_weight,
        publishedAt: row.published_at,
        now,
      });

      return { id: row.id, score, matched: matchedRules.map((rule) => rule.id) };
    });

    updated += await writeBatch(writes);
    scanned += rows.length;

    cursor = (rows[rows.length - 1] as ScorableRow).id;
    if (rows.length < BATCH_SIZE) break;
  }

  const result: ScoringRunResult = {
    scanned,
    updated,
    durationMs: Date.now() - startedAt,
    deactivatedRuleIds: [],
  };
  log.info({ ...result, windowDays }, 'Score refresh complete');
  return result;
}

/** Score a specific set of newly-inserted items. Runs right after ingestion. */
export async function scoreItems(itemIds: readonly string[]): Promise<ScoringRunResult> {
  return rescoreRecent({ itemIds });
}
