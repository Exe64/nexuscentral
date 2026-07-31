import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';
import { fixture } from '../helpers/fixtures.js';
import { stubFetch } from '../helpers/stub-fetch.js';
import { query } from '../../src/db/pool.js';
import { pollSource } from '../../src/ingest/runner.js';
import { redditBudget } from '../../src/adapters/reddit/budget.js';
import { redditTokenCache, TOKEN_URL } from '../../src/adapters/reddit/auth.js';
import { OAUTH_BASE } from '../../src/adapters/reddit/client.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const XML = { 'content-type': 'application/rss+xml' };
const RATE_HEADERS = {
  ...JSON_HEADERS,
  'x-ratelimit-used': '4',
  'x-ratelimit-remaining': '596',
  'x-ratelimit-reset': '540',
};

const TOKEN_ROUTE = {
  [TOKEN_URL]: { body: fixture('reddit', 'token.json'), headers: JSON_HEADERS },
};

const PRIMARY = 'https://nitter.mydomain.tld';
const BACKUP = 'https://nitter.backup.example.net';

let restore: (() => void) | undefined;

beforeEach(async () => {
  await resetDatabase();
  // Settings live in a singleton row that TRUNCATE removes; put it back and
  // clear anything the previous test configured.
  await query(`INSERT INTO settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING`);
  await query(
    `UPDATE settings SET reddit_client_id = NULL, reddit_client_secret = NULL, nitter_base_urls = '{}'`,
  );
  redditTokenCache.invalidate();
  redditBudget.reset();
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

afterAll(closeDatabase);

async function configureReddit(): Promise<void> {
  const res = await agent
    .patch('/api/settings')
    .send({ redditClientId: 'client-abc', redditClientSecret: 'secret-xyz' });
  if (res.status !== 200) throw new Error(`Configuring Reddit failed: ${JSON.stringify(res.body)}`);
}

async function configureNitter(urls: string[]): Promise<void> {
  const res = await agent.patch('/api/settings').send({ nitterBaseUrls: urls });
  if (res.status !== 200) throw new Error(`Configuring Nitter failed: ${JSON.stringify(res.body)}`);
}

describe('GET /api/settings', () => {
  it('never returns the secret, only whether one is configured', async () => {
    await configureReddit();

    const res = await agent.get('/api/settings');

    expect(res.status).toBe(200);
    expect(res.body.data.reddit).toEqual({
      configured: true,
      origin: 'settings',
      envOverridesSettings: false,
    });
    // Not the id either -- and certainly not the secret.
    expect(JSON.stringify(res.body)).not.toContain('secret-xyz');
    expect(JSON.stringify(res.body)).not.toContain('redditClientSecret');
  });

  it('reports Reddit as unconfigured when nothing is set', async () => {
    const res = await agent.get('/api/settings');
    expect(res.body.data.reddit).toMatchObject({ configured: false, origin: null });
  });

  it('reports where the Nitter list came from', async () => {
    // Nothing saved: the environment default applies, which is empty in tests.
    const before = await agent.get('/api/settings');
    expect(before.body.data.nitterBaseUrlsOrigin).toBe('env');
    expect(before.body.data.nitterBaseUrls).toEqual([]);

    await configureNitter([PRIMARY]);

    const after = await agent.get('/api/settings');
    expect(after.body.data.nitterBaseUrlsOrigin).toBe('settings');
    expect(after.body.data.nitterBaseUrls).toEqual([PRIMARY]);
  });
});

describe('PATCH /api/settings', () => {
  it('leaves a stored secret alone when the field is absent', async () => {
    await configureReddit();
    await agent.patch('/api/settings').send({ itemsRetentionDays: 30 });

    expect(await scalar<string>(`SELECT reddit_client_secret FROM settings`)).toBe('secret-xyz');
  });

  it('clears a secret when an explicit null is sent', async () => {
    await configureReddit();
    await agent.patch('/api/settings').send({ redditClientId: null, redditClientSecret: null });

    expect(await scalar<string | null>(`SELECT reddit_client_secret FROM settings`)).toBeNull();
    expect((await agent.get('/api/settings')).body.data.reddit.configured).toBe(false);
  });

  it('treats an empty string as a clear, so a blanked field is not stored', async () => {
    await configureReddit();
    await agent.patch('/api/settings').send({ redditClientSecret: '   ' });

    expect(await scalar<string | null>(`SELECT reddit_client_secret FROM settings`)).toBeNull();
  });

  it('rejects a delivery target with no webhook URL', async () => {
    const res = await agent.patch('/api/settings').send({ alertWebhookKind: 'ntfy' });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toHaveProperty('alertWebhookUrl');
  });

  it('rejects a non-absolute Nitter URL', async () => {
    const res = await agent.patch('/api/settings').send({ nitterBaseUrls: ['not-a-url'] });
    expect(res.status).toBe(400);
  });

  it('rejects an empty patch', async () => {
    expect((await agent.patch('/api/settings').send({})).status).toBe(400);
  });
});

describe('POST /api/settings/test-reddit', () => {
  it('answers 200 with ok:false when nothing is configured', async () => {
    const res = await agent.post('/api/settings/test-reddit');

    // "Are these credentials good?" was answered successfully. The answer is no.
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: false, reason: 'not_configured' });
  });

  it('reports success and the budget state', async () => {
    await configureReddit();
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/api/v1/me?raw_json=1`]: {
        body: '{"name":"nexuscentral"}',
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const res = await agent.post('/api/settings/test-reddit');

    expect(res.body.data).toMatchObject({ ok: true, origin: 'settings' });
    expect(res.body.data.budget).toMatchObject({ remaining: 596, limit: 600 });
  });

  it('distinguishes rejected credentials from an upstream problem', async () => {
    await configureReddit();

    const rejected = stubFetch({
      [TOKEN_URL]: { status: 401, body: '{"error":"invalid_client"}', headers: JSON_HEADERS },
    });
    restore = rejected.restore;
    const bad = await agent.post('/api/settings/test-reddit');
    expect(bad.body.data).toMatchObject({ ok: false, reason: 'rejected' });
    rejected.restore();

    const broken = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/api/v1/me?raw_json=1`]: { status: 503, body: '{}', headers: RATE_HEADERS },
    });
    restore = broken.restore;
    redditTokenCache.invalidate();
    const down = await agent.post('/api/settings/test-reddit');
    expect(down.body.data).toMatchObject({ ok: false, reason: 'upstream' });
  });
});

