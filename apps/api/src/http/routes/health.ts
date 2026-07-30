/**
 * `GET /api/health` (03-SPEC-api.md 8).
 *
 * `status` is `ok` when nothing is failing, `degraded` when some sources fail, and
 * `error` when the database is unreachable -- an unreachable database makes every
 * other number a guess, so that case answers 503 rather than a cheerful 200.
 *
 * This backs the `source_health` widget, so it must stay cheap: it is polled.
 */

import { Router } from 'express';
import { isReachable } from '../../db/pool.js';
import { lastPollAt, sourceHealthCounts } from '../../db/sources.js';
import {
  getRawSettings,
  resolveNitterBaseUrls,
  resolveRedditCredentials,
} from '../../db/settings.js';
import { redditBudget } from '../../adapters/reddit/budget.js';
import { queueDepth } from '../../worker/index.js';
import { VERSION } from '../../version.js';

export const healthRouter: Router = Router();

healthRouter.get('/health', async (_req, res) => {
  if (!(await isReachable())) {
    res.status(503).json({
      status: 'error',
      version: VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      db: { reachable: false },
    });
    return;
  }

  const [sources, settings, queue, polledAt] = await Promise.all([
    sourceHealthCounts(),
    getRawSettings(),
    queueDepth(),
    lastPollAt(),
  ]);

  const budget = redditBudget.snapshot();

  // A silently-empty source has zero failures and looked healthy on every run;
  // it still needs to show up here, or the whole counter buys nothing.
  const unhealthy = sources.failing > 0 || sources.stale > 0 || sources.silentlyEmpty > 0;

  res.json({
    status: unhealthy ? 'degraded' : 'ok',
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    db: { reachable: true },
    sources,
    reddit: {
      configured: resolveRedditCredentials(settings) !== null,
      remaining: budget.remaining,
      resetIn: budget.resetIn,
      // Not in the spec's example, but it is the number the acceptance criterion
      // is about, so it belongs where it can be observed.
      utilisation: budget.utilisation,
    },
    nitter: { instances: resolveNitterBaseUrls(settings).urls.length },
    queue,
    lastPollAt: polledAt,
  });
});
