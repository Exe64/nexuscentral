import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';
import { query } from '../../src/db/pool.js';

interface Seeded {
  alphaId: number;
  betaId: number;
  storageTagId: number;
  networkTagId: number;
}

let seeded: Seeded;

beforeEach(async () => {
  await resetDatabase();
  seeded = await seed();
});
afterAll(closeDatabase);

/**
 * Two sources with one tag each and six items with staggered dates, scores and
 * engagement, so every filter and both sort orders have something to bite on.
 */
async function seed(): Promise<Seeded> {
  const storage = await agent.post('/api/tags').send({ name: 'Storage' });
  const network = await agent.post('/api/tags').send({ name: 'Networking' });

  const alpha = await agent.post('/api/sources').send({
    kind: 'rss',
    identifier: 'https://alpha.example/feed.xml',
    title: 'Alpha',
    tagIds: [storage.body.data.id],
  });
  const beta = await agent.post('/api/sources').send({
    kind: 'rss',
    identifier: 'https://beta.example/feed.xml',
    title: 'Beta',
    tagIds: [network.body.data.id],
  });

  const alphaId: number = alpha.body.data.id;
  const betaId: number = beta.body.data.id;

  await query(
    `INSERT INTO items
       (source_id, content_hash, url, title, summary, published_at, score, engagement_score, starred)
     VALUES
       ($1, sha256('a1'), 'https://alpha.example/1', 'Kubernetes 1.35 deprecations',
        'Read this before you upgrade the cluster', now() - interval '1 hour',  8.40, 120, false),
       ($1, sha256('a2'), 'https://alpha.example/2', 'Ceph Reef point release',
        'Fourteen backported fixes', now() - interval '5 hours',  3.10,  40, true),
       ($1, sha256('a3'), 'https://alpha.example/3', 'NVMe tier sizing',
        'How to pick a cache ratio', now() - interval '2 days',   1.20, NULL, false),
       ($2, sha256('b1'), 'https://beta.example/1',  'eBPF war stories',
        'What actually breaks in production', now() - interval '3 hours', 6.50, 300, false),
       ($2, sha256('b2'), 'https://beta.example/2',  'Cilium versus Calico',
        'Benchmarks with the methodology attached', now() - interval '4 days', 2.00, 15, false),
       ($2, sha256('b3'), 'https://beta.example/3',  'BGP in the datacentre',
        NULL, now() - interval '10 days', 0.50, NULL, false)`,
    [alphaId, betaId],
  );

  return {
    alphaId,
    betaId,
    storageTagId: storage.body.data.id,
    networkTagId: network.body.data.id,
  };
}

