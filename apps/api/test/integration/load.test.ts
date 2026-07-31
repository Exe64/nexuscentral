/**
 * Phase 7's load check: 100 sources, 200k items, the reader paginates under 200 ms.
 *
 * Measured through the HTTP layer, not against the query, because the budget is
 * about what the reader waits for: the filter, the keyset, the source join, the
 * tag denormalisation and the JSON serialisation together.
 *
 * The timings are asserted rather than merely printed. A performance test that
 * only logs is a test that fails silently the day it regresses -- but the bar is
 * the spec's 200 ms rather than whatever this machine happens to do today, so it
 * does not turn into a flaky benchmark of the CI host.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';
import { query } from '../../src/db/pool.js';
import { purgeOldItems } from '../../src/retention/jobs.js';
import { updateSettings } from '../../src/db/settings.js';

const SOURCES = 100;
const ITEMS = 200_000;

/** 05-BUILD-PLAN.md, Phase 7. */
const BUDGET_MS = 200;

/** Timed with a warm cache: the first call also pays for the connection. */
async function timed(run: () => Promise<unknown>): Promise<number> {
  await run();
  const started = performance.now();
  await run();
  return performance.now() - started;
}

beforeAll(async () => {
  await resetDatabase();

  // Generated in SQL rather than through the API: this is about read performance
  // at scale, and 200k HTTP round trips would take longer than the whole suite.
  await query(
    `INSERT INTO sources (kind, title, identifier, weight)
     SELECT 'rss', 'Source ' || g, 'https://example.com/' || g || '/feed.xml', 1
       FROM generate_series(1, $1) AS g`,
    [SOURCES],
  );

  await query(
    `INSERT INTO tags (name, slug, color)
     VALUES ('Storage','storage','teal'), ('Security','security','red'), ('Cloud','cloud','blue')`,
  );

  // Every source carries a tag, so the denormalisation the reader does is real
  // work rather than an empty join.
  await query(
    `INSERT INTO source_tags (source_id, tag_id)
     SELECT s.id, 1 + (s.id % 3) FROM sources s`,
  );

  await query(
    `INSERT INTO items (source_id, url, title, summary, published_at, fetched_at,
                        content_hash, score, read_at, starred, engagement_score)
     SELECT 1 + (g % $1),
            'https://example.com/item/' || g,
            CASE WHEN g % 97 = 0
                 THEN 'CVE-2026-' || g || ' erasure coding advisory'
                 ELSE 'Item ' || g || ' about storage and clustering' END,
            'Summary for item ' || g || ' mentioning Nutanix AOS and Prism.',
            now() - ((g % 240) || ' days')::interval - ((g % 1440) || ' minutes')::interval,
            now() - ((g % 240) || ' days')::interval,
            sha256(g::text::bytea),
            (g % 1000) / 100.0,
            CASE WHEN g % 3 = 0 THEN now() ELSE NULL END,
            g % 500 = 0,
            CASE WHEN g % 7 = 0 THEN g % 5000 ELSE NULL END
       FROM generate_series(1, $2) AS g`,
    [SOURCES, ITEMS],
  );

  // Without this the planner is working from empty statistics and will pick a
  // sequential scan, which measures nothing about the indexes.
  await query('VACUUM ANALYZE items');
  await query('ANALYZE sources');
}, 300_000);

afterAll(closeDatabase);

describe('the corpus', () => {
  it('is the size the acceptance criterion asks for', async () => {
    expect(await scalar<number>('SELECT count(*)::int FROM sources')).toBe(SOURCES);
    expect(await scalar<number>('SELECT count(*)::int FROM items')).toBe(ITEMS);
  });
});

describe(`the reader paginates 200k items under ${BUDGET_MS}ms`, () => {
  it('first page, newest first', async () => {
    const ms = await timed(() => agent.get('/api/items?limit=50').expect(200));

    console.log(`  published, first page: ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('deep page, via the cursor', async () => {
    // Ten pages in. Keyset pagination should not care how deep this is; OFFSET
    // very much would, which is why the cursor exists.
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const res = await agent
        .get(`/api/items?limit=50${cursor === null ? '' : `&cursor=${cursor}`}`)
        .expect(200);
      cursor = res.body.nextCursor as string | null;
      expect(cursor).not.toBeNull();
    }

    const deep = cursor as unknown as string;
    const ms = await timed(() => agent.get(`/api/items?limit=50&cursor=${deep}`).expect(200));

    console.log(`  published, page 11:    ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('sorted by score', async () => {
    const ms = await timed(() => agent.get('/api/items?limit=50&sort=score').expect(200));

    console.log(`  score:                 ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('unread only, which is the default view', async () => {
    const ms = await timed(() => agent.get('/api/items?limit=50&unreadOnly=true').expect(200));

    console.log(`  unread only:           ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('filtered by tag', async () => {
    const ms = await timed(() => agent.get('/api/items?limit=50&tagIds=1').expect(200));

    console.log(`  by tag:                ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('full-text search', async () => {
    const res = await agent.get('/api/items?limit=50&q=erasure%20coding').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);

    const ms = await timed(() => agent.get('/api/items?limit=50&q=erasure%20coding').expect(200));

    console.log(`  full-text search:      ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('search combined with a filter and a sort', async () => {
    const ms = await timed(() =>
      agent.get('/api/items?limit=50&q=Prism&unreadOnly=true&sort=score').expect(200),
    );

    console.log(`  search + filter + sort:${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe('the search index is actually used', () => {
  it('plans a bitmap index scan rather than a sequential one', async () => {
    const { rows } = await query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM items
        WHERE to_tsvector('simple', title || ' ' || coalesce(summary,''))
              @@ plainto_tsquery('simple', 'erasure coding')`,
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');

    // The db layer's expression must match items_search_idx exactly or the index
    // is silently unused -- which at 200k rows is the difference between 5ms and
    // a sequential scan.
    expect(plan).toContain('items_search_idx');
    expect(plan).not.toMatch(/Seq Scan on items/);
  });
});

describe('the dashboard at this scale', () => {
  it('resolves a seeded dashboard within the budget', async () => {
    const dashboard = await agent.post('/api/dashboards').send({ name: 'Load' });
    const id = dashboard.body.data.id as number;

    for (const type of ['feed', 'stats', 'source_health'] as const) {
      await agent.post('/api/widgets').send({ dashboardId: id, type, title: type });
    }

    const ms = await timed(() => agent.get(`/api/dashboards/${id}/data`).expect(200));

    console.log(`  dashboard, 3 widgets:  ${ms.toFixed(0)}ms`);

    // Three widgets in one batched request, including a count over 200k rows.
    // Looser than the reader budget: this is several queries, not one.
    expect(ms).toBeLessThan(BUDGET_MS * 3);
  });
});

describe('retention at this scale', () => {
  it('purges a large backlog in batches without locking the reader out', async () => {
    await updateSettings({ itemsRetentionDays: 120 });

    const before = await scalar<number>('SELECT count(*)::int FROM items');
    const started = performance.now();
    const result = await purgeOldItems();
    const ms = performance.now() - started;

    console.log(
      `  purged ${result.deleted} of ${before} in ${result.batches} batches, ${ms.toFixed(0)}ms`,
    );

    expect(result.deleted).toBeGreaterThan(0);
    expect(result.batches).toBeGreaterThan(1);
    // Starred items survive even a purge this size.
    expect(await scalar<number>('SELECT count(*)::int FROM items WHERE starred = true')).toBe(
      ITEMS / 500,
    );
  }, 120_000);
});
