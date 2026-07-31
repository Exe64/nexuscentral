/**
 * `custom_api` against a real HTTP target: the real fetch, the real mapping, the
 * real cache.
 *
 * Phase 6's fourth acceptance criterion -- a widget pointed at 169.254.169.254 is
 * rejected -- is *not* here, and deliberately so: the test target listens on
 * loopback, so this config has to allow private ranges for anything to be
 * testable at all. That criterion is proven twice elsewhere, in
 * test/customapi/ssrf.test.ts against every blocked range with DNS mocked, and
 * end to end against the built production image where nothing is allowed.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearCustomApiCache } from '../../src/customapi/cache.js';
import { clearWidgetCache } from '../../src/widgets/cache.js';
import { agent, closeDatabase, resetDatabase } from './helpers.js';

let server: Server;
let port = 0;

/** Set per test to decide what the target does. */
let handler: (url: string) => { status: number; body: string; headers?: Record<string, string> };

const RELEASES = [
  {
    name: 'v2.1.0',
    html_url: 'https://example.com/v2.1.0',
    tag_name: 'v2.1.0',
    published_at: '2026-07-01T10:00:00Z',
  },
  {
    name: 'v2.0.0',
    html_url: 'https://example.com/v2.0.0',
    tag_name: 'v2.0.0',
    published_at: '2026-06-01T10:00:00Z',
  },
];

let lastRequest: { url: string; headers: Record<string, string | string[] | undefined> } | null =
  null;

