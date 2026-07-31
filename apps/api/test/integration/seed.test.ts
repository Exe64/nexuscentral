/**
 * First boot: a dashboard with something on it, not an empty page and a manual.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seedIfEmpty } from '../../src/seed.js';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('seedIfEmpty', () => {
  it('creates Home with a feed, alerts and source health', async () => {
    expect(await seedIfEmpty()).toEqual({ seeded: true });

    const res = await agent.get('/api/dashboards');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Home');

    const dashboard = await agent.get(`/api/dashboards/${res.body.data[0].id}`);
    expect(dashboard.body.data.widgets.map((w: { type: string }) => w.type)).toEqual([
      'feed',
      'alerts',
      'source_health',
    ]);
  });

  it('sorts the seeded feed by score, which is the point of the rules', async () => {
    await seedIfEmpty();
    const config = await scalar<Record<string, unknown>>(
      `SELECT config FROM widgets WHERE type = 'feed'`,
    );
    expect(config['sort']).toBe('score');
  });

  it('does nothing on a second run', async () => {
    await seedIfEmpty();
    expect(await seedIfEmpty()).toEqual({ seeded: false });
    expect(await scalar<number>('SELECT count(*)::int FROM dashboards')).toBe(1);
  });

  it('leaves a user-created dashboard alone', async () => {
    await agent.post('/api/dashboards').send({ name: 'Security' });

    expect(await seedIfEmpty()).toEqual({ seeded: false });
    expect(await scalar<number>('SELECT count(*)::int FROM dashboards')).toBe(1);
  });

  it('gives the seeded dashboard a layout at every breakpoint', async () => {
    await seedIfEmpty();
    const dashboards = await agent.get('/api/dashboards');
    const dashboard = await agent.get(`/api/dashboards/${dashboards.body.data[0].id}`);

    for (const widget of dashboard.body.data.widgets) {
      expect(Object.keys(widget.layout).sort()).toEqual(['lg', 'md', 'sm', 'xs']);
    }
  });

  it('leaves the seeded dashboard renderable straight away', async () => {
    await seedIfEmpty();
    const dashboards = await agent.get('/api/dashboards');
    const res = await agent.get(`/api/dashboards/${dashboards.body.data[0].id}/data`);

    expect(res.status).toBe(200);
    // Three widgets, all resolvable against an empty database.
    const statuses = Object.values(res.body.widgets).map((p) => (p as { status: string }).status);
    expect(statuses).toEqual(['ok', 'ok', 'ok']);
  });
});
