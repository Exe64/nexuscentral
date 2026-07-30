import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, closeDatabase, resetDatabase, scalar } from './helpers.js';
import { fixture } from '../helpers/fixtures.js';
import { stubFetch } from '../helpers/stub-fetch.js';

const XML = { 'content-type': 'application/rss+xml' };
const HTML = { 'content-type': 'text/html; charset=utf-8' };
const FEED_URL = 'https://www.nutanix.com/blog/rss.xml';

let restore: (() => void) | undefined;

beforeEach(resetDatabase);
afterEach(() => {
  restore?.();
  restore = undefined;
});
afterAll(closeDatabase);

describe('POST /api/sources/resolve', () => {
  it('turns a pasted blog homepage into a candidate with three real items', async () => {
    // This is the acceptance criterion for adding a source: paste a homepage,
    // see real items before committing.
    const pageUrl = 'https://www.nutanix.com/blog';
    const stub = stubFetch({
      [pageUrl]: { body: fixture('rss', 'discovery-page.html'), headers: HTML },
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
      'https://www.nutanix.com/blog/comments/atom.xml': {
        body: fixture('rss', 'atom-relative-links.xml'),
        headers: XML,
      },
    });
    restore = stub.restore;

    const res = await request(app).post('/api/sources/resolve').send({ input: pageUrl });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(2);

    const [main] = res.body.candidates;
    expect(main).toMatchObject({
      kind: 'rss',
      identifier: FEED_URL,
      title: 'Nutanix Blog',
      existingSourceId: null,
    });
    expect(main.sampleItems).toHaveLength(3);
    expect(main.sampleItems[0]).toMatchObject({
      title: 'Announcing AOS 7.2',
      url: 'https://www.nutanix.com/blog/announcing-aos-7-2',
      publishedAt: '2026-07-28T09:00:00.000Z',
    });
  });

  it('flags a candidate that is already tracked so the UI can offer to open it', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
    });
    restore = stub.restore;

    const created = await request(app)
      .post('/api/sources')
      .send({ kind: 'rss', identifier: FEED_URL, title: 'Nutanix Blog' });

    const res = await request(app).post('/api/sources/resolve').send({ input: FEED_URL });

    expect(res.body.candidates[0].existingSourceId).toBe(created.body.data.id);
  });

  it('reports UPSTREAM_FAILED, not 500, when nothing resolves', async () => {
    const pageUrl = 'https://barren.example.org/';
    const stub = stubFetch({
      [pageUrl]: { body: '<html><head><title>Barren</title></head></html>', headers: HTML },
      'https://barren.example.org/feed': { status: 404, body: '' },
      'https://barren.example.org/rss': { status: 404, body: '' },
      'https://barren.example.org/index.xml': { status: 404, body: '' },
      'https://barren.example.org/atom.xml': { status: 404, body: '' },
    });
    restore = stub.restore;

    const res = await request(app).post('/api/sources/resolve').send({ input: pageUrl });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_FAILED');
    expect(res.body.error.details.detectedKind).toBe('rss');
  });

  it('detects a subreddit and explains that the adapter is not in this build', async () => {
    const res = await request(app).post('/api/sources/resolve').send({ input: 'r/nutanix' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/reddit/i);
  });

  it('detects an X handle rather than falling through to RSS', async () => {
    const res = await request(app).post('/api/sources/resolve').send({ input: '@nutanix' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/nitter/i);
  });

  it('rejects an empty input', async () => {
    const res = await request(app).post('/api/sources/resolve').send({ input: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sources', () => {
  it('creates a source with tags and a normalised poll interval', async () => {
    const tag = await request(app).post('/api/tags').send({ name: 'Storage' });

    const res = await request(app)
      .post('/api/sources')
      .send({
        kind: 'rss',
        identifier: FEED_URL,
        title: 'Nutanix Blog',
        siteUrl: 'https://www.nutanix.com/blog',
        tagIds: [tag.body.data.id],
        weight: 1.5,
        pollInterval: '30 minutes',
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: 'rss',
      identifier: FEED_URL,
      title: 'Nutanix Blog',
      weight: 1.5,
      pollInterval: '30 minutes',
      active: true,
    });
    expect(res.body.data.tags).toHaveLength(1);
    expect(res.body.data.health).toMatchObject({
      consecutiveFailures: 0,
      consecutiveEmpty: 0,
      lastError: null,
    });
  });

  it('normalises a reddit identifier to a bare lowercase name', async () => {
    const res = await request(app)
      .post('/api/sources')
      .send({ kind: 'reddit', identifier: '/r/Nutanix', title: 'r/nutanix', active: false });

    expect(res.body.data.identifier).toBe('nutanix');
  });

  it('reports a duplicate identity as 409 with the existing id', async () => {
    const first = await request(app)
      .post('/api/sources')
      .send({ kind: 'rss', identifier: FEED_URL, title: 'A' });

    const second = await request(app)
      .post('/api/sources')
      .send({ kind: 'rss', identifier: FEED_URL, title: 'B' });

    expect(second.status).toBe(409);
    expect(second.body.error.details.existingId).toBe(first.body.data.id);
  });

  it('rejects unknown tag ids before touching a foreign key', async () => {
    const res = await request(app)
      .post('/api/sources')
      .send({ kind: 'rss', identifier: FEED_URL, title: 'A', tagIds: [9998, 9999] });

    expect(res.status).toBe(400);
    expect(res.body.error.details.tagIds).toEqual([9998, 9999]);
  });

  it('refuses a poll interval that would hammer the source', async () => {
    const res = await request(app)
      .post('/api/sources')
      .send({ kind: 'rss', identifier: FEED_URL, title: 'A', pollInterval: '1 minute' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/at least 5 minutes/i);
  });

  it('explains an unrecognised interval unit instead of guessing', async () => {
    const res = await request(app)
      .post('/api/sources')
      .send({ kind: 'rss', identifier: FEED_URL, title: 'A', pollInterval: '30 fortnights' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/minutes, hours or days/i);
  });
});

describe('GET /api/sources', () => {
  beforeEach(async () => {
    const storage = await request(app).post('/api/tags').send({ name: 'Storage' });
    await request(app)
      .post('/api/sources')
      .send({
        kind: 'rss',
        identifier: 'https://a.example.com/feed.xml',
        title: 'Alpha Blog',
        tagIds: [storage.body.data.id],
      });
    await request(app).post('/api/sources').send({
      kind: 'rss',
      identifier: 'https://b.example.com/feed.xml',
      title: 'Beta Blog',
    });
    await request(app).post('/api/sources').send({
      kind: 'reddit',
      identifier: 'ceph',
      title: 'r/ceph',
      active: false,
    });
  });

  it('lists every source alphabetically with its tags denormalised', async () => {
    const res = await request(app).get('/api/sources');

    expect(res.body.data.map((s: { title: string }) => s.title)).toEqual([
      'Alpha Blog',
      'Beta Blog',
      'r/ceph',
    ]);
    expect(res.body.data[0].tags[0].name).toBe('Storage');
  });

  it('filters by kind, active flag, tag and free text', async () => {
    const byKind = await request(app).get('/api/sources?kind=reddit');
    expect(byKind.body.data).toHaveLength(1);

    const byActive = await request(app).get('/api/sources?active=false');
    expect(byActive.body.data.map((s: { title: string }) => s.title)).toEqual(['r/ceph']);

    const tags = await request(app).get('/api/tags');
    const byTag = await request(app).get(`/api/sources?tag=${tags.body.data[0].id}`);
    expect(byTag.body.data.map((s: { title: string }) => s.title)).toEqual(['Alpha Blog']);

    // Free text matches the identifier as well as the title.
    const byUrl = await request(app).get('/api/sources?q=b.example.com');
    expect(byUrl.body.data.map((s: { title: string }) => s.title)).toEqual(['Beta Blog']);
  });
});

describe('PATCH /api/sources/:id', () => {
  it('replaces the tag set rather than merging it', async () => {
    const a = await request(app).post('/api/tags').send({ name: 'Alpha' });
    const b = await request(app).post('/api/tags').send({ name: 'Beta' });

    const source = await request(app)
      .post('/api/sources')
      .send({
        kind: 'rss',
        identifier: FEED_URL,
        title: 'A',
        tagIds: [a.body.data.id],
      });

    const res = await request(app)
      .patch(`/api/sources/${source.body.data.id}`)
      .send({ tagIds: [b.body.data.id] });

    expect(res.body.data.tags.map((t: { name: string }) => t.name)).toEqual(['Beta']);
  });

  it('clears the failure backoff when a source is re-activated', async () => {
    const source = await request(app)
      .post('/api/sources')
      .send({ kind: 'rss', identifier: FEED_URL, title: 'A' });
    const id: number = source.body.data.id;

    // Simulate the auto-deactivation the scheduler performs at 10 failures.
    await scalar(
      `UPDATE sources SET active = false, consecutive_failures = 10, last_error = 'boom'
        WHERE id = $1 RETURNING id`,
      [id],
    );

    const res = await request(app).patch(`/api/sources/${id}`).send({ active: true });

    // Without this, the source would immediately look overdue by a factor of 8.
    expect(res.body.data.health).toMatchObject({ consecutiveFailures: 0, lastError: null });
    expect(res.body.data.active).toBe(true);
  });

  it('404s for an unknown source', async () => {
    const res = await request(app).patch('/api/sources/9999').send({ title: 'Nope' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/sources/:id', () => {
  it('removes the source and its items', async () => {
    // Deleting a source removes its history -- that is intended.
    const source = await request(app)
      .post('/api/sources')
      .send({ kind: 'rss', identifier: FEED_URL, title: 'A' });
    const id: number = source.body.data.id;

    await scalar(
      `INSERT INTO items (source_id, content_hash, url, title, published_at)
       VALUES ($1, sha256('a'), 'https://x/1', 'One', now()),
              ($1, sha256('b'), 'https://x/2', 'Two', now())
       RETURNING id`,
      [id],
    );
    expect(await scalar<number>(`SELECT count(*)::int FROM items`)).toBe(2);

    const res = await request(app).delete(`/api/sources/${id}`);

    expect(res.status).toBe(204);
    expect(await scalar<number>(`SELECT count(*)::int FROM items`)).toBe(0);
    expect(await scalar<number>(`SELECT count(*)::int FROM sources`)).toBe(0);
  });

  it('404s for an unknown source', async () => {
    expect((await request(app).delete('/api/sources/9999')).status).toBe(404);
  });
});

describe('POST /api/sources/:id/poll', () => {
  it('reports that nothing was queued when the worker is not running', async () => {
    const source = await request(app)
      .post('/api/sources')
      .send({ kind: 'rss', identifier: FEED_URL, title: 'A' });

    const res = await request(app).post(`/api/sources/${source.body.data.id}/poll`);

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ queued: false });
  });

  it('404s for an unknown source', async () => {
    expect((await request(app).post('/api/sources/9999/poll')).status).toBe(404);
  });
});
