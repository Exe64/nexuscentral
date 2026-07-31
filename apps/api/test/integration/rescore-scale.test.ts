import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';
import { query } from '../../src/db/pool.js';
import { BATCH_SIZE, refreshScores, rescoreRecent } from '../../src/scoring/rescore.js';

/**
 * The acceptance criterion: creating a rule rescores the last 30 days within 10
 * seconds for 50,000 items.
 *
 * Generated in the database rather than through the API: this measures the
 * scoring path, and 50,000 HTTP inserts would measure something else.
 */
const ITEM_COUNT = 50_000;

beforeAll(async () => {
  await resetDatabase();

  const tag = await agent.post('/api/tags').send({ name: 'Storage' });
  const source = await agent.post('/api/sources').send({
    kind: 'rss',
    identifier: 'https://scale.example.com/feed.xml',
    title: 'Scale',
    tagIds: [tag.body.data.id],
  });

  // Titles and summaries with realistic variety, so the regexes have something to
  // work on rather than matching or missing uniformly.
  await query(
    `INSERT INTO items (source_id, content_hash, url, title, summary, author, published_at)
     SELECT $1,
            sha256(('item' || n)::bytea),
            'https://scale.example.com/' || n,
            CASE n % 7
              WHEN 0 THEN 'Nutanix publishes CVE-2026-' || (10000 + n % 9999) || ' advisory'
              WHEN 1 THEN 'Weekly press release roundup number ' || n
              WHEN 2 THEN 'Kubernetes ' || (30 + n % 9) || '.' || (n % 5) || ' deprecations'
              ELSE 'Field notes from deployment ' || n
            END,
            'A summary for item ' || n || ' with some words about storage, networking and ' ||
              CASE WHEN n % 3 = 0 THEN 'erasure coding' ELSE 'cache ratios' END || '.',
            'author_' || (n % 50),
            now() - make_interval(mins => (n % (29 * 24 * 60))::int)
       FROM generate_series(1, $2) AS n`,
    [source.body.data.id, ITEM_COUNT],
  );

  // A realistic rule set: a boost, a demotion, a scoped rule and a tag-filtered one.
  await agent
    .post('/api/rules')
    .send({ name: 'CVE mentions', pattern: 'CVE-\\d{4}', weight: 5, scope: 'both' });
  await agent
    .post('/api/rules')
    .send({ name: 'Press releases', pattern: 'press release', weight: -4, scope: 'title' });
  await agent
    .post('/api/rules')
    .send({ name: 'Kubernetes', pattern: '\\b(kubernetes|k8s)\\b', weight: 2, scope: 'both' });
  await agent
    .post('/api/rules')
    .send({ name: 'Erasure coding', pattern: 'erasure coding', weight: 1.5, scope: 'summary' });
  await agent
    .post('/api/rules')
    .send({ name: 'Prolific author', pattern: 'author_7$', weight: -1, scope: 'author' });

  const total = await scalar<number>(`SELECT count(*)::int FROM items`);
  if (total !== ITEM_COUNT) throw new Error(`Expected ${ITEM_COUNT} items, got ${total}`);
}, 300_000);

afterAll(closeDatabase);

describe(`rescoring ${ITEM_COUNT.toLocaleString('en')} items`, () => {
  it('finishes within 10 seconds', async () => {
    const startedAt = Date.now();
    const result = await rescoreRecent();
    const elapsed = Date.now() - startedAt;

    console.log(
      `rescore: ${result.scanned} scanned, ${result.updated} updated in ${elapsed}ms ` +
        `(${Math.round(result.scanned / (elapsed / 1000)).toLocaleString('en')} items/s, ` +
        `${Math.ceil(result.scanned / BATCH_SIZE)} batches)`,
    );

    expect(result.scanned).toBe(ITEM_COUNT);
    expect(result.updated).toBe(ITEM_COUNT);
    expect(result.deactivatedRuleIds).toEqual([]);
    expect(elapsed).toBeLessThan(10_000);
  }, 120_000);

  it('produced scores that actually discriminate', async () => {
    // A fast job that scored everything the same would pass the timing test and be
    // worthless.
    const stats = await query<{
      distinct_scores: number;
      min: number;
      max: number;
      matched: number;
    }>(
      `SELECT count(DISTINCT score)::int AS distinct_scores,
              min(score) AS min,
              max(score) AS max,
              count(*) FILTER (WHERE matched_rules <> '{}')::int AS matched
         FROM items`,
    );
    const row = stats.rows[0];

    expect(row?.distinct_scores).toBeGreaterThan(100);
    // The demotion rule drives some items negative.
    expect(row?.min).toBeLessThan(0);
    expect(row?.max).toBeGreaterThan(5);
    // Roughly 3 in 7 titles match a rule, plus the summary and author rules.
    expect(row?.matched).toBeGreaterThan(ITEM_COUNT / 4);
  });

  it('refreshes the last 7 days from stored matches, much faster', async () => {
    const startedAt = Date.now();
    const result = await refreshScores();
    const elapsed = Date.now() - startedAt;

    console.log(`refresh: ${result.scanned} scanned in ${elapsed}ms`);

    // A 7-day window out of a 29-day spread.
    expect(result.scanned).toBeGreaterThan(ITEM_COUNT / 6);
    expect(result.scanned).toBeLessThan(ITEM_COUNT / 2);
    // No regex execution at all, so this has to be comfortably quicker.
    expect(elapsed).toBeLessThan(10_000);
  }, 120_000);

  it('leaves the whole window scored', async () => {
    expect(await scalar<number>(`SELECT count(*)::int FROM items WHERE scored_at IS NULL`)).toBe(0);
  });
});
