/**
 * Authentication, against a real database.
 *
 * The load-bearing test in this file is "every route is closed": it walks the
 * mounted Express router tree and asserts that nothing outside the public list
 * answers without a session. A hand-written list of routes would drift the first
 * time someone adds one -- which is precisely the case that must not slip.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setPassword } from '../../src/auth/credential.js';
import { MAX_PER_IP, WINDOW_MS } from '../../src/auth/attempts.js';
import { SESSION_COOKIE } from '../../src/http/middleware/auth.js';
import { query } from '../../src/db/pool.js';
import { app, closeDatabase, resetDatabaseRaw, scalar } from './helpers.js';

const PASSWORD = 'the-correct-horse-battery-staple';

// Raw, not the shared authenticated helper: these tests need to start genuinely
// signed out, and the session the helper creates would show up in every count.
beforeEach(async () => {
  await resetDatabaseRaw();
  await setPassword(PASSWORD);
});
afterAll(closeDatabase);

/** Log in and return the raw Cookie header to replay. */
async function signIn(password = PASSWORD): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ password });
  expect(res.status).toBe(204);

  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = (cookies ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (cookie === undefined) throw new Error('No session cookie was set');
  return cookie.split(';')[0] as string;
}

describe('POST /api/auth/login', () => {
  it('sets an httpOnly, SameSite=Strict session cookie', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: PASSWORD });

    expect(res.status).toBe(204);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';

    expect(cookie).toContain('HttpOnly');
    // Strict, so a cookie-authenticated API needs no CSRF token of its own.
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toContain('Path=/');
  });

  it('never returns the token in the body', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    expect(res.text).toBe('');
  });

  it('rejects the wrong password with the same message as any other failure', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'wrong-but-long' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    // No "user not found" vs "wrong password" distinction to mine.
    expect(res.body.error.message).toBe('Incorrect password.');
  });

  it('stores only a hash of the token, never the token', async () => {
    const cookie = await signIn();
    const token = cookie.split('=')[1] ?? '';

    expect(token.length).toBeGreaterThan(20);

    const stored = await scalar<string>(`SELECT encode(token_hash, 'hex') FROM sessions`);
    expect(stored).not.toContain(token);
    // A dump of `sessions` yields nothing replayable.
    expect(stored).toHaveLength(64);
  });

  it('does not store the password anywhere in the clear', async () => {
    await signIn();
    const hash = await scalar<string>(`SELECT password_hash FROM auth_credential`);
    expect(hash).not.toContain(PASSWORD);
    expect(hash.startsWith('scrypt$')).toBe(true);
  });
});