beforeAll(async () => {
  server = createServer((req, res) => {
    lastRequest = { url: req.url ?? '', headers: req.headers };
    const result = handler(req.url ?? '');
    res.writeHead(result.status, { 'content-type': 'application/json', ...result.headers });
    res.end(result.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  clearCustomApiCache();
  // Both caches. The dashboard one is keyed on (widget id, config, last
  // ingestion) -- and TRUNCATE RESTART IDENTITY hands the next test widget id 1
  // again, with no items, so the key repeats and test N reads test N-1's payload.
  clearWidgetCache();
  lastRequest = null;
  handler = () => ({ status: 200, body: JSON.stringify(RELEASES) });
});

/**
 * The target listens on loopback, which the guard exists to block, so the
 * integration config sets ALLOW_PRIVATE_TARGETS. `env` is parsed once at import
 * time, so a test cannot flip it back -- the guard's rejections are proven in
 * test/customapi/ssrf.test.ts and again end to end against the built image.
 */
const local = (path = '/releases'): string => `http://127.0.0.1:${port}${path}`;

const MAPPING = {
  root: '$',
  fields: {
    title: '$.name',
    url: '$.html_url',
    subtitle: '$.tag_name',
    timestamp: '$.published_at',
  },
};

describe('POST /api/custom-api/preview', () => {
  it('fetches and maps a real response', async () => {
    const res = await agent
      .post('/api/custom-api/preview')
      .send({ url: local(), mapping: MAPPING });

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.matched).toBe(2);
    expect(res.body.data.items[0]).toEqual({
      title: 'v2.1.0',
      url: 'https://example.com/v2.1.0',
      subtitle: 'v2.1.0',
      timestamp: '2026-07-01T10:00:00.000Z',
    });
  });

  it('sends params as query string and headers as headers', async () => {
    await agent.post('/api/custom-api/preview').send({
      url: local(),
      params: { per_page: '5' },
      headers: { 'x-test': 'yes' },
      mapping: MAPPING,
    });

    expect(lastRequest?.url).toContain('per_page=5');
    expect(lastRequest?.headers['x-test']).toBe('yes');
  });

  it('refuses to let a widget set the Host header', async () => {
    // Host control is the other half of an SSRF: connect here, present as there.
    await agent.post('/api/custom-api/preview').send({
      url: local(),
      headers: { Host: 'evil.example.com' },
      mapping: MAPPING,
    });

    expect(lastRequest?.headers.host).toContain('127.0.0.1');
  });

  it('shows what the root selected when nothing mapped', async () => {
    const res = await agent
      .post('/api/custom-api/preview')
      .send({ url: local(), mapping: { root: '$.nope', fields: MAPPING.fields } });

    expect(res.body.data.matched).toBe(0);
    expect(res.body.data.items).toEqual([]);
    // The only feedback jsonpath-plus makes possible: it does not validate paths.
    expect(res.body.data).toHaveProperty('rootSample');
  });

  it('reports the environment variables a spec needs', async () => {
    process.env.NC_TEST_TOKEN = 'secret-value';
    try {
      const res = await agent.post('/api/custom-api/preview').send({
        url: local(),
        headers: { authorization: 'Bearer ${NC_TEST_TOKEN}' },
        mapping: MAPPING,
      });

      expect(res.body.data.variables).toEqual(['NC_TEST_TOKEN']);
      expect(lastRequest?.headers.authorization).toBe('Bearer secret-value');
      // The value itself is never echoed back.
      expect(JSON.stringify(res.body)).not.toContain('secret-value');
    } finally {
      delete process.env.NC_TEST_TOKEN;
    }
  });

  it('fails at preview time when a variable is missing', async () => {
    const res = await agent.post('/api/custom-api/preview').send({
      url: local(),
      headers: { authorization: 'Bearer ${NC_DEFINITELY_UNSET}' },
      mapping: MAPPING,
    });

    // The spec wants this at save time, not at render time three days later.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('NC_DEFINITELY_UNSET');
  });

  it('reports a target that answers an error', async () => {
    handler = () => ({ status: 503, body: '{"message":"down for maintenance"}' });

    const res = await agent
      .post('/api/custom-api/preview')
      .send({ url: local(), mapping: MAPPING });

    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain('503');
    expect(res.body.error.message).toContain('maintenance');
  });

  it('reports a response that is not JSON', async () => {
    handler = () => ({ status: 200, body: '<html>hello</html>' });

    const res = await agent
      .post('/api/custom-api/preview')
      .send({ url: local(), mapping: MAPPING });

    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain('not JSON');
  });

  it('refuses a response larger than the cap', async () => {
    // Six megabytes of valid JSON, over the five megabyte limit.
    handler = () => ({ status: 200, body: JSON.stringify([{ name: 'x'.repeat(6_000_000) }]) });

    const res = await agent
      .post('/api/custom-api/preview')
      .send({ url: local(), mapping: MAPPING });

    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/exceeded 5 MB/);
  });
});

describe('the guard is still wired in', () => {
  it('rejects a non-http scheme regardless of the private-range setting', async () => {
    const res = await agent
      .post('/api/custom-api/preview')
      .send({ url: 'file:///etc/passwd', mapping: MAPPING });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('http and https');
  });

  it('rejects credentials in the URL', async () => {
    const res = await agent
      .post('/api/custom-api/preview')
      .send({ url: 'https://user:pass@example.com/', mapping: MAPPING });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('credentials');
  });

  it('follows a redirect by hand, so every hop goes back through the guard', async () => {
    handler = (url) =>
      url.startsWith('/hop')
        ? { status: 302, body: '', headers: { location: local('/releases') } }
        : { status: 200, body: JSON.stringify(RELEASES) };

    const res = await agent
      .post('/api/custom-api/preview')
      .send({ url: local('/hop'), mapping: MAPPING });

    expect(res.body.data.ok).toBe(true);
    // The reported URL is where it ended up, not where it was asked to go.
    expect(String(res.body.data.finalUrl)).toContain('/releases');
  });

  it('needs authentication like everything else', async () => {
    const { default: request } = await import('supertest');
    const { app } = await import('./helpers.js');

    const res = await request(app).post('/api/custom-api/preview').send({ url: local() });
    expect(res.status).toBe(401);
  });
});

describe('the custom_api widget', () => {
  async function makeWidget(config: Record<string, unknown>): Promise<number> {
    const dashboard = await agent.post('/api/dashboards').send({ name: 'Home' });
    const res = await agent.post('/api/widgets').send({
      dashboardId: dashboard.body.data.id,
      type: 'custom_api',
      title: 'Releases',
      config,
    });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  }

  it('can now be created, and resolves through the dashboard', async () => {
    // Until Phase 6 the API refused this type outright.
    const widgetId = await makeWidget({
      url: local(),
      mapping: MAPPING,
      render: 'list',
      ttlMinutes: 30,
    });

    const res = await agent.post(`/api/widgets/${widgetId}/data`);

    expect(res.status).toBe(200);
    const payload = res.body.widgets[String(widgetId)];
    expect(payload.status).toBe('ok');
    expect(payload.data.items).toHaveLength(2);
    expect(payload.data.render).toBe('list');
  });

  it('serves the second render from its own cache', async () => {
    let calls = 0;
    handler = () => {
      calls += 1;
      return { status: 200, body: JSON.stringify(RELEASES) };
    };

    const widgetId = await makeWidget({
      url: local(),
      mapping: MAPPING,
      render: 'list',
      ttlMinutes: 30,
    });

    await agent.post(`/api/widgets/${widgetId}/data`);
    await agent.post(`/api/widgets/${widgetId}/data`);

    // Polling a third party once per dashboard render would be rude and slow.
    expect(calls).toBe(1);
  });

  it('reports a failing target as a widget error, not a dead dashboard', async () => {
    handler = () => ({ status: 500, body: '{}' });

    const widgetId = await makeWidget({
      url: local(),
      mapping: MAPPING,
      render: 'list',
      ttlMinutes: 30,
    });

    const res = await agent.post(`/api/widgets/${widgetId}/data`);

    expect(res.status).toBe(200);
    expect(res.body.widgets[String(widgetId)].status).toBe('error');
  });

  it('rejects a config with no URL at the boundary', async () => {
    const dashboard = await agent.post('/api/dashboards').send({ name: 'Home' });
    const res = await agent.post('/api/widgets').send({
      dashboardId: dashboard.body.data.id,
      type: 'custom_api',
      title: 'Broken',
      config: { url: '', mapping: MAPPING },
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/widget-types', () => {
  it('now offers custom_api', async () => {
    const res = await agent.get('/api/widget-types');
    const types = res.body.data.map((entry: { type: string }) => entry.type);
    expect(types).toContain('custom_api');
  });
});
