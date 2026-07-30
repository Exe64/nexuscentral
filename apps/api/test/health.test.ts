import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The pool must be stubbed before the app graph imports it: `GET /api/health`
// is the one Phase 0 route and its whole job is to report reachability, so the
// test drives that flag directly instead of requiring a live PostgreSQL.
const isReachable = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

vi.mock('../src/db/pool.js', () => ({
  isReachable,
  closePool: vi.fn(async () => undefined),
  pool: { on: vi.fn() },
  query: vi.fn(),
  transaction: vi.fn(),
}));

const { createApp } = await import('../src/http/app.js');
const app = createApp();

afterAll(() => {
  vi.restoreAllMocks();
});

describe('GET /api/health', () => {
  it('reports ok when the database answers', async () => {
    isReachable.mockResolvedValue(true);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toEqual({ reachable: true });
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports error with 503 when the database is unreachable', async () => {
    isReachable.mockResolvedValue(false);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.db).toEqual({ reachable: false });
  });
});

describe('error shape', () => {
  it('returns the single error envelope for an unknown route', async () => {
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'GET /api/does-not-exist not found',
      },
    });
  });

  it('never leaks a stack trace', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });
});
