import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';
import { query } from '../../src/db/pool.js';
import { rescoreRecent } from '../../src/scoring/rescore.js';

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function seedItems(): Promise<{ sourceId: number; tagId: number }> {
  const tag = await agent.post('/api/tags').send({ name: 'Storage' });
  const source = await agent.post('/api/sources').send({
    kind: 'rss',
    identifier: 'https://blog.example.com/feed.xml',
    title: 'Blog',
    tagIds: [tag.body.data.id],
  });
  const sourceId: number = source.body.data.id;

  await query(
    `INSERT INTO items (source_id, content_hash, url, title, summary, author, published_at)
     VALUES
       ($1, sha256('a'), 'https://x/1', 'Nutanix publishes CVE-2026-31337 advisory',
        'A privilege escalation issue affects Prism Central.', 'security_team', now() - interval '1 hour'),
       ($1, sha256('b'), 'https://x/2', 'Sizing NVMe tiers for mixed workloads',
        'How to pick a cache ratio without guessing.', 'priya', now() - interval '5 hours'),
       ($1, sha256('c'), 'https://x/3', 'Weekly press release roundup',
        'Vendor announcements, lightly edited.', 'pr_bot', now() - interval '10 hours')`,
    [sourceId],
  );

  return { sourceId, tagId: tag.body.data.id };
}

