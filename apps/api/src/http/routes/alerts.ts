/**
 * Alert routes (03-SPEC-api.md 9).
 *
 * Read and acknowledge only. Nothing creates an alert yet -- delivery and the rules
 * that produce them are Phase 6 -- but the `alerts` widget needs somewhere to read
 * from, and an honest empty state beats a placeholder.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  acknowledgeAlert,
  acknowledgeAllAlerts,
  alertCounts,
  listAlerts,
} from '../../db/alerts.js';
import { itemStats } from '../../db/items.js';
import { topSourcesByVolume } from '../../db/alerts.js';
import { countRules } from '../../db/rules.js';
import { sourceHealthCounts } from '../../db/sources.js';
import { getRawSettings, resolveRedditCredentials } from '../../db/settings.js';
import { redditBudget } from '../../adapters/reddit/budget.js';
import { HttpError } from '../errors.js';
import { bigintParam, parseQuery, queryBoolean } from '../validation.js';

export const alertsRouter: Router = Router();

const listQuerySchema = z.object({
  acknowledged: queryBoolean,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

alertsRouter.get('/alerts', async (req, res) => {
  const query = parseQuery(listQuerySchema, req);

  const [alerts, counts] = await Promise.all([
    listAlerts({ acknowledged: query.acknowledged, limit: query.limit }),
    alertCounts(),
  ]);

  res.json({ data: alerts, counts });
});

alertsRouter.post('/alerts/ack-all', async (_req, res) => {
  res.json({ data: { acknowledged: await acknowledgeAllAlerts() } });
});

alertsRouter.post('/alerts/:id/ack', async (req, res) => {
  const acknowledged = await acknowledgeAlert(bigintParam(req, 'id'));
  // Already acknowledged is not an error -- two clicks should not produce one.
  if (!acknowledged) {
    const counts = await alertCounts();
    if (counts.total === 0) throw HttpError.notFound('Alert');
  }
  res.status(204).end();
});

/**
 * `GET /api/stats` -- the numbers behind the stats widget (03-SPEC-api.md 8).
 *
 * Also useful on its own when something looks wrong and the dashboard is the thing
 * being doubted.
 */
alertsRouter.get('/stats', async (_req, res) => {
  const [items, sources, rules, alerts, topSources, settings] = await Promise.all([
    itemStats(),
    sourceHealthCounts(),
    countRules(),
    alertCounts(),
    topSourcesByVolume(5),
    getRawSettings(),
  ]);

  const budget = redditBudget.snapshot();

  res.json({
    data: {
      items,
      sources,
      rules,
      alerts,
      topSources,
      reddit: {
        configured: resolveRedditCredentials(settings) !== null,
        remaining: budget.remaining,
        limit: budget.limit,
        utilisation: budget.utilisation,
        resetIn: budget.resetIn,
      },
    },
  });
});
