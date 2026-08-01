/**
 * `GET /api/update` -- whether a newer commit exists on the repository's main
 * branch.
 *
 * Authenticated. The repository is public, so the deployed sha is not a secret,
 * but there is no reason to tell an anonymous caller which build is running: it
 * is exactly the fact that says which known issues apply.
 *
 * `?force=true` skips the cache, within the checker's own floor.
 */

import { Router } from 'express';
import { updateStatus } from '../../update/check.js';

export const updateRouter: Router = Router();

updateRouter.get('/update', async (req, res) => {
  const force = req.query['force'] === 'true';
  res.json({ data: await updateStatus({ force }) });
});
