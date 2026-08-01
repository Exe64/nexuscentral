/**
 * `GET /api/update` -- whether a newer commit exists on the repository's main
 * branch, and what the host agent is doing about it.
 *
 * Authenticated. The repository is public, so the deployed sha is not a secret,
 * but there is no reason to tell an anonymous caller which build is running: it
 * is exactly the fact that says which known issues apply.
 *
 * `POST /api/update/run` asks the host agent to deploy. The API does not deploy
 * anything itself -- see deploy/update-agent.sh for why.
 */

import { Router } from 'express';
import { updateStatus } from '../../update/check.js';
import { requestUpdate, updateRun, UpdateRunError } from '../../update/control.js';
import { HttpError } from '../errors.js';

export const updateRouter: Router = Router();

updateRouter.get('/update', async (req, res) => {
  const force = req.query['force'] === 'true';
  const [status, run] = await Promise.all([updateStatus({ force }), updateRun()]);
  res.json({ data: { ...status, run } });
});

updateRouter.post('/update/run', async (_req, res) => {
  try {
    res.status(202).json({ data: await requestUpdate() });
  } catch (err) {
    if (err instanceof UpdateRunError) {
      // 409 rather than 400: nothing about the request was wrong, the host is
      // just not in a state to accept it.
      throw err.reason === 'already_running'
        ? HttpError.conflict(err.message)
        : HttpError.validation(err.message, { reason: err.reason });
    }
    throw err;
  }
});
