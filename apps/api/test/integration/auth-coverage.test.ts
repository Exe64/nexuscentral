/**
 * Every route is closed unless it is on the public list.
 *
 * This walks the Express router tree rather than a hand-maintained list of paths.
 * A list would pass forever while drifting from reality; the whole point is to
 * catch the route somebody adds next year without thinking about the gate.
 *
 * The check is deliberately blunt: call every route with no cookie and require a
 * 401. A route that 404s or 400s instead has still leaked the fact that it exists
 * and, worse, has run its handler.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setPassword } from '../../src/auth/credential.js';
import { app, closeDatabase, resetDatabaseRaw } from './helpers.js';

const PASSWORD = 'the-correct-horse-battery-staple';

// Raw: every request in this file is deliberately anonymous.
beforeEach(async () => {
  await resetDatabaseRaw();
  await setPassword(PASSWORD);
});
afterAll(closeDatabase);

/**
 * The only routes allowed to answer without a session.
 *
 * `/api/health` because the container healthcheck and deploy.sh both run before
 * anyone can log in; `/api/auth/*` because logging in cannot require being logged
 * in. Anything else appearing here should be argued for in a review.
 */
const PUBLIC = [/^\/health$/, /^\/auth\//];

interface Route {
  method: string;
  path: string;
}

/** Walk the mounted router tree and collect every method/path pair. */
function collectRoutes(): Route[] {
  const found: Route[] = [];

  // Express 5 keeps the stack on the router. This reaches into an internal, and
  // that is accepted deliberately: the alternative is a hand-written list, and a
  // hand-written list is what this test exists to avoid.
  const stack =
    (app as unknown as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } }).router
      ?.stack ??
    (app as unknown as { _router?: { stack: unknown[] } })._router?.stack ??
    [];

  const walk = (layers: unknown[], prefix: string): void => {
    for (const layer of layers) {
      const l = layer as {
        route?: { path: string; methods: Record<string, boolean> };
        handle?: { stack?: unknown[] };
        regexp?: RegExp;
        name?: string;
      };

      if (l.route !== undefined) {
        for (const [method, enabled] of Object.entries(l.route.methods)) {
          if (enabled && method !== '_all') {
            found.push({ method: method.toUpperCase(), path: prefix + l.route.path });
          }
        }
        continue;
      }

      if (l.name === 'router' && l.handle?.stack !== undefined) {
        walk(l.handle.stack, prefix);
      }
    }
  };

  walk(stack, '');
  return found;
}

/** `/sources/:id/poll` -> `/sources/1/poll`, so the request reaches the handler. */
function concretise(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, '1');
}

const ROUTES = collectRoutes();
const PROTECTED = ROUTES.filter((r) => !PUBLIC.some((p) => p.test(r.path)));

describe('route inventory', () => {
  it('found the routes at all -- a vacuous pass here would hide everything else', () => {
    expect(ROUTES.length).toBeGreaterThan(25);
    expect(PROTECTED.length).toBeGreaterThan(20);
  });

  it('lists the public surface explicitly', () => {
    const publicRoutes = ROUTES.filter((r) => PUBLIC.some((p) => p.test(r.path)))
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    // Locked in on purpose: adding a public route should mean editing this test
    // and saying why in the diff.
    expect(publicRoutes).toEqual([
      'DELETE /auth/sessions/:id',
      'GET /auth/session',
      'GET /auth/sessions',
      'GET /health',
      'POST /auth/login',
      'POST /auth/logout',
      'POST /auth/password',
      'POST /auth/sessions/revoke-others',
    ]);
  });
});

describe('every non-public route rejects an anonymous caller', () => {
  it.each(PROTECTED.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s',
    async (_label, route) => {
      const path = `/api${concretise(route.path)}`;
      const method = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete' | 'put';

      const res = await request(app)[method](path).send({});

      expect(res.status, `${route.method} ${path} answered ${res.status}`).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
    },
  );
});

describe('an unknown route', () => {
  it('is a 404 with the usual envelope once authenticated', async () => {
    // The signed-out case is a 401 (see health.test.ts): route enumeration is not
    // something to hand out. Past the gate, the ordinary shape applies.
    const signedIn = request.agent(app);
    expect((await signedIn.post('/api/auth/login').send({ password: PASSWORD })).status).toBe(204);

    const res = await signedIn.get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'GET /api/does-not-exist not found' },
    });
  });
});

/**
 * The `/auth` routes that are public at the router level still guard themselves.
 *
 * They sit before the gate so that logging in is possible, which means the gate
 * is not what protects them -- `requireAuth` on the individual route is.
 */
describe('the authenticated routes under /auth guard themselves', () => {
  it.each([
    ['GET', '/api/auth/sessions'],
    ['POST', '/api/auth/sessions/revoke-others'],
    ['DELETE', '/api/auth/sessions/1'],
    ['POST', '/api/auth/password'],
  ])('%s %s', async (method, path) => {
    const res = await request(app)
      [method.toLowerCase() as 'get' | 'post' | 'delete'](path)
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-long-password' });

    expect(res.status).toBe(401);
  });
});
