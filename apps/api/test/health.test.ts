import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * The unreachable-database path and the error envelope, which need no database.
 *
 * `GET /api/health` now reports source counts, the Reddit budget and queue depth,
 * so the healthy path is exercised in the integration suite against a real
 * PostgreSQL instead of behind a wall of mocks.
 */

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

describe('GET /api/health when the database is unreachable', () => {
  it('answers 503 with status error and nothing invented', async () => {
    isReachable.mockResolvedValue(false);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.db).toEqual({ reachable: false });
    // An unreachable database makes every other number a guess; none are returned.
    expect(res.body.sources).toBeUndefined();
    expect(res.body.queue).toBeUndefined();
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('error shape', () => {
  it('returns the single error envelope for an unknown route', async () => {
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'GET /api/does-not-exist not found' },
    });
  });

  it('never leaks a stack trace', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });
});
