import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, closeDatabase, resetDatabase, scalar } from './helpers.js';

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('POST /api/tags', () => {
  it('creates a tag and derives the slug server-side', async () => {
    const res = await request(app)
      .post('/api/tags')
      .send({ name: 'Cloud Native & Storage', color: 'teal' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Cloud Native & Storage',
      slug: 'cloud-native-storage',
      color: 'teal',
    });
  });

  it('ignores a client-supplied slug', async () => {
    const res = await request(app)
      .post('/api/tags')
      .send({ name: 'Kubernetes', slug: 'attacker-controlled' });

    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe('kubernetes');
  });

  it('defaults the colour to neutral', async () => {
    const res = await request(app).post('/api/tags').send({ name: 'Storage' });
    expect(res.body.data.color).toBe('neutral');
  });

  it('rejects an unknown colour with field-level detail and no stack trace', async () => {
    const res = await request(app).post('/api/tags').send({ name: 'X', color: 'chartreuse' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toHaveProperty('color');
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });

  it('rejects a name that cannot produce a slug', async () => {
    const res = await request(app).post('/api/tags').send({ name: '!!!' });
    expect(res.status).toBe(400);
  });

  it('reports a duplicate slug as 409 with the existing id', async () => {
    const first = await request(app).post('/api/tags').send({ name: 'Ceph' });
    const second = await request(app).post('/api/tags').send({ name: 'ceph' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
    expect(second.body.error.details.existingId).toBe(first.body.data.id);
  });
});

describe('GET /api/tags', () => {
  it('returns tags alphabetically with source and unread counts', async () => {
    const storage = await request(app).post('/api/tags').send({ name: 'Storage' });
    await request(app).post('/api/tags').send({ name: 'Alerts' });

    await request(app)
      .post('/api/sources')
      .send({
        kind: 'rss',
        identifier: 'https://a.example.com/feed.xml',
        title: 'A',
        tagIds: [storage.body.data.id],
      });

    const res = await request(app).get('/api/tags');

    expect(res.body.data.map((tag: { name: string }) => tag.name)).toEqual(['Alerts', 'Storage']);
    const [alerts, storageTag] = res.body.data;
    expect(alerts).toMatchObject({ sourceCount: 0, unreadCount: 0 });
    expect(storageTag).toMatchObject({ sourceCount: 1, unreadCount: 0 });
  });
});

describe('PATCH /api/tags/:id', () => {
  it('regenerates the slug on rename', async () => {
    const created = await request(app).post('/api/tags').send({ name: 'Old Name' });

    const res = await request(app)
      .patch(`/api/tags/${created.body.data.id}`)
      .send({ name: 'Brand New Name' });

    expect(res.body.data).toMatchObject({ name: 'Brand New Name', slug: 'brand-new-name' });
  });

  it('recolours without touching the slug', async () => {
    const created = await request(app).post('/api/tags').send({ name: 'Networking' });

    const res = await request(app)
      .patch(`/api/tags/${created.body.data.id}`)
      .send({ color: 'violet' });

    expect(res.body.data).toMatchObject({ slug: 'networking', color: 'violet' });
  });

  it('rejects an empty patch', async () => {
    const created = await request(app).post('/api/tags').send({ name: 'Networking' });
    const res = await request(app).patch(`/api/tags/${created.body.data.id}`).send({});
    expect(res.status).toBe(400);
  });

  it('404s for an unknown tag', async () => {
    const res = await request(app).patch('/api/tags/9999').send({ name: 'Nope' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/tags/:id', () => {
  it('strips the tag from sources, rule filters and widget configs in one go', async () => {
    const tag = await request(app).post('/api/tags').send({ name: 'Doomed' });
    const tagId: number = tag.body.data.id;
    const otherTag = await request(app).post('/api/tags').send({ name: 'Kept' });
    const otherId: number = otherTag.body.data.id;

    await request(app)
      .post('/api/sources')
      .send({
        kind: 'rss',
        identifier: 'https://b.example.com/feed.xml',
        title: 'B',
        tagIds: [tagId, otherId],
      });

    // Rules and widgets have no API surface until later phases; insert directly
    // so the array cleanup this endpoint promises is actually exercised.
    await scalar(
      `INSERT INTO rules (name, pattern, tag_filter) VALUES ('r', 'x', $1::int[]) RETURNING id`,
      [`{${tagId},${otherId}}`],
    );
    const dashboardId = await scalar<number>(
      `INSERT INTO dashboards (name) VALUES ('Home') RETURNING id`,
    );
    await scalar(
      `INSERT INTO widgets (dashboard_id, type, title, config)
       VALUES ($1, 'feed', 'Feed', $2::jsonb) RETURNING id`,
      [dashboardId, JSON.stringify({ tagIds: [tagId, otherId], limit: 15 })],
    );

    const res = await request(app).delete(`/api/tags/${tagId}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      affectedWidgets: 1,
      affectedRules: 1,
      affectedSources: 1,
    });

    // The other tag survives everywhere.
    expect(await scalar<string>(`SELECT tag_filter::text FROM rules LIMIT 1`)).toBe(`{${otherId}}`);
    expect(await scalar<string>(`SELECT config->>'tagIds' FROM widgets LIMIT 1`)).toBe(
      `[${otherId}]`,
    );
    expect(await scalar<number>(`SELECT count(*)::int FROM source_tags`)).toBe(1);
  });

  it('leaves an empty tagIds array rather than removing the key', async () => {
    // A feed widget with no tagIds means "all sources", which is a different
    // filter from one whose key is missing entirely.
    const tag = await request(app).post('/api/tags').send({ name: 'Only' });
    const tagId: number = tag.body.data.id;

    const dashboardId = await scalar<number>(
      `INSERT INTO dashboards (name) VALUES ('Home') RETURNING id`,
    );
    await scalar(
      `INSERT INTO widgets (dashboard_id, type, title, config)
       VALUES ($1, 'feed', 'Feed', $2::jsonb) RETURNING id`,
      [dashboardId, JSON.stringify({ tagIds: [tagId] })],
    );

    await request(app).delete(`/api/tags/${tagId}`);

    expect(await scalar<string>(`SELECT config->>'tagIds' FROM widgets LIMIT 1`)).toBe('[]');
  });

  it('404s for an unknown tag', async () => {
    const res = await request(app).delete('/api/tags/9999');
    expect(res.status).toBe(404);
  });
});