describe('GET /api/items', () => {
  it('sorts newest first by default and returns no cursor on the last page', async () => {
    const res = await agent.get('/api/items');

    expect(res.body.data.map((i: { title: string }) => i.title)).toEqual([
      'Kubernetes 1.35 deprecations',
      'eBPF war stories',
      'Ceph Reef point release',
      'NVMe tier sizing',
      'Cilium versus Calico',
      'BGP in the datacentre',
    ]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('sorts by score and by engagement', async () => {
    const byScore = await agent.get('/api/items?sort=score&limit=2');
    expect(byScore.body.data.map((i: { score: number }) => i.score)).toEqual([8.4, 6.5]);

    const byEngagement = await agent.get('/api/items?sort=engagement&limit=2');
    expect(
      byEngagement.body.data.map((i: { engagementScore: number }) => i.engagementScore),
    ).toEqual([300, 120]);
  });

  it('puts items with no engagement signal last rather than dropping them', async () => {
    const res = await agent.get('/api/items?sort=engagement');
    expect(res.body.data).toHaveLength(6);
    expect(res.body.data.at(-1).engagementScore).toBeNull();
  });

  it('filters by tag as a union, not an intersection', async () => {
    const oneTag = await agent.get(`/api/items?tagIds=${seeded.storageTagId}`);
    expect(oneTag.body.data).toHaveLength(3);

    const bothTags = await agent.get(
      `/api/items?tagIds=${seeded.storageTagId},${seeded.networkTagId}`,
    );
    expect(bothTags.body.data).toHaveLength(6);
  });

  it('accepts a repeated query parameter as well as a comma-separated list', async () => {
    const repeated = await agent.get(
      `/api/items?tagIds=${seeded.storageTagId}&tagIds=${seeded.networkTagId}`,
    );
    expect(repeated.body.data).toHaveLength(6);
  });

  it('filters by source, star, score floor and date', async () => {
    expect((await agent.get(`/api/items?sourceIds=${seeded.betaId}`)).body.data).toHaveLength(3);
    expect((await agent.get('/api/items?starredOnly=true')).body.data).toHaveLength(1);
    expect((await agent.get('/api/items?minScore=6')).body.data).toHaveLength(2);

    const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    expect((await agent.get(`/api/items?since=${since}`)).body.data).toHaveLength(3);
  });

  it('runs full-text search over the title and the summary', async () => {
    const byTitle = await agent.get('/api/items?q=kubernetes');
    expect(byTitle.body.data.map((i: { title: string }) => i.title)).toEqual([
      'Kubernetes 1.35 deprecations',
    ]);

    const bySummary = await agent.get('/api/items?q=benchmarks');
    expect(bySummary.body.data.map((i: { title: string }) => i.title)).toEqual([
      'Cilium versus Calico',
    ]);

    // An item with a null summary must still be searchable by title.
    const nullSummary = await agent.get('/api/items?q=BGP');
    expect(nullSummary.body.data).toHaveLength(1);
  });

  it('rejects a malformed cursor rather than returning a wrong page', async () => {
    const res = await agent.get('/api/items?cursor=not-a-cursor');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cursor/i);
  });

  it('rejects a limit above the ceiling', async () => {
    expect((await agent.get('/api/items?limit=101')).status).toBe(400);
  });
});

describe('cursor pagination', () => {
  it('walks every page exactly once with no repeats or gaps', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string =
        cursor === null
          ? '/api/items?limit=2'
          : `/api/items?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await agent.get(url);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor as string | null;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('paginates a score sort without losing tied rows', async () => {
    // Three items share a score, so the id tiebreaker is what keeps the walk
    // total: without it a page boundary inside the tie would skip or repeat.
    await query(`UPDATE items SET score = 5.00`);

    const first = await agent.get('/api/items?sort=score&limit=4');
    expect(first.body.nextCursor).not.toBeNull();

    const second = await agent.get(
      `/api/items?sort=score&limit=4&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );

    const ids = [
      ...first.body.data.map((i: { id: string }) => i.id),
      ...second.body.data.map((i: { id: string }) => i.id),
    ];
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });
});

describe('read and star state', () => {
  it('marks an item read and unread', async () => {
    const items = await agent.get('/api/items?limit=1');
    const id: string = items.body.data[0].id;

    expect((await agent.post(`/api/items/${id}/read`)).status).toBe(204);
    expect((await agent.get(`/api/items/${id}`)).body.data.readAt).not.toBeNull();

    expect((await agent.delete(`/api/items/${id}/read`)).status).toBe(204);
    expect((await agent.get(`/api/items/${id}`)).body.data.readAt).toBeNull();
  });

  it('stars and unstars an item', async () => {
    const items = await agent.get('/api/items?limit=1');
    const id: string = items.body.data[0].id;

    await agent.post(`/api/items/${id}/star`);
    expect((await agent.get(`/api/items/${id}`)).body.data.starred).toBe(true);

    await agent.delete(`/api/items/${id}/star`);
    expect((await agent.get(`/api/items/${id}`)).body.data.starred).toBe(false);
  });

  it('404s for an unknown item and 400s for a non-numeric id', async () => {
    expect((await agent.post('/api/items/999999/read')).status).toBe(404);
    expect((await agent.get('/api/items/abc')).status).toBe(400);
  });

  it('excludes read items when unreadOnly is set', async () => {
    const items = await agent.get('/api/items');
    await agent.post(`/api/items/${items.body.data[0].id}/read`);

    const unread = await agent.get('/api/items?unreadOnly=true');
    expect(unread.body.data).toHaveLength(5);
  });
});

describe('POST /api/items/read-all', () => {
  it('marks only the items matching the given filters', async () => {
    const res = await agent.post('/api/items/read-all').send({ sourceIds: [seeded.betaId] });

    expect(res.body.data.updated).toBe(3);
    expect(await scalar<number>(`SELECT count(*)::int FROM items WHERE read_at IS NOT NULL`)).toBe(
      3,
    );
  });

  it('is idempotent — a second call updates nothing', async () => {
    await agent.post('/api/items/read-all').send({});
    const second = await agent.post('/api/items/read-all').send({});
    expect(second.body.data.updated).toBe(0);
  });

  it('honours a full-text filter', async () => {
    const res = await agent.post('/api/items/read-all').send({ q: 'kubernetes' });
    expect(res.body.data.updated).toBe(1);
  });
});