describe('POST /api/settings/test-nitter', () => {
  it('reports every instance, not just the first that works', async () => {
    await configureNitter([PRIMARY, BACKUP]);
    const stub = stubFetch({
      [`${PRIMARY}/nasa/rss`]: { body: fixture('nitter', 'timeline.xml'), headers: XML },
      [`${BACKUP}/nasa/rss`]: { body: fixture('nitter', 'timeline-empty.xml'), headers: XML },
    });
    restore = stub.restore;

    const res = await agent.post('/api/settings/test-nitter');

    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.instances).toHaveLength(2);
    expect(res.body.data.instances[0]).toMatchObject({ baseUrl: PRIMARY, ok: true, itemCount: 3 });
    // A well-formed empty feed is a failure, which is the whole point.
    expect(res.body.data.instances[1]).toMatchObject({ baseUrl: BACKUP, ok: false });
  });

  it('reports not_configured with no instances', async () => {
    const res = await agent.post('/api/settings/test-nitter');
    expect(res.body.data).toMatchObject({ ok: false, reason: 'not_configured', instances: [] });
  });
});

describe('creating a source of a kind that cannot be polled yet', () => {
  it('creates a Reddit source inactive and records why', async () => {
    // The acceptance criterion: with credentials absent, Reddit sources are
    // created inactive and the UI can explain it.
    const res = await agent
      .post('/api/sources')
      .send({ kind: 'reddit', identifier: 'r/nutanix', title: 'r/nutanix' });

    expect(res.status).toBe(201);
    expect(res.body.data.active).toBe(false);
    expect(res.body.data.identifier).toBe('nutanix');
    // The UI renders health.lastError, so this is how the source explains itself.
    expect(res.body.data.health.lastError).toMatch(/credentials are not configured/i);
    expect(res.body.data.health.lastError).toMatch(/Settings/);
  });

  it('creates a Reddit source active once credentials exist', async () => {
    await configureReddit();
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const res = await agent
      .post('/api/sources')
      .send({ kind: 'reddit', identifier: 'nutanix', title: 'r/nutanix' });

    expect(res.body.data.active).toBe(true);
    expect(res.body.data.health.lastError).toBeNull();
  });

  it('creates an X source inactive with no Nitter instance', async () => {
    const res = await agent
      .post('/api/sources')
      .send({ kind: 'nitter', identifier: '@nutanix', title: '@nutanix' });

    expect(res.body.data.active).toBe(false);
    expect(res.body.data.identifier).toBe('nutanix');
    expect(res.body.data.health.lastError).toMatch(/No Nitter instance/i);
  });

  it('explains the same thing when resolving instead of creating', async () => {
    const res = await agent.post('/api/sources/resolve').send({ input: 'r/nutanix' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toMatchObject({ kind: 'reddit', configured: false });
  });
});

describe('polling a Reddit source', () => {
  async function createRedditSource(): Promise<number> {
    await configureReddit();
    const res = await agent
      .post('/api/sources')
      .send({ kind: 'reddit', identifier: 'nutanix', title: 'r/nutanix' });
    return res.body.data.id as number;
  }

  it('ingests a listing and stores the fullname for the next cursor', async () => {
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
    });
    restore = stub.restore;

    const sourceId = await createRedditSource();
    const outcome = await pollSource(sourceId);

    expect(outcome).toMatchObject({ status: 'ok', itemCount: 3, newCount: 3 });

    const items = await agent.get('/api/items');
    expect(items.body.data).toHaveLength(3);
    expect(items.body.data[0].engagementScore).toBe(214);
    expect(items.body.data[0].source.kind).toBe('reddit');

    // The newest fullname by published_at is what the next poll sends as `before`.
    const { newestFullnameForSource } = await import('../../src/db/items.js');
    expect(await newestFullnameForSource(sourceId)).toBe('t3_1p9y77');
  });

  it('sends the cursor on the second poll and leaves the empty counter alone', async () => {
    let call = 0;
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1`]: {
        body: fixture('reddit', 'listing-new.json'),
        headers: RATE_HEADERS,
      },
      [`${OAUTH_BASE}/r/nutanix/new?limit=100&raw_json=1&before=t3_1p9y77`]: () => {
        call += 1;
        return { body: fixture('reddit', 'listing-empty.json'), headers: RATE_HEADERS };
      },
    });
    restore = stub.restore;

    const sourceId = await createRedditSource();
    await pollSource(sourceId);

    // Three quiet polls in a row. A subreddit with nothing new is not a subreddit
    // that has died, so this must not trip the silent-death counter.
    for (let i = 0; i < 3; i += 1) {
      const outcome = await pollSource(sourceId);
      expect(outcome.status).toBe('no_new_items');
      expect(outcome.silentDeath).toBeUndefined();
    }

    expect(call).toBe(3);
    expect(
      await scalar<number>(`SELECT consecutive_empty FROM sources WHERE id = $1`, [sourceId]),
    ).toBe(0);
    expect(
      await scalar<number>(`SELECT consecutive_failures FROM sources WHERE id = $1`, [sourceId]),
    ).toBe(0);
  });

  it('records a clear failure when credentials are removed under a live source', async () => {
    const stub = stubFetch({ ...TOKEN_ROUTE });
    restore = stub.restore;

    const sourceId = await createRedditSource();
    await agent.patch('/api/settings').send({ redditClientId: null, redditClientSecret: null });

    const outcome = await pollSource(sourceId);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/credentials are not configured/i);
  });

  it('stays well inside the rate budget over a realistic polling load', async () => {
    // The acceptance criterion: Reddit sources poll without exceeding 50% of the
    // budget. Twenty subreddits, one request each, against a 600-request window.
    let used = 4;
    const stub = stubFetch({
      ...TOKEN_ROUTE,
      ...Object.fromEntries(
        Array.from({ length: 20 }, (_unused, index) => [
          `${OAUTH_BASE}/r/sub${index}/new?limit=100&raw_json=1`,
          () => {
            used += 1;
            return {
              body: fixture('reddit', 'listing-empty.json'),
              headers: {
                ...JSON_HEADERS,
                'x-ratelimit-used': String(used),
                'x-ratelimit-remaining': String(600 - used),
                'x-ratelimit-reset': '540',
              },
            };
          },
        ]),
      ),
    });
    restore = stub.restore;

    await configureReddit();

    const ids: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const res = await agent
        .post('/api/sources')
        .send({ kind: 'reddit', identifier: `sub${index}`, title: `r/sub${index}` });
      ids.push(res.body.data.id as number);
    }

    for (const id of ids) await pollSource(id);

    const snapshot = redditBudget.snapshot();
    expect(snapshot.limit).toBe(600);
    expect(snapshot.utilisation).not.toBeNull();
    expect(snapshot.utilisation as number).toBeLessThan(0.5);
    // 20 sources, 20 data requests plus one token: about 4% of the window.
    expect(snapshot.utilisation as number).toBeLessThan(0.1);
  });
});

describe('polling an X source through Nitter', () => {
  async function createNitterSource(urls: string[]): Promise<number> {
    await configureNitter(urls);
    const res = await agent
      .post('/api/sources')
      .send({ kind: 'nitter', identifier: 'nutanix', title: '@nutanix' });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.data.id as number;
  }

  it('ingests a timeline with every URL pointing at x.com', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { body: fixture('nitter', 'timeline.xml'), headers: XML },
    });
    restore = stub.restore;

    const sourceId = await createNitterSource([PRIMARY]);
    const outcome = await pollSource(sourceId);

    expect(outcome).toMatchObject({ status: 'ok', itemCount: 3, newCount: 3 });

    const urls = await query<{ url: string }>(`SELECT url FROM items ORDER BY published_at DESC`);
    for (const row of urls.rows) {
      expect(row.url.startsWith('https://x.com/')).toBe(true);
    }
  });

  it('switching instance inserts no duplicates', async () => {
    // The acceptance criterion, end to end through the item store.
    const first = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { body: fixture('nitter', 'timeline.xml'), headers: XML },
    });
    restore = first.restore;

    const sourceId = await createNitterSource([PRIMARY]);
    expect(await pollSource(sourceId)).toMatchObject({ itemCount: 3, newCount: 3 });
    first.restore();

    // The user replaces the instance in Settings.
    await configureNitter([BACKUP]);

    const second = stubFetch({
      [`${BACKUP}/nutanix/rss`]: {
        body: fixture('nitter', 'timeline-other-instance.xml'),
        headers: XML,
      },
    });
    restore = second.restore;

    const outcome = await pollSource(sourceId);

    expect(outcome).toMatchObject({ status: 'ok', itemCount: 3, newCount: 0 });
    expect(await scalar<number>(`SELECT count(*)::int FROM items`)).toBe(3);
  });

  it('raises a health alert after three empty feeds', async () => {
    // The acceptance criterion. HTTP 200 and a well-formed feed every time.
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { body: fixture('nitter', 'timeline-empty.xml'), headers: XML },
    });
    restore = stub.restore;

    const sourceId = await createNitterSource([PRIMARY]);

    const first = await pollSource(sourceId);
    expect(first.status).toBe('empty');
    expect(first.silentDeath).toBeUndefined();

    const second = await pollSource(sourceId);
    expect(second.status).toBe('empty');
    expect(second.silentDeath).toBeUndefined();

    // At three, it stops being a quiet account and starts being a broken instance.
    const third = await pollSource(sourceId);
    expect(third.status).toBe('empty');
    expect(third.silentDeath).toBe(true);

    expect(
      await scalar<number>(`SELECT consecutive_empty FROM sources WHERE id = $1`, [sourceId]),
    ).toBe(3);

    // And it surfaces where the source_health widget reads from. A silently-empty
    // source has zero failures and looked healthy on every run, so it has to be
    // counted separately or the counter buys nothing.
    const health = await agent.get('/api/health');
    expect(health.body.status).toBe('degraded');
    expect(health.body.sources).toMatchObject({ failing: 0, silentlyEmpty: 1 });

    const unhealthy = await agent.get('/api/sources?health=unhealthy');
    expect(unhealthy.body.data).toHaveLength(1);
    expect(unhealthy.body.data[0].health.consecutiveEmpty).toBe(3);
  });

  it('falls back to the next instance without affecting the item store', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { status: 502, body: '' },
      [`${BACKUP}/nutanix/rss`]: {
        body: fixture('nitter', 'timeline-other-instance.xml'),
        headers: XML,
      },
    });
    restore = stub.restore;

    const sourceId = await createNitterSource([PRIMARY, BACKUP]);
    const outcome = await pollSource(sourceId);

    expect(outcome).toMatchObject({ status: 'ok', itemCount: 3 });
  });

  it('records a failure listing every instance when all are down', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { status: 502, body: '' },
      [`${BACKUP}/nutanix/rss`]: { status: 404, body: '' },
    });
    restore = stub.restore;

    const sourceId = await createNitterSource([PRIMARY, BACKUP]);
    const outcome = await pollSource(sourceId);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain(PRIMARY);
    expect(outcome.error).toContain(BACKUP);
  });

  it('does not let a failing X source affect an RSS source', async () => {
    // Nitter is explicitly degradable: its failures must never abort the cycle.
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { status: 502, body: '' },
      'https://blog.example.com/feed.xml': {
        body: fixture('rss', 'rss2-standard.xml'),
        headers: XML,
      },
    });
    restore = stub.restore;

    const nitterId = await createNitterSource([PRIMARY]);
    const rss = await agent
      .post('/api/sources')
      .send({ kind: 'rss', identifier: 'https://blog.example.com/feed.xml', title: 'Blog' });

    const [nitterOutcome, rssOutcome] = await Promise.all([
      pollSource(nitterId),
      pollSource(rss.body.data.id as number),
    ]);

    expect(nitterOutcome.status).toBe('failed');
    expect(rssOutcome).toMatchObject({ status: 'ok', itemCount: 4, newCount: 4 });
  });
});

describe('GET /api/health', () => {
  it('reports source counts, the Reddit budget and queue depth', async () => {
    const res = await agent.get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      db: { reachable: true },
      sources: { total: 0, active: 0, failing: 0, stale: 0 },
      reddit: { configured: false },
      queue: { pending: 0, failed: 0 },
      lastPollAt: null,
    });
  });

  it('degrades when a source is failing', async () => {
    const stub = stubFetch({ 'https://dead.example.com/feed.xml': { status: 500, body: '' } });
    restore = stub.restore;

    const source = await agent
      .post('/api/sources')
      .send({ kind: 'rss', identifier: 'https://dead.example.com/feed.xml', title: 'Dead' });
    await pollSource(source.body.data.id as number);

    const res = await agent.get('/api/health');
    expect(res.body.status).toBe('degraded');
    expect(res.body.sources).toMatchObject({ total: 1, failing: 1 });
    expect(res.body.lastPollAt).not.toBeNull();
  });
});
