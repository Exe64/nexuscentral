/**
 * Item routes (03-SPEC-api.md 4).
 *
 * Every item carries its source and that source's tags, so a row renders without
 * a second round trip.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ITEM_SORTS, type ItemDetail } from '@nexuscentral/shared';
import { ruleWeightsById } from '../../db/rules.js';
import { getSource } from '../../db/sources.js';
import { computeScore } from '../../scoring/engine.js';
import {
  getItem,
  listItems,
  markAllRead,
  setItemRead,
  setItemStarred,
  type ItemFilters,
} from '../../db/items.js';
import { decodeCursor } from '../pagination.js';
import { HttpError } from '../errors.js';
import {
  bigintParam,
  intList,
  parseBody,
  parseQuery,
  queryBoolean,
  queryDate,
  queryNumber,
} from '../validation.js';

export const itemsRouter: Router = Router();

const filterQuerySchema = z.object({
  tagIds: intList,
  sourceIds: intList,
  unreadOnly: queryBoolean,
  starredOnly: queryBoolean,
  minScore: queryNumber,
  since: queryDate,
  q: z.string().max(200).optional(),
});

const listQuerySchema = filterQuerySchema.extend({
  sort: z.enum(ITEM_SORTS).default('published'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
});

/** `read-all` takes the same filters as the list, in a body rather than a query. */
const readAllSchema = z.object({
  tagIds: z.array(z.number().int().positive()).optional(),
  sourceIds: z.array(z.number().int().positive()).optional(),
  unreadOnly: z.boolean().optional(),
  starredOnly: z.boolean().optional(),
  minScore: z.number().optional(),
  since: z.coerce.date().optional(),
  q: z.string().max(200).optional(),
});

function toFilters(query: z.infer<typeof filterQuerySchema>): ItemFilters {
  return {
    tagIds: query.tagIds,
    sourceIds: query.sourceIds,
    unreadOnly: query.unreadOnly,
    starredOnly: query.starredOnly,
    minScore: query.minScore,
    since: query.since,
    q: query.q,
  };
}

itemsRouter.get('/items', async (req, res) => {
  const query = parseQuery(listQuerySchema, req);

  const page = await listItems({
    ...toFilters(query),
    sort: query.sort,
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: decodeCursor(query.cursor) }),
  });

  res.json(page);
});

itemsRouter.post('/items/read-all', async (req, res) => {
  const body = parseBody(readAllSchema, req);
  const updated = await markAllRead(body);
  res.json({ data: { updated } });
});

/**
 * `GET /api/items/:id` answers "why is this item scored 8.4?".
 *
 * The breakdown is recomputed from the stored inputs rather than persisted: it is
 * derived data, and a stored copy would go stale the moment a rule's weight
 * changed or an hour passed (02-SPEC-ingestion.md 5.4).
 */
itemsRouter.get('/items/:id', async (req, res) => {
  const item = await getItem(bigintParam(req, 'id'));
  if (item === null) throw HttpError.notFound('Item');

  const weights = await ruleWeightsById();
  const matchedRules = item.matchedRules
    .map((id) => weights.get(id))
    .filter((rule): rule is NonNullable<typeof rule> => rule !== undefined);

  const source = await getSource(item.source.id);

  const { score, breakdown } = computeScore({
    matchedRules,
    engagementScore: item.engagementScore,
    sourceKind: item.source.kind,
    sourceWeight: source?.weight ?? 1,
    publishedAt: new Date(item.publishedAt),
    now: new Date(),
  });

  res.json({
    data: {
      ...item,
      breakdown,
      // The stored score was computed at scoring time; the decay has moved on
      // since. Reporting both is the honest answer to "why 8.4?" when the row
      // says 8.4 and the arithmetic now says 7.9.
      liveScore: score,
    } satisfies ItemDetail & { liveScore: number },
  });
});

itemsRouter.post('/items/:id/read', async (req, res) => {
  await mutate(req.params['id'], (id) => setItemRead(id, true));
  res.status(204).end();
});

itemsRouter.delete('/items/:id/read', async (req, res) => {
  await mutate(req.params['id'], (id) => setItemRead(id, false));
  res.status(204).end();
});

itemsRouter.post('/items/:id/star', async (req, res) => {
  await mutate(req.params['id'], (id) => setItemStarred(id, true));
  res.status(204).end();
});

itemsRouter.delete('/items/:id/star', async (req, res) => {
  await mutate(req.params['id'], (id) => setItemStarred(id, false));
  res.status(204).end();
});

async function mutate(
  raw: string | undefined,
  apply: (id: string) => Promise<boolean>,
): Promise<void> {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw HttpError.validation('Invalid id: expected a positive integer');
  }
  const updated = await apply(raw);
  if (!updated) throw HttpError.notFound('Item');
}
