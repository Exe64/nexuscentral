import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';
import { fixture } from '../helpers/fixtures.js';
import { stubFetch, type StubbedResponse } from '../helpers/stub-fetch.js';
import { pollSource } from '../../src/ingest/runner.js';
import { listDueSourceIds } from '../../src/db/sources.js';

const XML = { 'content-type': 'application/rss+xml' };
const FEED_URL = 'https://www.nutanix.com/blog/rss.xml';

let restore: (() => void) | undefined;

beforeEach(resetDatabase);
afterEach(() => {
  restore?.();
  restore = undefined;
});
afterAll(closeDatabase);

async function createSource(overrides: Record<string, unknown> = {}): Promise<{ id: number }> {
  const res = await agent
    .post('/api/sources')
    .send({ kind: 'rss', identifier: FEED_URL, title: 'Nutanix Blog', ...overrides });
  if (res.status !== 201) throw new Error(`Source creation failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.data.id as number };
}

describe('a poll cycle', () => {
  it('inserts every item from the feed and reports how many were new', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
    });
    restore = stub.restore;

    const source = await createSource();
    const outcome = await pollSource(source.id);

    expect(outcome).toMatchObject({
      status: 'ok',
      itemCount: 4,
      newCount: 4,
      httpStatus: 200,
    });

    const items = await agent.get('/api/items');
    expect(items.body.data).toHaveLength(4);
    // Newest first by default.
    expect(items.body.data[0].title).toBe('Announcing AOS 7.2');
  });

  it('denormalises the source and its tags onto every item', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
    });
    restore = stub.restore;

    const tag = await agent.post('/api/tags').send({ name: 'Storage', color: 'teal' });
    const source = await createSource({ tagIds: [tag.body.data.id] });
    await pollSource(source.id);

    const items = await agent.get('/api/items?limit=1');
    // The client must never need a second round trip to render a row.
    expect(items.body.data[0].source).toMatchObject({
      id: source.id,
      title: 'Nutanix Blog',
      kind: 'rss',
    });
    expect(items.body.data[0].source.tags[0]).toMatchObject({ name: 'Storage', color: 'teal' });
  });

  it('records the ETag and Last-Modified for the next conditional request', async () => {
    const stub = stubFetch({
      [FEED_URL]: {
        body: fixture('rss', 'rss2-standard.xml'),
        headers: { ...XML, etag: 'W/"v1"', 'last-modified': 'Tue, 28 Jul 2026 09:00:00 GMT' },
      },
    });
    restore = stub.restore;

    const source = await createSource();
    await pollSource(source.id);

    expect(await scalar<string>(`SELECT http_etag FROM sources WHERE id = $1`, [source.id])).toBe(
      'W/"v1"',
    );
    expect(
      await scalar<string>(`SELECT http_modified FROM sources WHERE id = $1`, [source.id]),
    ).toBe('Tue, 28 Jul 2026 09:00:00 GMT');
  });

  it('sends the validators back and inserts nothing on 304', async () => {
    // The acceptance criterion: a second poll of an unchanged feed returns 304
    // and inserts nothing.
    let call = 0;
    const stub = stubFetch({
      [FEED_URL]: (req): StubbedResponse => {
        call += 1;
        if (call === 1) {
          return {
            body: fixture('rss', 'rss2-standard.xml'),
            headers: { ...XML, etag: 'W/"v1"' },
          };
        }
        expect(req.headers['if-none-match']).toBe('W/"v1"');
        return { status: 304, headers: XML };
      },
    });
    restore = stub.restore;

    const source = await createSource();

    const first = await pollSource(source.id);
    expect(first).toMatchObject({ status: 'ok', newCount: 4 });

    const second = await pollSource(source.id);
    expect(second).toMatchObject({
      status: 'not_modified',
      itemCount: 0,
      newCount: 0,
      httpStatus: 304,
    });

    expect(await scalar<number>(`SELECT count(*)::int FROM items`)).toBe(4);
    // A 304 is a healthy poll, not an empty one -- the silent-death counter must
    // stay at zero or an ordinary cached feed would raise an alert.
    expect(
      await scalar<number>(`SELECT consecutive_empty FROM sources WHERE id = $1`, [source.id]),
    ).toBe(0);
  });

  it('inserts nothing on a second poll of an unchanged feed even without an ETag', async () => {
    // Not every server sends validators. Deduplication has to hold on its own.
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
    });
    restore = stub.restore;

    const source = await createSource();
    await pollSource(source.id);
    const second = await pollSource(source.id);

    expect(second).toMatchObject({ status: 'ok', itemCount: 4, newCount: 0 });
    expect(await scalar<number>(`SELECT count(*)::int FROM items`)).toBe(4);
  });

  it('deduplicates when only tracking parameters rotated between polls', async () => {
    let call = 0;
    const stub = stubFetch({
      'https://digest.example.io/feed.xml': (): StubbedResponse => {
        call += 1;
        return {
          body: fixture(
            'rss',
            call === 1 ? 'rss-tracking-params.xml' : 'rss-tracking-params-changed.xml',
          ),
          headers: XML,
        };
      },
    });
    restore = stub.restore;

    const source = await createSource({
      identifier: 'https://digest.example.io/feed.xml',
      title: 'Cloud Native Digest',
    });

    expect(await pollSource(source.id)).toMatchObject({ itemCount: 3, newCount: 3 });
    // Same three articles, different utm_* / fbclid / share tokens, no guid.
    expect(await pollSource(source.id)).toMatchObject({ itemCount: 3, newCount: 0 });

    expect(await scalar<number>(`SELECT count(*)::int FROM items`)).toBe(3);
  });

  it('keeps a poll going when individual items are unusable', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss-messy-content.xml'), headers: XML },
    });
    restore = stub.restore;

    const source = await createSource();
    const outcome = await pollSource(source.id);

    // Four outlines in the fixture; the one with no link cannot be stored.
    expect(outcome).toMatchObject({ status: 'ok', itemCount: 3, newCount: 3 });

    const summary = await scalar<string>(
      `SELECT summary FROM items WHERE url = 'https://messy.example.com/entities'`,
    );
    expect(summary).not.toContain('alert(1)');
    expect(summary).toContain('café');
  });

  it('stores the raw payload so an adapter can be debugged', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
    });
    restore = stub.restore;

    const source = await createSource();
    await pollSource(source.id);

    const guid = await scalar<string>(
      `SELECT raw->>'guid' FROM items WHERE url = 'https://www.nutanix.com/blog/announcing-aos-7-2'`,
    );
    expect(guid).toBe('urn:nutanix:blog:8841');
  });
});

describe('health bookkeeping', () => {
  it('records the error and extends the interval on failure', async () => {
    const stub = stubFetch({ [FEED_URL]: { status: 500, body: 'boom' } });
    restore = stub.restore;

    const source = await createSource();
    const outcome = await pollSource(source.id);

    expect(outcome).toMatchObject({ status: 'failed', httpStatus: 500 });

    const detail = await agent.get(`/api/sources/${source.id}`);
    expect(detail.body.data.health).toMatchObject({
      consecutiveFailures: 1,
      lastError: 'HTTP 500',
    });
    expect(detail.body.data.health.lastOkAt).toBeNull();
  });

  it('deactivates a source after ten consecutive failures', async () => {
    const stub = stubFetch({ [FEED_URL]: { status: 404, body: '' } });
    restore = stub.restore;

    const source = await createSource();

    // Nine failures: still trying, with a longer and longer interval.
    await scalar(`UPDATE sources SET consecutive_failures = 9 WHERE id = $1 RETURNING id`, [
      source.id,
    ]);

    const outcome = await pollSource(source.id);

    expect(outcome).toMatchObject({ status: 'failed', deactivated: true });
    // A permanently dead feed should stop consuming budget.
    expect(await scalar<boolean>(`SELECT active FROM sources WHERE id = $1`, [source.id])).toBe(
      false,
    );
  });

  it('does not deactivate a source that is merely being rate limited', async () => {
    // Reddit's unauthenticated budget is roughly one request per 30-60s per IP,
    // so ten throttled polls is an afternoon, not a dead feed. Treating 429 as a
    // failure would switch off a healthy subreddit.
    const stub = stubFetch({ [FEED_URL]: { status: 429, body: '' } });
    restore = stub.restore;

    const source = await createSource();
    await scalar(`UPDATE sources SET consecutive_failures = 9 WHERE id = $1 RETURNING id`, [
      source.id,
    ]);

    const outcome = await pollSource(source.id);

    expect(outcome).toMatchObject({ status: 'throttled', httpStatus: 429 });
    expect(outcome.deactivated).toBeUndefined();
    expect(await scalar<boolean>(`SELECT active FROM sources WHERE id = $1`, [source.id])).toBe(
      true,
    );

    const detail = await agent.get(`/api/sources/${source.id}`);
    // The streak is left exactly as it was: a 429 is evidence about the budget,
    // not about the source's health, so it neither accuses nor exonerates.
    expect(detail.body.data.health.consecutiveFailures).toBe(9);
    // Still explained in the UI, so a quiet source never looks healthy for no reason.
    expect(detail.body.data.health.lastError).toContain('429');
  });

  it('does not let a rate-limited poll fake a successful one', async () => {
    const stub = stubFetch({ [FEED_URL]: { status: 429, body: '' } });
    restore = stub.restore;

    const source = await createSource();
    await pollSource(source.id);

    const detail = await agent.get(`/api/sources/${source.id}`);
    // No items arrived, so `last_ok_at` must not move. Otherwise a source that is
    // throttled forever reads as freshly successful forever.
    expect(detail.body.data.health.lastOkAt).toBeNull();
  });

  it('counts a 200 with zero items towards silent death', async () => {
    const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>Quiet</title><link>https://q.example</link></channel></rss>`;
    const stub = stubFetch({ [FEED_URL]: { body: empty, headers: XML } });
    restore = stub.restore;

    const source = await createSource();

    expect(await pollSource(source.id)).toMatchObject({ status: 'empty', itemCount: 0 });
    expect(await pollSource(source.id)).toMatchObject({ status: 'empty' });
    // At three, the source is reported rather than assumed healthy.
    expect(await pollSource(source.id)).toMatchObject({ status: 'empty', silentDeath: true });

    expect(
      await scalar<number>(`SELECT consecutive_empty FROM sources WHERE id = $1`, [source.id]),
    ).toBe(3);
  });

  it('resets the empty counter as soon as items arrive', async () => {
    let call = 0;
    const stub = stubFetch({
      [FEED_URL]: (): StubbedResponse => {
        call += 1;
        return call === 1
          ? {
              body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Quiet</title></channel></rss>`,
              headers: XML,
            }
          : { body: fixture('rss', 'rss2-standard.xml'), headers: XML };
      },
    });
    restore = stub.restore;

    const source = await createSource();
    await pollSource(source.id);
    await pollSource(source.id);

    expect(
      await scalar<number>(`SELECT consecutive_empty FROM sources WHERE id = $1`, [source.id]),
    ).toBe(0);
  });

  it('does not throw when the source was deleted between enqueue and execution', async () => {
    const outcome = await pollSource(999_999);
    expect(outcome.status).toBe('skipped');
  });

  it('records a failure a user can act on when a source cannot be polled', async () => {
    // Reddit has an adapter but no credentials in this suite, so the poll fails
    // for a reason the settings page can fix. Either way the UI must be able to
    // explain why nothing is arriving rather than showing a healthy source.
    const source = await agent
      .post('/api/sources')
      .send({ kind: 'reddit', identifier: 'nutanix', title: 'r/nutanix' });

    const outcome = await pollSource(source.body.data.id);

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.error).toMatch(/credentials are not configured/i);
    expect(outcome.error).toMatch(/Settings/);
  });
});

describe('the due-source query', () => {
  it('returns a never-polled active source and skips an inactive one', async () => {
    const active = await createSource();
    await agent
      .post('/api/sources')
      .send({ kind: 'rss', identifier: 'https://b.example/feed.xml', title: 'B', active: false });

    expect(await listDueSourceIds()).toEqual([active.id]);
  });

  it('waits out the interval after a successful poll', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
    });
    restore = stub.restore;

    const source = await createSource({ pollInterval: '30 minutes' });
    await pollSource(source.id);

    expect(await listDueSourceIds()).toEqual([]);

    // 31 minutes later it is due again.
    await scalar(
      `UPDATE sources SET last_run_at = now() - interval '31 minutes' WHERE id = $1 RETURNING id`,
      [source.id],
    );
    expect(await listDueSourceIds()).toEqual([source.id]);
  });

  it('extends the interval by 2^failures, capped at eight times', async () => {
    const source = await createSource({ pollInterval: '15 minutes' });

    // Three failures: the effective interval is 15 x 8 = 120 minutes... no,
    // 2^3 = 8, so 120 minutes. At 90 minutes it is not due yet.
    await scalar(
      `UPDATE sources
          SET consecutive_failures = 3, last_run_at = now() - interval '90 minutes'
        WHERE id = $1 RETURNING id`,
      [source.id],
    );
    expect(await listDueSourceIds()).toEqual([]);

    await scalar(
      `UPDATE sources SET last_run_at = now() - interval '121 minutes' WHERE id = $1 RETURNING id`,
      [source.id],
    );
    expect(await listDueSourceIds()).toEqual([source.id]);

    // The multiplier is capped: 20 failures is still 8x, not 2^20.
    await scalar(
      `UPDATE sources
          SET consecutive_failures = 20, last_run_at = now() - interval '121 minutes'
        WHERE id = $1 RETURNING id`,
      [source.id],
    );
    expect(await listDueSourceIds()).toEqual([source.id]);
  });
});
