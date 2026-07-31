/**
 * Dashboards, widgets, layouts and the batched data endpoint (03-SPEC-api.md 6).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearWidgetCache, widgetCacheStats } from '../../src/widgets/cache.js';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';

beforeEach(async () => {
  await resetDatabase();
  clearWidgetCache();
});
afterAll(closeDatabase);

/** Nothing listens on port 1, so a fetch here fails at once and needs no network. */
const UNREACHABLE = 'http://127.0.0.1:1/never';

async function makeDashboard(name = 'Home'): Promise<number> {
  const res = await agent.post('/api/dashboards').send({ name });
  expect(res.status).toBe(201);
  return res.body.data.id as number;
}

async function makeWidget(
  dashboardId: number,
  body: Record<string, unknown> = {},
): Promise<number> {
  const res = await agent
    .post('/api/widgets')
    .send({ dashboardId, type: 'feed', title: 'Everything', ...body });
  expect(res.status).toBe(201);
  return res.body.data.id as number;
}

describe('POST /api/dashboards', () => {
  it('appends to the end when no position is given', async () => {
    await makeDashboard('Home');
    const second = await agent.post('/api/dashboards').send({ name: 'Security' });

    expect(second.body.data.position).toBe(1);
  });

  it('lists dashboards in position order', async () => {
    await agent.post('/api/dashboards').send({ name: 'Second', position: 5 });
    await agent.post('/api/dashboards').send({ name: 'First', position: 1 });

    const res = await agent.get('/api/dashboards');
    expect(res.body.data.map((d: { name: string }) => d.name)).toEqual(['First', 'Second']);
  });

  it('takes its widgets with it when deleted', async () => {
    const dashboardId = await makeDashboard();
    await makeWidget(dashboardId);

    expect((await agent.delete(`/api/dashboards/${dashboardId}`)).status).toBe(204);
    expect(await scalar<number>('SELECT count(*)::int FROM widgets')).toBe(0);
  });
});

describe('POST /api/widgets', () => {
  it('fills in the default config for the type', async () => {
    const dashboardId = await makeDashboard();
    const res = await agent
      .post('/api/widgets')
      .send({ dashboardId, type: 'feed', title: 'Everything' });

    // The client sent no config at all; the schema's defaults apply.
    expect(res.body.data.config).toMatchObject({ sort: 'published', limit: 15, tagIds: [] });
  });

  it('rejects a config the schema does not accept', async () => {
    const dashboardId = await makeDashboard();
    const res = await agent
      .post('/api/widgets')
      .send({ dashboardId, type: 'feed', title: 'Everything', config: { limit: 5000 } });

    // Rejected at the boundary rather than discovered when the widget renders.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a custom_api widget with no URL, which could only ever error', async () => {
    const dashboardId = await makeDashboard();
    const res = await agent
      .post('/api/widgets')
      .send({ dashboardId, type: 'custom_api', title: 'Weather', config: { url: '' } });

    // The type itself was refused outright until Phase 6. Now the only thing that
    // makes one unusable is an empty URL, and that is caught at the boundary.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('URL');
  });

  it('404s when the dashboard does not exist', async () => {
    const res = await agent
      .post('/api/widgets')
      .send({ dashboardId: 9999, type: 'feed', title: 'Everything' });

    expect(res.status).toBe(404);
  });

  it('places a new widget at the bottom of every breakpoint', async () => {
    const dashboardId = await makeDashboard();
    const widgetId = await makeWidget(dashboardId);

    const res = await agent.get(`/api/dashboards/${dashboardId}`);
    const widget = res.body.data.widgets.find((w: { id: number }) => w.id === widgetId);

    expect(Object.keys(widget.layout).sort()).toEqual(['lg', 'md', 'sm', 'xs']);
    expect(widget.layout.xs.w).toBe(2);
  });
});

