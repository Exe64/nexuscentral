/**
 * Authentication routes.
 *
 * These are the only routes reachable without a session, so everything here is
 * written on the assumption that it is being probed.
 */

import { Router } from 'express';
import { z } from 'zod';
import { checkRateLimit, recordAttempt } from '../../auth/attempts.js';
import { credentialExists, getPasswordHash, setPassword } from '../../auth/credential.js';
import { MAX_PASSWORD_LENGTH, passwordProblem, verifyPassword } from '../../auth/password.js';
import {
  createSession,
  deleteOtherSessions,
  deleteSession,
  deleteSessionByToken,
  listSessions,
} from '../../auth/sessions.js';
import { logger } from '../../logger.js';
import { HttpError } from '../errors.js';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  currentSessionId,
  readCookie,
  requireAuth,
  setSessionCookie,
} from '../middleware/auth.js';
import { intParam, parseBody } from '../validation.js';

export const authRouter: Router = Router();

const log = logger.child({ component: 'auth' });

// No `.min()` here: length rules belong to `passwordProblem`, and applying them at
// login would tell an attacker how long the real password is not.
const loginSchema = z.object({ password: z.string().max(MAX_PASSWORD_LENGTH) });

const changeSchema = z.object({
  currentPassword: z.string().max(MAX_PASSWORD_LENGTH),
  newPassword: z.string().max(MAX_PASSWORD_LENGTH),
});

/**
 * `GET /api/auth/session` -- what the SPA asks before rendering anything.
 *
 * Public, and deliberately says almost nothing: whether this request is
 * authenticated, and whether the instance has a password at all.
 */
authRouter.get('/auth/session', async (req, res) => {
  res.json({
    data: {
      authenticated: req.sessionId !== undefined,
      configured: await credentialExists(),
    },
  });
});

authRouter.post('/auth/login', async (req, res) => {
  const body = parseBody(loginSchema, req);

  const verdict = await checkRateLimit(req.ip);
  if (!verdict.allowed) {
    res.setHeader('Retry-After', String(verdict.retryAfter));
    throw HttpError.rateLimited(
      `Too many failed attempts. Try again in ${Math.ceil(verdict.retryAfter / 60)} minutes.`,
      { retryAfter: verdict.retryAfter, scope: verdict.scope },
    );
  }

  const stored = await getPasswordHash();
  if (stored === null) {
    // No credential at all. The process refuses to start in this state, so
    // reaching here means the row was deleted underneath a running instance.
    log.error('A login was attempted but no password is stored.');
    throw HttpError.unauthorized('This instance has no password configured.');
  }

  const ok = await verifyPassword(body.password, stored);
  await recordAttempt(req.ip, ok);

  if (!ok) {
    // One message for every failure. Distinguishing "wrong password" from
    // anything else is free information.
    throw HttpError.unauthorized('Incorrect password.');
  }

  const session = await createSession({
    userAgent: req.headers['user-agent'] ?? null,
    ip: req.ip ?? null,
  });
  setSessionCookie(res, session.token, session.expiresAt);

  log.info({ ip: req.ip }, 'Signed in');
  res.status(204).end();
});

authRouter.post('/auth/logout', async (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token !== null) await deleteSessionByToken(token);
  clearSessionCookie(res);
  // 204 whether or not there was a session: logging out twice is not an error.
  res.status(204).end();
});

/**
 * `POST /api/auth/password` -- change it.
 *
 * Requires the current password even though the caller is already authenticated:
 * a borrowed session should not be able to lock the owner out.
 */
authRouter.post('/auth/password', requireAuth, async (req, res) => {
  const body = parseBody(changeSchema, req);
  const sessionId = currentSessionId(req);

  const stored = await getPasswordHash();
  if (stored === null) throw HttpError.unauthorized('This instance has no password configured.');

  // Rate limited too: an open session is otherwise an oracle for the password.
  const verdict = await checkRateLimit(req.ip);
  if (!verdict.allowed) {
    res.setHeader('Retry-After', String(verdict.retryAfter));
    throw HttpError.rateLimited('Too many failed attempts. Try again later.', {
      retryAfter: verdict.retryAfter,
    });
  }

  const ok = await verifyPassword(body.currentPassword, stored);
  await recordAttempt(req.ip, ok);
  if (!ok) throw HttpError.unauthorized('The current password is incorrect.');

  const problem = passwordProblem(body.newPassword);
  if (problem !== null) throw HttpError.validation(problem, { newPassword: [problem] });

  await setPassword(body.newPassword);

  // Every other session dies with the old password. If the reason for changing it
  // is that someone else has it, leaving their session alive defeats the change.
  const revoked = await deleteOtherSessions(sessionId);

  log.info({ revoked }, 'Password changed');
  res.json({ data: { revokedSessions: revoked } });
});

authRouter.get('/auth/sessions', requireAuth, async (req, res) => {
  res.json({ data: await listSessions(currentSessionId(req)) });
});

authRouter.delete('/auth/sessions/:id', requireAuth, async (req, res) => {
  const id = intParam(req, 'id');
  if (id === currentSessionId(req)) {
    throw HttpError.validation('Use logout to end the current session.');
  }
  await deleteSession(id);
  res.status(204).end();
});

/** Sign out everywhere else -- the button for "I used a shared computer". */
authRouter.post('/auth/sessions/revoke-others', requireAuth, async (req, res) => {
  const revoked = await deleteOtherSessions(currentSessionId(req));
  res.json({ data: { revokedSessions: revoked } });
});