describe('POST /api/rules', () => {
  it('creates a rule', async () => {
    const res = await agent.post('/api/rules').send({
      name: 'CVE mentions',
      pattern: 'CVE-\\d{4}',
      weight: 5,
      alert: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'CVE mentions',
      pattern: 'CVE-\\d{4}',
      flags: 'i',
      scope: 'both',
      weight: 5,
      alert: true,
      active: true,
      tagFilter: [],
      lastError: null,
    });
  });

  it('accepts a negative weight, which is how noise is demoted', async () => {
    const res = await agent
      .post('/api/rules')
      .send({ name: 'Press releases', pattern: 'press release', weight: -3 });

    expect(res.status).toBe(201);
    expect(res.body.data.weight).toBe(-3);
  });

  it('rejects a catastrophic-backtracking pattern with a message that says why', async () => {
    // The acceptance criterion.
    const res = await agent.post('/api/rules').send({ name: 'Bad', pattern: '(\\w+)+@example' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.message).toMatch(/exponential/);
    expect(res.body.error.message).toMatch(/Rewrite/);
    expect(res.body.error.details.code).toBe('nested_quantifier');

    // And nothing was stored.
    expect(await scalar<number>(`SELECT count(*)::int FROM rules`)).toBe(0);
  });

  it.each([
    ['(a+)+', 'nested_quantifier'],
    ['(a*)*', 'nested_quantifier'],
    ['(unclosed', 'invalid_syntax'],
  ])('rejects %s as %s', async (pattern, code) => {
    const res = await agent.post('/api/rules').send({ name: 'x', pattern });
    expect(res.status).toBe(400);
    expect(res.body.error.details.code).toBe(code);
  });

  it('rejects a pattern over the length cap', async () => {
    const res = await agent.post('/api/rules').send({ name: 'x', pattern: 'a'.repeat(201) });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/at most 200 characters/);
  });

  it('rejects a stateful flag', async () => {
    const res = await agent.post('/api/rules').send({ name: 'x', pattern: 'abc', flags: 'g' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.code).toBe('invalid_flags');
  });

  it('rejects an unknown tag in the filter', async () => {
    const res = await agent
      .post('/api/rules')
      .send({ name: 'x', pattern: 'abc', tagFilter: [9999] });

    expect(res.status).toBe(400);
    expect(res.body.error.details.tagIds).toEqual([9999]);
  });
});

describe('POST /api/rules/test', () => {
  beforeEach(seedItems);

  it('reports match counts against real items before anything is saved', async () => {
    // Non-negotiable: without this, rules are written blind.
    const res = await agent
      .post('/api/rules/test')
      .send({ pattern: 'CVE-\\d{4}', flags: 'i', scope: 'both' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, matchCount: 1, sampleSize: 3 });
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0]).toMatchObject({
      title: 'Nutanix publishes CVE-2026-31337 advisory',
      sourceTitle: 'Blog',
    });

    // Nothing persisted.
    expect(await scalar<number>(`SELECT count(*)::int FROM rules`)).toBe(0);
  });

  it('returns the offsets needed to highlight the match', async () => {
    const res = await agent.post('/api/rules/test').send({ pattern: 'CVE-\\d{4}' });

    const { field, start, end } = res.body.matches[0].highlight;
    expect(field).toBe('title');
    expect('Nutanix publishes CVE-2026-31337 advisory'.slice(start, end)).toBe('CVE-2026');
  });

  it('highlights in the summary when the title does not match', async () => {
    const res = await agent.post('/api/rules/test').send({ pattern: 'cache ratio' });

    expect(res.body.matchCount).toBe(1);
    expect(res.body.matches[0].highlight.field).toBe('summary');
  });

  it('honours the scope', async () => {
    const titleOnly = await agent
      .post('/api/rules/test')
      .send({ pattern: 'cache ratio', scope: 'title' });
    expect(titleOnly.body.matchCount).toBe(0);

    const authorOnly = await agent
      .post('/api/rules/test')
      .send({ pattern: 'pr_bot', scope: 'author' });
    expect(authorOnly.body.matchCount).toBe(1);
  });

  it('honours a tag filter', async () => {
    const tags = await agent.get('/api/tags');
    const matching = await agent
      .post('/api/rules/test')
      .send({ pattern: 'Nutanix', tagFilter: [tags.body.data[0].id] });
    expect(matching.body.matchCount).toBe(1);

    const other = await agent.post('/api/tags').send({ name: 'Unused' });
    const nonMatching = await agent
      .post('/api/rules/test')
      .send({ pattern: 'Nutanix', tagFilter: [other.body.data.id] });
    expect(nonMatching.body.matchCount).toBe(0);
  });

  it('reports an unsafe pattern as data, not as an error', async () => {
    // The user is mid-edit; the panel has to keep working.
    const res = await agent.post('/api/rules/test').send({ pattern: '(\\w+)+' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatch(/exponential/);
  });

  it('reports an incomplete pattern as data too', async () => {
    // Typing "CVE-(" is a normal intermediate state.
    const res = await agent.post('/api/rules/test').send({ pattern: 'CVE-(' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('answers with an empty sample when there are no items', async () => {
    await resetDatabase();
    const res = await agent.post('/api/rules/test').send({ pattern: 'anything' });

    expect(res.body).toMatchObject({ valid: true, matchCount: 0, sampleSize: 0, matches: [] });
  });
});

describe('rescoring', () => {
  it('applies rule weights, recency and source weight together', async () => {
    const { sourceId } = await seedItems();
    await query(`UPDATE sources SET weight = 1.5 WHERE id = $1`, [sourceId]);

    await agent.post('/api/rules').send({ name: 'CVE mentions', pattern: 'CVE-\\d{4}', weight: 5 });
    await agent
      .post('/api/rules')
      .send({ name: 'Press releases', pattern: 'press release', weight: -3 });

    await rescoreRecent();

    const cve = await query<{ score: number; matched_rules: number[] }>(
      `SELECT score, matched_rules FROM items WHERE title LIKE 'Nutanix%'`,
    );
    const pr = await query<{ score: number; matched_rules: number[] }>(
      `SELECT score, matched_rules FROM items WHERE title LIKE 'Weekly%'`,
    );

    // (1 + 5) x 1.5 x decay(1h)  ~= 9 x 0.97
    expect(cve.rows[0]?.score).toBeGreaterThan(8);
    expect(cve.rows[0]?.matched_rules).toHaveLength(1);

    // (1 - 3) x 1.5 x decay(10h) -- negative, which is the point.
    expect(pr.rows[0]?.score).toBeLessThan(0);
  });

  it('records which rules fired, so the breakdown can name them', async () => {
    await seedItems();
    const rule = await agent
      .post('/api/rules')
      .send({ name: 'CVE mentions', pattern: 'CVE', weight: 5 });

    await rescoreRecent();

    const matched = await scalar<number[]>(
      `SELECT matched_rules FROM items WHERE title LIKE 'Nutanix%'`,
    );
    expect(matched).toEqual([rule.body.data.id]);
  });

  it('stamps scored_at', async () => {
    await seedItems();
    await rescoreRecent();
    expect(await scalar<number>(`SELECT count(*)::int FROM items WHERE scored_at IS NULL`)).toBe(0);
  });

  it('ignores an inactive rule', async () => {
    await seedItems();
    await agent
      .post('/api/rules')
      .send({ name: 'CVE mentions', pattern: 'CVE', weight: 5, active: false });

    await rescoreRecent();

    expect(await scalar<number>(`SELECT max(score) FROM items`)).toBeLessThan(2);
  });

  it('reconciles matched_rules after a rule is deleted', async () => {
    await seedItems();
    const rule = await agent
      .post('/api/rules')
      .send({ name: 'CVE mentions', pattern: 'CVE', weight: 5 });
    await rescoreRecent();
    expect(await scalar<number>(`SELECT max(score) FROM items`)).toBeGreaterThan(5);

    await agent.delete(`/api/rules/${rule.body.data.id}`);
    // The delete leaves matched_rules stale on purpose; the rescore reconciles it.
    await rescoreRecent();

    const stale = await scalar<number>(
      `SELECT count(*)::int FROM items WHERE matched_rules <> '{}'`,
    );
    expect(stale).toBe(0);
    expect(await scalar<number>(`SELECT max(score) FROM items`)).toBeLessThan(2);
  });

  it('disables a rule that exceeds its per-item budget and finishes the run', async () => {
    const { sourceId } = await seedItems();

    // Insert a rule directly, bypassing the API guard: this is the defence for a
    // pattern that got in some other way, for instance before the guard existed.
    const ruleId = await scalar<number>(
      `INSERT INTO rules (name, pattern, flags, scope, weight)
       VALUES ('Pathological', '(a+)+$', 'i', 'title', 5) RETURNING id`,
    );
    await query(
      `INSERT INTO items (source_id, content_hash, url, title, published_at)
       VALUES ($1, sha256('hang'), 'https://x/hang', $2, now())`,
      [sourceId, `${'a'.repeat(40)}b`],
    );
    await agent.post('/api/rules').send({ name: 'CVE mentions', pattern: 'CVE', weight: 5 });

    const startedAt = Date.now();
    const result = await rescoreRecent();
    const elapsed = Date.now() - startedAt;

    expect(result.deactivatedRuleIds).toContain(ruleId);
    expect(elapsed).toBeLessThan(10_000);

    const rule = await query<{ active: boolean; last_error: string }>(
      `SELECT active, last_error FROM rules WHERE id = $1`,
      [ruleId],
    );
    expect(rule.rows[0]?.active).toBe(false);
    // The user has to be able to see why it stopped applying.
    expect(rule.rows[0]?.last_error).toMatch(/budget/i);
    expect(rule.rows[0]?.last_error).toMatch(/Simplify/);

    // And the run still finished: the other items were scored.
    expect(result.scanned).toBeGreaterThan(0);
  }, 30_000);

  it('surfaces a disabled rule through the API', async () => {
    const { sourceId } = await seedItems();
    await scalar<number>(
      `INSERT INTO rules (name, pattern, flags, scope, weight)
       VALUES ('Pathological', '(a+)+$', 'i', 'title', 5) RETURNING id`,
    );
    await query(
      `INSERT INTO items (source_id, content_hash, url, title, published_at)
       VALUES ($1, sha256('hang'), 'https://x/hang', $2, now())`,
      [sourceId, `${'a'.repeat(40)}b`],
    );

    await rescoreRecent();

    const rules = await agent.get('/api/rules');
    expect(rules.body.data[0]).toMatchObject({ active: false });
    expect(rules.body.data[0].lastError).toMatch(/budget/i);
    expect(rules.body.data[0].lastErrorAt).not.toBeNull();
  }, 30_000);

  it('clears the failure when the pattern is edited', async () => {
    const ruleId = await scalar<number>(
      `INSERT INTO rules (name, pattern, flags, scope, weight, active, last_error, last_error_at)
       VALUES ('Was broken', '(a+)+', 'i', 'title', 5, false, 'exceeded budget', now())
       RETURNING id`,
    );

    const res = await agent.patch(`/api/rules/${ruleId}`).send({ pattern: 'a+', active: true });

    expect(res.body.data).toMatchObject({ active: true, lastError: null, lastErrorAt: null });
  });

  it('scores every item when many share one timestamp, across batch boundaries', async () => {
    // Regression. The scan used to page on `(published_at, id)`. PostgreSQL keeps
    // `timestamptz` to the microsecond, `pg` returns a Date truncated to the
    // millisecond, and feeding that back as the cursor bound silently skipped
    // every row whose true timestamp fell in the truncated remainder. Two items
    // sharing a timestamp was enough to lose one, and only at a batch boundary --
    // invisible in any small test.
    const source = await agent.post('/api/sources').send({
      kind: 'rss',
      identifier: 'https://dup.example.com/feed.xml',
      title: 'Duplicates',
    });

    // One `now()` for the whole statement, so every row shares the exact same
    // microsecond value, and more rows than fit in a single batch.
    const count = 1200;
    await query(
      `INSERT INTO items (source_id, content_hash, url, title, published_at)
       SELECT $1, sha256(('dup' || n)::bytea), 'https://dup/' || n, 'Item ' || n, now()
         FROM generate_series(1, $2) AS n`,
      [source.body.data.id, count],
    );

    const result = await rescoreRecent();

    expect(result.scanned).toBe(count);
    expect(result.updated).toBe(count);
    expect(await scalar<number>(`SELECT count(*)::int FROM items WHERE scored_at IS NULL`)).toBe(0);
  }, 60_000);

  it('refuses an unsafe pattern on update as well as on create', async () => {
    const created = await agent
      .post('/api/rules')
      .send({ name: 'Fine', pattern: 'CVE', weight: 1 });

    const res = await agent.patch(`/api/rules/${created.body.data.id}`).send({ pattern: '(x+)+' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.code).toBe('nested_quantifier');
  });
});

describe('GET /api/items/:id breakdown', () => {
  it('explains the score term by term', async () => {
    // The acceptance criterion: the breakdown popover explains any item's score.
    const { sourceId } = await seedItems();
    await query(`UPDATE sources SET weight = 1.5 WHERE id = $1`, [sourceId]);
    const rule = await agent
      .post('/api/rules')
      .send({ name: 'CVE mentions', pattern: 'CVE-\\d{4}', weight: 5 });
    await rescoreRecent();

    const itemId = await scalar<string>(`SELECT id FROM items WHERE title LIKE 'Nutanix%'`);
    const res = await agent.get(`/api/items/${itemId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.breakdown).toMatchObject({
      base: 1,
      rules: [{ id: rule.body.data.id, name: 'CVE mentions', weight: 5 }],
      engagement: 0,
      sourceWeight: 1.5,
    });
    expect(res.body.data.breakdown.recencyDecay).toBeGreaterThan(0.9);

    // The terms reproduce the score, or the explanation is decoration.
    const { base, rules, engagement, sourceWeight, recencyDecay } = res.body.data.breakdown;
    const reconstructed =
      (base + rules.reduce((t: number, r: { weight: number }) => t + r.weight, 0) + engagement) *
      sourceWeight *
      recencyDecay;
    expect(reconstructed).toBeCloseTo(res.body.data.liveScore, 1);
  });

  it('includes the engagement term for a Reddit item', async () => {
    await agent.patch('/api/settings').send({ nitterBaseUrls: [] });
    const source = await agent
      .post('/api/sources')
      .send({ kind: 'reddit', identifier: 'nutanix', title: 'r/nutanix' });

    await query(
      `INSERT INTO items (source_id, content_hash, url, title, published_at, engagement_score)
       VALUES ($1, sha256('r'), 'https://reddit.com/1', 'Upgrade notes', now(), 500)`,
      [source.body.data.id],
    );

    const itemId = await scalar<string>(`SELECT id FROM items LIMIT 1`);
    const res = await agent.get(`/api/items/${itemId}`);

    // min(2.0, log10(500) x 0.5) ~= 1.35
    expect(res.body.data.breakdown.engagement).toBeCloseTo(1.35, 2);
  });

  it('reports no rules rather than omitting the field', async () => {
    await seedItems();
    const itemId = await scalar<string>(`SELECT id FROM items LIMIT 1`);
    const res = await agent.get(`/api/items/${itemId}`);

    expect(res.body.data.breakdown.rules).toEqual([]);
  });

  it('does not name a rule that has since been deleted', async () => {
    await seedItems();
    const rule = await agent
      .post('/api/rules')
      .send({ name: 'Temporary', pattern: 'CVE', weight: 5 });
    await rescoreRecent();
    await agent.delete(`/api/rules/${rule.body.data.id}`);

    const itemId = await scalar<string>(`SELECT id FROM items WHERE title LIKE 'Nutanix%'`);
    const res = await agent.get(`/api/items/${itemId}`);

    // matched_rules is still stale until the rescore runs; the breakdown must not
    // invent a name for an id that no longer resolves.
    expect(res.body.data.breakdown.rules).toEqual([]);
  });
});