describe('PATCH /api/widgets/:id', () => {
  it('validates the config against the widget’s own type', async () => {
    const dashboardId = await makeDashboard();
    const widgetId = await makeWidget(dashboardId);

    // `showRedditBudget` belongs to `stats`, not `feed`; the feed schema is strict
    // about what it accepts for its own fields but the type is what decides.
    const res = await agent
      .patch(`/api/widgets/${widgetId}`)
      .send({ config: { sort: 'engagement', limit: 5 } });

    expect(res.status).toBe(200);
    expect(res.body.data.config).toMatchObject({ sort: 'engagement', limit: 5 });
  });

  it('rejects an invalid config rather than storing it', async () => {
    const dashboardId = await makeDashboard();
    const widgetId = await makeWidget(dashboardId);

    const res = await agent
      .patch(`/api/widgets/${widgetId}`)
      .send({ config: { sort: 'sideways' } });

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/dashboards/:id/layout', () => {
  it('merges per breakpoint so a drag on lg does not discard sm', async () => {
    const dashboardId = await makeDashboard();
    const widgetId = await makeWidget(dashboardId);

    await agent
      .patch(`/api/dashboards/${dashboardId}/layout`)
      .send({ layouts: [{ widgetId, breakpoint: 'sm', x: 0, y: 3, w: 6, h: 4 }] });

    await agent
      .patch(`/api/dashboards/${dashboardId}/layout`)
      .send({ layouts: [{ widgetId, breakpoint: 'lg', x: 8, y: 0, w: 4, h: 9 }] });

    const res = await agent.get(`/api/dashboards/${dashboardId}`);
    const layout = res.body.data.widgets[0].layout;

    expect(layout.lg).toEqual({ x: 8, y: 0, w: 4, h: 9 });
    // The earlier small-breakpoint position survived the large-breakpoint drag.
    expect(layout.sm).toEqual({ x: 0, y: 3, w: 6, h: 4 });
  });

  it('ignores widgets that belong to another dashboard', async () => {
    const first = await makeDashboard('Home');
    const second = await makeDashboard('Security');
    const widgetId = await makeWidget(second);

    const res = await agent
      .patch(`/api/dashboards/${first}/layout`)
      .send({ layouts: [{ widgetId, breakpoint: 'lg', x: 1, y: 1, w: 4, h: 4 }] });

    // A stale tab racing a move is not worth a 404; it just updates nothing.
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(0);
  });

  it('404s for a dashboard that does not exist', async () => {
    const res = await agent
      .patch('/api/dashboards/9999/layout')
      .send({ layouts: [{ widgetId: 1, breakpoint: 'lg', x: 0, y: 0, w: 4, h: 4 }] });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/dashboards/:id/data', () => {
  it('answers every widget in one response, keyed by id', async () => {
    const dashboardId = await makeDashboard();
    const feed = await makeWidget(dashboardId);
    const stats = await makeWidget(dashboardId, { type: 'stats', title: 'Numbers' });

    const res = await agent.get(`/api/dashboards/${dashboardId}/data`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.widgets).sort()).toEqual([String(feed), String(stats)].sort());
    expect(res.body.widgets[String(feed)].status).toBe('ok');
    expect(res.body.widgets[String(stats)].status).toBe('ok');
    expect(res.body.generatedAt).toMatch(/^\d{4}-/);
  });

  it('degrades one failing widget to an error entry and still answers 200', async () => {
    const dashboardId = await makeDashboard();
    const ok = await makeWidget(dashboardId);

    // A widget whose resolver cannot succeed: nothing listens on port 1, so the
    // connection is refused immediately. Port 1 rather than a real host, so this
    // needs no network and cannot pass or fail on someone else's uptime.
    const broken = await scalar<number>(
      `INSERT INTO widgets (dashboard_id, type, title, config, layout)
       VALUES ($1, 'custom_api', 'Weather', $2::jsonb, '{}'::jsonb)
       RETURNING id`,
      [dashboardId, JSON.stringify({ url: UNREACHABLE })],
    );

    const res = await agent.get(`/api/dashboards/${dashboardId}/data`);

    // One broken widget must never blank the dashboard.
    expect(res.status).toBe(200);
    expect(res.body.widgets[String(ok)].status).toBe('ok');
    expect(res.body.widgets[String(broken)].status).toBe('error');
    expect(res.body.widgets[String(broken)].error.message).toBeTruthy();
  });

  it('serves the second request from the cache', async () => {
    const dashboardId = await makeDashboard();
    await makeWidget(dashboardId);

    await agent.get(`/api/dashboards/${dashboardId}/data`);
    const before = widgetCacheStats();
    await agent.get(`/api/dashboards/${dashboardId}/data`);
    const after = widgetCacheStats();

    expect(after.hits).toBe(before.hits + 1);
    expect(after.misses).toBe(before.misses);
  });

  it('does not cache a rejected resolver', async () => {
    const dashboardId = await makeDashboard();
    await scalar<number>(
      `INSERT INTO widgets (dashboard_id, type, title, config, layout)
       VALUES ($1, 'custom_api', 'Weather', $2::jsonb, '{}'::jsonb)
       RETURNING id`,
      [dashboardId, JSON.stringify({ url: UNREACHABLE })],
    );

    await agent.get(`/api/dashboards/${dashboardId}/data`);
    const before = widgetCacheStats();
    await agent.get(`/api/dashboards/${dashboardId}/data`);

    // A transient failure must not stick around for a minute pretending to be an
    // answer, so the second attempt is a miss too.
    expect(widgetCacheStats().hits).toBe(before.hits);
  });

  it('drops the cached payload when the config changes', async () => {
    const dashboardId = await makeDashboard();
    const widgetId = await makeWidget(dashboardId);

    await agent.get(`/api/dashboards/${dashboardId}/data`);
    await agent.patch(`/api/widgets/${widgetId}`).send({ config: { limit: 3 } });

    const before = widgetCacheStats();
    await agent.get(`/api/dashboards/${dashboardId}/data`);

    expect(widgetCacheStats().misses).toBe(before.misses + 1);
  });

  it('404s for a dashboard that does not exist', async () => {
    expect((await agent.get('/api/dashboards/9999/data')).status).toBe(404);
  });
});

describe('POST /api/widgets/:id/data', () => {
  it('refreshes one widget without touching the others', async () => {
    const dashboardId = await makeDashboard();
    const first = await makeWidget(dashboardId);
    await makeWidget(dashboardId, { title: 'Second' });

    const res = await agent.post(`/api/widgets/${first}/data`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.widgets)).toEqual([String(first)]);
  });
});

describe('GET /api/widget-types', () => {
  it('offers every type this build can render, custom_api included', async () => {
    const res = await agent.get('/api/widget-types');
    const types = res.body.data.map((entry: { type: string }) => entry.type);

    expect(types).toContain('feed');
    // Withheld until Phase 6, because offering a type the client cannot render
    // would let a user add a widget that only ever shows an error.
    expect(types).toContain('custom_api');
  });

  it('reports geometry and a default config for each type', async () => {
    const res = await agent.get('/api/widget-types');
    const feed = res.body.data.find((entry: { type: string }) => entry.type === 'feed');

    expect(feed.defaultSize).toEqual({ w: 4, h: 8 });
    expect(feed.minSize).toEqual({ w: 3, h: 4 });
    expect(feed.defaultConfig.limit).toBe(15);
  });
});