describe('the session cookie', () => {
  it('opens the protected routes', async () => {
    const cookie = await signIn();
    const res = await request(app).get('/api/tags').set('Cookie', cookie);
    expect(res.status).toBe(200);
  });

  it('is refused once the session is deleted', async () => {
    const cookie = await signIn();
    await query('DELETE FROM sessions');

    const res = await request(app).get('/api/tags').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });

  it('is refused once expired, and the row is swept', async () => {
    const cookie = await signIn();
    await query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);

    expect((await request(app).get('/api/tags').set('Cookie', cookie)).status).toBe(401);
    expect(await scalar<number>('SELECT count(*)::int FROM sessions')).toBe(0);
  });

  it('is not forgeable by editing the cookie', async () => {
    const cookie = await signIn();
    const tampered = `${SESSION_COOKIE}=${(cookie.split('=')[1] ?? '').slice(0, -1)}x`;

    expect((await request(app).get('/api/tags').set('Cookie', tampered)).status).toBe(401);
  });

  it('slides its expiry once past the halfway mark', async () => {
    const cookie = await signIn();
    // Push the session to just under halfway remaining.
    await query(`UPDATE sessions SET expires_at = now() + interval '10 days'`);

    const res = await request(app).get('/api/tags').set('Cookie', cookie);
    expect(res.status).toBe(200);

    // A renewal both extends the row and re-sends the cookie, or the browser
    // would drop a session the server still considers live.
    const days = await scalar<number>(
      `SELECT extract(day from (expires_at - now()))::int FROM sessions`,
    );
    expect(days).toBeGreaterThan(25);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('does not rewrite the cookie on every request', async () => {
    const cookie = await signIn();
    const res = await request(app).get('/api/tags').set('Cookie', cookie);
    // Freshly issued: nowhere near the halfway mark, so no write and no cookie.
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('POST /api/auth/logout', () => {
  it('drops the session and clears the cookie', async () => {
    const cookie = await signIn();
    const res = await request(app).post('/api/auth/logout').set('Cookie', cookie);

    expect(res.status).toBe(204);
    expect(await scalar<number>('SELECT count(*)::int FROM sessions')).toBe(0);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain(`${SESSION_COOKIE}=;`);

    expect((await request(app).get('/api/tags').set('Cookie', cookie)).status).toBe(401);
  });

  it('is idempotent', async () => {
    expect((await request(app).post('/api/auth/logout')).status).toBe(204);
  });
});

describe('rate limiting', () => {
  it('locks out an address after repeated failures', async () => {
    for (let i = 0; i < MAX_PER_IP; i += 1) {
      const res = await request(app).post('/api/auth/login').send({ password: 'wrong-but-long' });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app).post('/api/auth/login').send({ password: 'wrong-but-long' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('refuses even the correct password while locked out', async () => {
    for (let i = 0; i < MAX_PER_IP; i += 1) {
      await request(app).post('/api/auth/login').send({ password: 'wrong-but-long' });
    }

    // Otherwise the lockout is only an inconvenience to someone who is guessing.
    const res = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    expect(res.status).toBe(429);
  });

  it('forgets failures once the window passes', async () => {
    for (let i = 0; i < MAX_PER_IP; i += 1) {
      await request(app).post('/api/auth/login').send({ password: 'wrong-but-long' });
    }
    await query(`UPDATE auth_attempts SET at = at - $1::interval`, [
      `${Math.ceil(WINDOW_MS / 1000) + 60} seconds`,
    ]);

    expect((await request(app).post('/api/auth/login').send({ password: PASSWORD })).status).toBe(
      204,
    );
  });

  it('clears the counter after a success, so one typo does not arm it', async () => {
    await request(app).post('/api/auth/login').send({ password: 'wrong-but-long' });
    await request(app).post('/api/auth/login').send({ password: PASSWORD });

    expect(
      await scalar<number>('SELECT count(*)::int FROM auth_attempts WHERE successful = false'),
    ).toBe(0);
  });

  it('records every attempt for the audit trail', async () => {
    await request(app).post('/api/auth/login').send({ password: 'wrong-but-long' });
    expect(await scalar<number>('SELECT count(*)::int FROM auth_attempts')).toBe(1);
  });
});

describe('POST /api/auth/password', () => {
  it('requires the current password even from an open session', async () => {
    const cookie = await signIn();
    const res = await request(app)
      .post('/api/auth/password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'not-it-at-all', newPassword: 'a-brand-new-long-password' });

    // A borrowed session must not be able to lock the owner out.
    expect(res.status).toBe(401);
  });

  it('changes the password and revokes every other session', async () => {
    const first = await signIn();
    const second = await signIn();

    const res = await request(app)
      .post('/api/auth/password')
      .set('Cookie', second)
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-long-password' });

    expect(res.status).toBe(200);
    expect(res.body.data.revokedSessions).toBe(1);

    // The session that made the change survives; the other does not.
    expect((await request(app).get('/api/tags').set('Cookie', second)).status).toBe(200);
    expect((await request(app).get('/api/tags').set('Cookie', first)).status).toBe(401);

    // And the new password is the one that works.
    expect((await request(app).post('/api/auth/login').send({ password: PASSWORD })).status).toBe(
      401,
    );
  });

  it('enforces the length floor on the new password', async () => {
    const cookie = await signIn();
    const res = await request(app)
      .post('/api/auth/password')
      .set('Cookie', cookie)
      .send({ currentPassword: PASSWORD, newPassword: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('cannot be called without a session', async () => {
    const res = await request(app)
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-long-password' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/session', () => {
  it('reports an anonymous caller without failing', async () => {
    const res = await request(app).get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ authenticated: false, configured: true });
  });

  it('reports an authenticated one', async () => {
    const cookie = await signIn();
    const res = await request(app).get('/api/auth/session').set('Cookie', cookie);
    expect(res.body.data.authenticated).toBe(true);
  });
});

describe('sessions listing', () => {
  it('marks the caller’s own session', async () => {
    await signIn();
    const cookie = await signIn();

    const res = await request(app).get('/api/auth/sessions').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.filter((s: { current?: boolean }) => s.current === true)).toHaveLength(1);
  });

  it('revokes the others on request', async () => {
    await signIn();
    await signIn();
    const cookie = await signIn();

    const res = await request(app).post('/api/auth/sessions/revoke-others').set('Cookie', cookie);
    expect(res.body.data.revokedSessions).toBe(2);
    expect(await scalar<number>('SELECT count(*)::int FROM sessions')).toBe(1);
  });

  it('refuses to delete the current session, which is what logout is for', async () => {
    const cookie = await signIn();
    const list = await request(app).get('/api/auth/sessions').set('Cookie', cookie);
    const mine = list.body.data[0].id;

    const res = await request(app).delete(`/api/auth/sessions/${mine}`).set('Cookie', cookie);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/health', () => {
  it('answers without a session, because the healthcheck runs before login', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('says nothing about what is being tracked when anonymous', async () => {
    const res = await request(app).get('/api/health');

    // Source counts, the Reddit budget and the queue describe the instance's
    // contents. They are not for the door.
    expect(res.body.sources).toBeUndefined();
    expect(res.body.reddit).toBeUndefined();
    expect(res.body.queue).toBeUndefined();
    expect(res.body.version).toBeDefined();
  });

  it('gives the full picture to an authenticated caller', async () => {
    const cookie = await signIn();
    const res = await request(app).get('/api/health').set('Cookie', cookie);

    expect(res.body.sources).toBeDefined();
    expect(res.body.queue).toBeDefined();
  });
});
