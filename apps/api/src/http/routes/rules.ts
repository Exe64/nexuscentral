/**
 * Rule routes (03-SPEC-api.md 5).
 *
 * `POST /api/rules/test` is non-negotiable: without it, rules are written blind.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  RULE_SCOPES,
  type RuleScope,
  type RuleTestMatch,
  type RuleTestResult,
} from '@nexuscentral/shared';
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  updateRule,
  type CreateRuleInput,
} from '../../db/rules.js';
import { assertTagsExist } from '../../db/tags.js';
import { query } from '../../db/pool.js';
import { checkPattern, MAX_PATTERN_LENGTH } from '../../scoring/redos.js';
import { ITEM_BUDGET_MS } from '../../scoring/matcher.js';
import { enqueueRescore } from '../../worker/index.js';
import { HttpError } from '../errors.js';
import { intParam, parseBody, shortText } from '../validation.js';

export const rulesRouter: Router = Router();

/** The dry run samples the most recent items, per the spec. */
const TEST_SAMPLE_SIZE = 300;
/** Enough to see the shape of the matches without shipping the whole sample. */
const TEST_MATCH_LIMIT = 25;

const patternField = z
  .string()
  .min(1)
  .max(MAX_PATTERN_LENGTH + 50);
const flagsField = z
  .string()
  .max(8)
  .regex(/^[a-z]*$/, 'Flags must be lowercase letters')
  .default('i');

const createSchema = z.object({
  name: shortText(120),
  pattern: patternField,
  flags: flagsField,
  scope: z.enum(RULE_SCOPES).default('both'),
  // Negative is legitimate: that is how noise is demoted.
  weight: z.number().min(-99.99).max(99.99).default(1),
  alert: z.boolean().default(false),
  active: z.boolean().default(true),
  tagFilter: z.array(z.number().int().positive()).max(50).default([]),
});

