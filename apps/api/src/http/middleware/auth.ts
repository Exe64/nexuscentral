/**
 * Session cookie handling and the gate in front of every route.
 *
 * Cookies are read by hand rather than with `cookie-parser`: one cookie does not
 * justify a dependency, and `res.cookie` is already part of Express.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isProduction } from '../../config/env.js';
import { resolveSession } from '../../auth/sessions.js';
import { HttpError } from '../errors.js';

export const SESSION_COOKIE = 'nc_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `attachSession` when the request carries a valid session. */
      sessionId?: number;
    }
  }
}

/** Parse one cookie out of the header. No dependency, no allocation per cookie. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // Not in development: the dev server is plain HTTP on localhost, and a Secure
    // cookie there is simply never sent back.
    secure: isProduction,
    // Strict, not Lax. Nothing links into this app from elsewhere, so the usual
    // reason to prefer Lax does not apply, and Strict is what makes the CSRF
    // surface a non-issue for a cookie-authenticated API.
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
  });
}

/**
 * Resolve the session if there is one, without requiring it.
 *
 * Runs on every request so that public routes can still vary their answer for an
 * authenticated caller -- `/api/health` says far more once you are logged in.
 */
export const attachSession: RequestHandler = (req, res, next) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token === null) {
    next();
    return;
  }

  void resolveSession(token)
    .then((session) => {
      if (session !== null) {
        req.sessionId = session.id;
        // Sliding expiry only counts if the cookie learns about it too.
        if (session.renewedUntil !== undefined) {
          setSessionCookie(res, token, session.renewedUntil);
        }
      }
      next();
    })
    .catch(next);
};

/** Reject anything without a session. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (req.sessionId === undefined) {
    next(new HttpError('UNAUTHORIZED', 'Authentication required.'));
    return;
  }
  next();
}

export function currentSessionId(req: Request): number {
  const id = req.sessionId;
  // requireAuth runs first everywhere this is called; this is the type narrowing,
  // not a real runtime branch.
  if (id === undefined) throw new HttpError('UNAUTHORIZED', 'Authentication required.');
  return id;
}
