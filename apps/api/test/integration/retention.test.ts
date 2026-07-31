/**
 * Retention (01-SPEC-data-model.md 3).
 *
 * The assertion that matters most is the one about starred items: a retention
 * policy that deletes something the user explicitly kept is a bug people discover
 * exactly once, and never forgive.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DELETE_BATCH,
  RAW_RETENTION_DAYS,
  purgeOldItems,
  purgeRawPayloads,
  vacuumItems,
} from '../../src/retention/jobs.js';
import { updateSettings } from '../../src/db/settings.js';
import { query } from '../../src/db/pool.js';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function makeSource(): Promise<number> {
  const res = await agent
    .post('/api/sources')
    .send({ kind: 'rss', identifier: 'https://example.com/feed.xml', title: 'Nutanix Blog' });
  return res.body.data.id as number;
}

/** Insert one item at a given age, optionally starred, optionally with `raw`. */
async function insertItem(
  sourceId: number,
  options: { ageDays: number; starred?: boolean; raw?: boolean; key?: string } = { ageDays: 0 },
): Promise<string> {
  const key = options.key ?? `k${Math.random()}`;
  return scalar<string>(
    `INSERT INTO items (source_id, url, title, published_at, fetched_at, content_hash, starred, raw)
     VALUES ($1, $2, $3,
             now() - ($4 || ' days')::interval,
             now() - ($4 || ' days')::interval,
             sha256($5::bytea), $6, $7::jsonb)
     RETURNING id`,
    [
      sourceId,
      `https://example.com/${key}`,
      `Item ${key}`,
      String(options.ageDays),
      key,
      options.starred === true ? 'true' : 'false',
      options.raw === true ? '{"original":"payload"}' : (null as never),
    ],
  );
}

const count = (): Promise<number> => scalar<number>('SELECT count(*)::int FROM items');

describe('purgeOldItems', () => {
  it('deletes items past the retention window', async () => {
    const sourceId = await makeSource();
    await updateSettings({ itemsRetentionDays: 30 });

    await insertItem(sourceId, { ageDays: 60, key: 'old' });
    await insertItem(sourceId, { ageDays: 10, key: 'recent' });

    const result = await purgeOldItems();

    expect(result.deleted).toBe(1);
    expect(await count()).toBe(1);
    expect(await scalar<string>('SELECT title FROM items')).toContain('recent');
  });

  it('never deletes a starred item, however old', async () => {
    const sourceId = await makeSource();
    await updateSettings({ itemsRetentionDays: 30 });

    await insertItem(sourceId, { ageDays: 500, starred: true, key: 'kept' });
    await insertItem(sourceId, { ageDays: 500, key: 'unkept' });

    const result = await purgeOldItems();

    // Starring is the user saying "keep this". Retention must not overrule it.
    expect(result.deleted).toBe(1);
    expect(await scalar<boolean>('SELECT starred FROM items')).toBe(true);
  });

  it('respects a changed retention setting', async () => {
    const sourceId = await makeSource();
    await insertItem(sourceId, { ageDays: 45, key: 'a' });

    await updateSettings({ itemsRetentionDays: 90 });
    expect((await purgeOldItems()).deleted).toBe(0);

    await updateSettings({ itemsRetentionDays: 30 });
    expect((await purgeOldItems()).deleted).toBe(1);
  });

  it('takes the alerts with it, and leaves the source alone', async () => {
    const sourceId = await makeSource();
    await updateSettings({ itemsRetentionDays: 30 });

    const itemId = await insertItem(sourceId, { ageDays: 60, key: 'alerted' });
    const ruleId = await scalar<number>(
      `INSERT INTO rules (name, pattern, scope, weight, alert)
       VALUES ('r', 'x', 'both', 1, true) RETURNING id`,
    );
    await query(`INSERT INTO alerts (item_id, rule_id) VALUES ($1, $2)`, [itemId, ruleId]);

    await purgeOldItems();

    // The alert cascades from the item; the source and the rule do not.
    expect(await scalar<number>('SELECT count(*)::int FROM alerts')).toBe(0);
    expect(await scalar<number>('SELECT count(*)::int FROM sources')).toBe(1);
    expect(await scalar<number>('SELECT count(*)::int FROM rules')).toBe(1);
  });

  it('deletes in batches rather than one long transaction', async () => {
    const sourceId = await makeSource();
    await updateSettings({ itemsRetentionDays: 1 });

    // One more than a batch, so a second pass is required.
    await query(
      `INSERT INTO items (source_id, url, title, published_at, content_hash)
       SELECT $1, 'https://example.com/' || g, 'Item ' || g,
              now() - interval '30 days', sha256(g::text::bytea)
         FROM generate_series(1, $2) AS g`,
      [sourceId, DELETE_BATCH + 10],
    );

    const result = await purgeOldItems();

    expect(result.deleted).toBe(DELETE_BATCH + 10);
    // Several transactions, so the reader is not locked out for the whole purge.
    expect(result.batches).toBeGreaterThan(1);
    expect(await count()).toBe(0);
  });

  it('does nothing, cheaply, when there is nothing to purge', async () => {
    const sourceId = await makeSource();
    await insertItem(sourceId, { ageDays: 1, key: 'fresh' });

    const result = await purgeOldItems();

    expect(result.deleted).toBe(0);
    expect(result.batches).toBe(1);
  });
});

describe('purgeRawPayloads', () => {
  it('clears raw past the window but keeps the item', async () => {
    const sourceId = await makeSource();
    await insertItem(sourceId, { ageDays: RAW_RETENTION_DAYS + 3, raw: true, key: 'old' });
    await insertItem(sourceId, { ageDays: 1, raw: true, key: 'new' });

    const result = await purgeRawPayloads();

    expect(result.cleared).toBe(1);
    // The items themselves are untouched: only the debugging payload goes.
    expect(await count()).toBe(2);
    expect(await scalar<number>('SELECT count(*)::int FROM items WHERE raw IS NOT NULL')).toBe(1);
  });

  it('does not rewrite rows that are already null', async () => {
    const sourceId = await makeSource();
    await insertItem(sourceId, { ageDays: 30, key: 'norow' });

    // Without the `raw IS NOT NULL` guard this would touch every old row every
    // night, for nothing.
    expect((await purgeRawPayloads()).cleared).toBe(0);
  });
});

describe('vacuumItems', () => {
  it('runs outside a transaction and reports how long it took', async () => {
    const sourceId = await makeSource();
    await insertItem(sourceId, { ageDays: 1, key: 'v' });

    // VACUUM cannot run inside a transaction; this fails loudly if `query` ever
    // starts wrapping statements in one.
    const result = await vacuumItems();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