const patchSchema = z
  .object({
    name: shortText(120).optional(),
    pattern: patternField.optional(),
    flags: flagsField.optional(),
    scope: z.enum(RULE_SCOPES).optional(),
    weight: z.number().min(-99.99).max(99.99).optional(),
    alert: z.boolean().optional(),
    active: z.boolean().optional(),
    tagFilter: z.array(z.number().int().positive()).max(50).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field' });

const testSchema = z.object({
  pattern: patternField,
  flags: flagsField,
  scope: z.enum(RULE_SCOPES).default('both'),
  tagFilter: z.array(z.number().int().positive()).max(50).default([]),
});

/**
 * Reject an unsafe pattern at the boundary, with a message that says what to do
 * about it. A rejection here is cheap; a rule that hangs the worker is not.
 */
function assertPatternSafe(pattern: string, flags: string): void {
  const check = checkPattern(pattern, flags);
  if (check.ok) return;

  throw HttpError.validation(check.problem.message, {
    pattern: [check.problem.message],
    code: check.problem.code,
    ...(check.problem.index === undefined ? {} : { index: check.problem.index }),
  });
}

rulesRouter.get('/rules', async (_req, res) => {
  res.json({ data: await listRules() });
});

/** Registered before `/rules/:id` so the literal path wins. */
rulesRouter.post('/rules/test', async (req, res) => {
  const body = parseBody(testSchema, req);

  const check = checkPattern(body.pattern, body.flags);
  if (!check.ok) {
    // A dry run reports an unsafe pattern as data, not as an error: the user is
    // mid-edit and the panel has to keep working.
    res.json({ valid: false, error: check.problem.message } satisfies RuleTestResult);
    return;
  }

  const regex = new RegExp(body.pattern, body.flags);

  interface SampleRow {
    id: string;
    title: string;
    summary: string | null;
    author: string | null;
    source_title: string;
    tag_ids: number[];
  }

  const { rows } = await query<SampleRow>(
    `SELECT i.id, i.title, i.summary, i.author, s.title AS source_title,
            coalesce(
              (SELECT array_agg(st.tag_id) FROM source_tags st WHERE st.source_id = i.source_id),
              '{}'
            ) AS tag_ids
       FROM items i JOIN sources s ON s.id = i.source_id
      ORDER BY i.published_at DESC, i.id DESC
      LIMIT $1`,
    [TEST_SAMPLE_SIZE],
  );

  const matches: RuleTestMatch[] = [];
  let matchCount = 0;
  const deadline = Date.now() + ITEM_BUDGET_MS * 20;

  for (const row of rows) {
    if (body.tagFilter.length > 0 && !body.tagFilter.some((id) => row.tag_ids.includes(id))) {
      continue;
    }

    // The static guards already rejected the shapes that blow up, but a dry run
    // still runs on the request thread, so it gets a wall-clock ceiling too.
    if (Date.now() > deadline) {
      res.json({
        valid: false,
        error: `That pattern is too slow to test against ${TEST_SAMPLE_SIZE} items. Simplify it before saving.`,
      } satisfies RuleTestResult);
      return;
    }

    const found = firstMatch(regex, row, body.scope);
    if (found === null) continue;

    matchCount += 1;
    if (matches.length < TEST_MATCH_LIMIT) {
      matches.push({
        itemId: row.id,
        title: row.title,
        sourceTitle: row.source_title,
        highlight: found,
      });
    }
  }

  res.json({
    valid: true,
    matchCount,
    sampleSize: rows.length,
    matches,
  } satisfies RuleTestResult);
});

/**
 * Find the first match and where it is, so the panel can highlight it.
 *
 * For scope `both` the fields are searched separately rather than concatenated:
 * an offset into "title\nsummary" would be meaningless to a UI rendering two
 * elements.
 */
function firstMatch(
  regex: RegExp,
  row: { title: string; summary: string | null; author: string | null },
  scope: RuleScope,
): RuleTestMatch['highlight'] | null {
  const fields: { field: RuleTestMatch['highlight']['field']; value: string }[] =
    scope === 'title'
      ? [{ field: 'title', value: row.title }]
      : scope === 'summary'
        ? [{ field: 'summary', value: row.summary ?? '' }]
        : scope === 'author'
          ? [{ field: 'author', value: row.author ?? '' }]
          : [
              { field: 'title', value: row.title },
              { field: 'summary', value: row.summary ?? '' },
            ];

  for (const { field, value } of fields) {
    // A fresh exec on a non-global regex always starts at 0, so there is no
    // lastIndex to reset between fields.
    const match = regex.exec(value);
    if (match !== null) {
      return { field, start: match.index, end: match.index + match[0].length };
    }
  }

  return null;
}

rulesRouter.post('/rules', async (req, res) => {
  const body = parseBody(createSchema, req);
  assertPatternSafe(body.pattern, body.flags);
  await assertTagsExist(body.tagFilter);

  const rule = await createRule(body satisfies CreateRuleInput);

  // Debounced: several quick edits collapse into one job.
  await enqueueRescore('rule created');

  res.status(201).json({ data: rule });
});

rulesRouter.get('/rules/:id', async (req, res) => {
  const rule = await getRule(intParam(req, 'id'));
  if (rule === null) throw HttpError.notFound('Rule');
  res.json({ data: rule });
});

rulesRouter.patch('/rules/:id', async (req, res) => {
  const id = intParam(req, 'id');
  const body = parseBody(patchSchema, req);

  if (body.pattern !== undefined || body.flags !== undefined) {
    const existing = await getRule(id);
    if (existing === null) throw HttpError.notFound('Rule');
    assertPatternSafe(body.pattern ?? existing.pattern, body.flags ?? existing.flags);
  }
  if (body.tagFilter !== undefined) await assertTagsExist(body.tagFilter);

  const rule = await updateRule(id, body);
  if (rule === null) throw HttpError.notFound('Rule');

  await enqueueRescore('rule updated');

  res.json({ data: rule });
});

rulesRouter.delete('/rules/:id', async (req, res) => {
  const deleted = await deleteRule(intParam(req, 'id'));
  if (!deleted) throw HttpError.notFound('Rule');

  // `items.matched_rules` is left stale by the delete; the rescore reconciles it.
  await enqueueRescore('rule deleted');

  res.status(204).end();
});
