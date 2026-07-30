/**
 * GET /api/health
 *
 * Phase 0 answers the database-reachability question only. The full shape from
 * 03-SPEC-api.md 8 (per-source status, Reddit budget, queue depth) lands with
 * the sources and worker phases that produce those numbers.
 *
 * `status` is `ok` when nothing is failing and `error` when the database is
 * unreachable -- an unreachable database means every other answer is a guess,
 * so this returns 503 rather than a cheerful 200.
 */

import { Router } from 'express';
import { isReachable } from '../db/pool.js';
import { VERSION } from '../version.js';

export const healthRouter: Router = Router();

healthRouter.get('/health', async (_req, res) => {
  const dbReachable = await isReachable();

  res.status(dbReachable ? 200 : 503).json({
    status: dbReachable ? 'ok' : 'error',
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    db: { reachable: dbReachable },
  });
});
