/**
 * Alerts and stats (03-SPEC-api.md 8, 9).
 *
 * Nothing writes an alert until Phase 6, so these insert rows directly. That is
 * not a shortcut around the API -- it is the only way to test the read side of a
 * table whose writer does not exist yet, and the alternative is shipping the
 * `alerts` widget with no coverage at all.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool.js';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';

/** Reuse the row if a previous call in this test already made it. */
async function ensure<T extends number>(select: string, insert: string): Promise<T> {
  const { rows } = await query<{ id: T }>(select);
  return rows[0]?.id ?? (await scalar<T>(insert));
}

beforeEach(resetDatabase);
afterAll(closeDatabase);

/**
 * A source, a rule, an item and an alert joining them -- the shape the widget reads.
 *
 * `key` keeps the item's content hash and URL unique; `alerts` is unique per
 * (item, rule), so two alerts need two items.
 */
async function makeAlert(
  overrides: { acknowledged?: boolean; title?: string; key?: string } = {},
): Promise<string> {
  const key = overrides.key ?? 'one';

  const sourceId = await ensure<number>(
    `SELECT id FROM sources LIMIT 1`,
    `INSERT INTO sources (kind, title, identifier)
     VALUES ('rss', 'Nutanix Blog', 'https://example.com/feed.xml') RETURNING id`,
  );
  const ruleId = await ensure<number>(
    `SELECT id FROM rules LIMIT 1`,
    `INSERT INTO rules (name, pattern, scope, weight, alert)
     VALUES ('CVE mentions', 'CVE-\\d{4}', 'both', 5, true) RETURNING id`,
  );
  const itemId = await scalar<string>(
    `INSERT INTO items (source_id, url, title, published_at, content_hash)
     VALUES ($1, $2, $3, now(), sha256($4::bytea)) RETURNING id`,
    [
      sourceId,
      `https://example.com/${key}`,
      overrides.title ?? 'CVE-2026-0001 in the storage layer',
      key,
    ],
  );

  return scalar<string>(
    `INSERT INTO alerts (item_id, rule_id, acknowledged_at)
     VALUES ($1, $2, $3) RETURNING id`,
    [itemId, ruleId, overrides.acknowledged === true ? new Date().toISOString() : (null as never)],
  );
}

describe('GET /api/alerts', () => {
  it('returns an empty list and zero counts on a fresh install', async () => {
    const res = await agent.get('/api/alerts');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.counts).toMatchObject({ total: 0, unacknowledged: 0 });
  });

  it('joins the item and the rule that produced the alert', async () => {
    await makeAlert();

    const res = await agent.get('/api/alerts');

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].item.title).toContain('CVE-2026-0001');
    expect(res.body.data[0].rule.name).toBe('CVE mentions');
  });

  it('hides acknowledged alerts unless asked for them', async () => {
    await makeAlert({ acknowledged: true });

    expect((await agent.get('/api/alerts?acknowledged=false')).body.data).toHaveLength(0);
    expect((await agent.get('/api/alerts?acknowledged=true')).body.data).toHaveLength(1);
  });
});

describe('POST /api/alerts/:id/ack', () => {
  it('acknowledges an alert', async () => {
    const id = await makeAlert();

    expect((await agent.post(`/api/alerts/${id}/ack`)).status).toBe(204);
    expect(
      await scalar<number>('SELECT count(*)::int FROM alerts WHERE acknowledged_at IS NOT NULL'),
    ).toBe(1);
  });

  it('is idempotent, because two clicks should not produce an error', async () => {
    const id = await makeAlert();

    await agent.post(`/api/alerts/${id}/ack`);
    expect((await agent.post(`/api/alerts/${id}/ack`)).status).toBe(204);
  });

  it('acknowledges everything at once', async () => {
    await makeAlert({ key: 'one' });
    await makeAlert({ key: 'two' });

    const res = await agent.post('/api/alerts/ack-all');

    expect(res.body.data.acknowledged).toBeGreaterThan(0);
    expect(
      await scalar<number>('SELECT count(*)::int FROM alerts WHERE acknowledged_at IS NULL'),
    ).toBe(0);
  });
});

describe('GET /api/stats', () => {
  it('answers with zeroes rather than nulls on a fresh install', async () => {
    const res = await agent.get('/api/stats');

    expect(res.status).toBe(200);
    expect(res.body.data.items).toMatchObject({ total: 0, unread: 0 });
    expect(res.body.data.topSources).toEqual([]);
  });

  it('reports the Reddit budget as unconfigured when no credentials are set', async () => {
    const res = await agent.get('/api/stats');
    expect(res.body.data.reddit.configured).toBe(false);
  });

  it('never leaks a credential', async () => {
    const res = await agent.get('/api/stats');
    expect(JSON.stringify(res.body)).not.toMatch(/secret|clientSecret|client_secret/i);
  });
});
