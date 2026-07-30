import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, closeDatabase, resetDatabase } from './helpers.js';
import { fixture } from '../helpers/fixtures.js';

beforeEach(resetDatabase);
afterAll(closeDatabase);

const OPML = fixture('opml', 'nested-folders.opml');

describe('POST /api/sources/import', () => {
  it('creates a source per feed and a tag per folder', async () => {
    const res = await request(app).post('/api/sources/import').send({ opml: OPML });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      created: 5,
      alreadyTracked: 0,
      failed: [],
      skippedOutlines: 1,
    });

    const sources = await request(app).get('/api/sources');
    expect(sources.body.data).toHaveLength(5);

    const tags = await request(app).get('/api/tags');
    expect(tags.body.data.map((t: { name: string }) => t.name).sort()).toEqual([
      'Digests',
      'Infrastructure',
      'Networking',
      'Storage',
      'Weekly',
    ]);
  });

  it('attaches the folder tags to the right sources', async () => {
    await request(app).post('/api/sources/import').send({ opml: OPML });

    const sources = await request(app).get('/api/sources?q=Nutanix');
    expect(sources.body.data[0].tags.map((t: { name: string }) => t.name).sort()).toEqual([
      'Infrastructure',
      'Storage',
    ]);
  });

  it('accepts a raw OPML upload as well as a JSON envelope', async () => {
    const res = await request(app)
      .post('/api/sources/import')
      .set('Content-Type', 'application/xml')
      .send(OPML);

    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(5);
  });

  it('re-importing the same file is a no-op, not an error', async () => {
    await request(app).post('/api/sources/import').send({ opml: OPML });
    const second = await request(app).post('/api/sources/import').send({ opml: OPML });

    expect(second.status).toBe(201);
    expect(second.body.data).toMatchObject({ created: 0, alreadyTracked: 5 });
    expect((await request(app).get('/api/sources')).body.data).toHaveLength(5);
  });

  it('applies extra tags on top of the folder tags', async () => {
    const imported = await request(app).post('/api/tags').send({ name: 'Imported' });

    await request(app)
      .post('/api/sources/import')
      .send({ opml: OPML, tagIds: [imported.body.data.id] });

    const sources = await request(app).get(`/api/sources?tag=${imported.body.data.id}`);
    expect(sources.body.data).toHaveLength(5);
  });

  it('can skip folder tags entirely', async () => {
    await request(app)
      .post('/api/sources/import')
      .send({ opml: OPML, importCategoriesAsTags: false });

    expect((await request(app).get('/api/tags')).body.data).toEqual([]);
    expect((await request(app).get('/api/sources')).body.data).toHaveLength(5);
  });

  it('rejects a document with no feeds', async () => {
    const res = await request(app)
      .post('/api/sources/import')
      .send({ opml: '<opml><body></body></opml>' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/no feeds/i);
  });

  it('rejects unknown tag ids', async () => {
    const res = await request(app)
      .post('/api/sources/import')
      .send({ opml: OPML, tagIds: [9999] });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/sources/export', () => {
  it('round-trips an import through an export', async () => {
    await request(app).post('/api/sources/import').send({ opml: OPML });

    const exported = await request(app).get('/api/sources/export');

    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('opml');
    expect(exported.headers['content-disposition']).toContain('feedhub-sources.opml');

    // Re-import into an empty database and the same five sources come back with
    // the same tags.
    await resetDatabase();
    const reimported = await request(app).post('/api/sources/import').send({ opml: exported.text });

    expect(reimported.body.data.created).toBe(5);

    const nutanix = await request(app).get('/api/sources?q=Nutanix');
    expect(nutanix.body.data[0].tags.map((t: { name: string }) => t.name).sort()).toEqual([
      'Infrastructure',
      'Storage',
    ]);
    expect(nutanix.body.data[0].siteUrl).toBe('https://www.nutanix.com/blog');
  });

  it('reports how many sources have no OPML representation', async () => {
    await request(app)
      .post('/api/sources')
      .send({ kind: 'rss', identifier: 'https://a.example/feed.xml', title: 'A' });
    await request(app)
      .post('/api/sources')
      .send({ kind: 'reddit', identifier: 'ceph', title: 'r/ceph', active: false });

    const exported = await request(app).get('/api/sources/export');

    // A subreddit has no xmlUrl, so it is reported rather than silently dropped.
    expect(exported.headers['x-feedhub-skipped-sources']).toBe('1');
    expect(exported.text).toContain('https://a.example/feed.xml');
    expect(exported.text).not.toContain('r/ceph');
  });

  it('produces a valid empty document when there is nothing to export', async () => {
    const exported = await request(app).get('/api/sources/export');
    expect(exported.status).toBe(200);
    expect(exported.text).toContain('<opml version="2.0">');
  });
});
