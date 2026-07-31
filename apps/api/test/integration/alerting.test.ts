/**
 * Alert creation and delivery, against a real database and a real HTTP receiver.
 *
 * Three of Phase 6's acceptance criteria live here:
 *   - a rule with alert:true matching a new item delivers
 *   - forty simultaneous matches produce one notification, not forty
 *   - creating an alerting rule generates zero alerts for pre-existing items
 */

import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deliverPendingAlerts,
  sendTestNotification,
  __resetDeliveryClock,
} from '../../src/alerts/deliver.js';
import { countPendingAlerts, pendingAlerts } from '../../src/db/alerts.js';
import { updateSettings } from '../../src/db/settings.js';
import { rescoreRecent, scoreItems } from '../../src/scoring/rescore.js';
import { query } from '../../src/db/pool.js';
import { agent, closeDatabase, resetDatabase, scalar } from './helpers.js';

/** A webhook receiver, so delivery is exercised over real HTTP. */
interface Received {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let port = 0;
let received: Received[] = [];
let respondWith = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.statusCode = respondWith;
      res.end(respondWith === 200 ? 'ok' : 'nope');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  received = [];
  respondWith = 200;
  // The delivery clock is a module-level guard against pushing more than once a
  // minute; without resetting it the second test in the file would be skipped.
  __resetDeliveryClock();
});

afterEach(() => {
  __resetDeliveryClock();
});

const hookUrl = (): string => `http://127.0.0.1:${port}/hook`;

async function configureWebhook(kind = 'generic'): Promise<void> {
  await updateSettings({ alertWebhookKind: kind as 'generic', alertWebhookUrl: hookUrl() });
}

async function makeSource(): Promise<number> {
  const res = await agent
    .post('/api/sources')
    .send({ kind: 'rss', identifier: 'https://example.com/feed.xml', title: 'Nutanix Blog' });
  expect(res.status).toBe(201);
  return res.body.data.id as number;
}

async function makeRule(alert: boolean, name = 'CVE mentions'): Promise<number> {
  const res = await agent
    .post('/api/rules')
    .send({ name, pattern: 'CVE-\\d{4}', scope: 'both', weight: 5, alert });
  expect(res.status).toBe(201);
  return res.body.data.id as number;
}

/** Insert items directly: the adapters are covered elsewhere and need a network. */
async function insertItems(sourceId: number, count: number, matching = true): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const title = matching ? `CVE-2026-${1000 + i} in the storage layer` : `Release notes ${i}`;
    const id = await scalar<string>(
      `INSERT INTO items (source_id, url, title, published_at, content_hash)
       VALUES ($1, $2, $3, now(), sha256($4::bytea)) RETURNING id`,
      [sourceId, `https://example.com/${i}`, title, `hash-${i}`],
    );
    ids.push(id);
  }
  return ids;
}

describe('alerts are raised for newly ingested items', () => {
  it('creates one alert per matching item and rule', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    const ids = await insertItems(sourceId, 3);

    const result = await scoreItems(ids);

    expect(result.alertsRaised).toBe(3);
    expect(await countPendingAlerts()).toBe(3);
  });

  it('creates nothing for items that do not match', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    const ids = await insertItems(sourceId, 3, false);

    expect((await scoreItems(ids)).alertsRaised).toBe(0);
  });

  it('creates nothing for a rule that matches but does not alert', async () => {
    const sourceId = await makeSource();
    await makeRule(false);
    const ids = await insertItems(sourceId, 3);

    const result = await scoreItems(ids);

    // The rule still scores the items; it just does not notify.
    expect(result.alertsRaised).toBe(0);
    expect(await scalar<number>('SELECT count(*)::int FROM items WHERE score > 0')).toBe(3);
  });

  it('does not raise a second alert for the same item and rule', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    const ids = await insertItems(sourceId, 2);

    await scoreItems(ids);
    // A replayed poll, or a crash between scoring and the queue acknowledging.
    const second = await scoreItems(ids);

    expect(second.alertsRaised).toBe(0);
    expect(await countPendingAlerts()).toBe(2);
  });

  it('ignores an inactive rule', async () => {
    const sourceId = await makeSource();
    const ruleId = await makeRule(true);
    await agent.patch(`/api/rules/${ruleId}`).send({ active: false });
    const ids = await insertItems(sourceId, 2);

    expect((await scoreItems(ids)).alertsRaised).toBe(0);
  });
});

describe('turning on alerting never fires for the past', () => {
  it('generates zero alerts for pre-existing items', async () => {
    const sourceId = await makeSource();
    const ids = await insertItems(sourceId, 25);

    // Scored before any alerting rule existed.
    await scoreItems(ids);
    expect(await countPendingAlerts()).toBe(0);

    // Now the user turns on a rule that matches every one of them.
    await makeRule(true);
    await rescoreRecent();

    // The rescore must set matched_rules without notifying about 25 old items.
    expect(await scalar<number>('SELECT count(*)::int FROM items WHERE score > 0')).toBe(25);
    expect(await countPendingAlerts()).toBe(0);
  });
});

describe('delivery', () => {
  it('sends one notification for forty simultaneous matches', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await configureWebhook();

    const ids = await insertItems(sourceId, 40);
    expect((await scoreItems(ids)).alertsRaised).toBe(40);

    const outcome = await deliverPendingAlerts();

    // One request, describing forty alerts. Not forty requests.
    expect(received).toHaveLength(1);
    expect(outcome.sent).toBe(40);

    const payload = JSON.parse(received[0]?.body ?? '{}') as { count: number };
    expect(payload.count).toBe(40);
    expect(await countPendingAlerts()).toBe(0);
  });

  it('marks what it sent as delivered', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await configureWebhook();
    await scoreItems(await insertItems(sourceId, 2));

    await deliverPendingAlerts();

    expect(
      await scalar<number>('SELECT count(*)::int FROM alerts WHERE delivered_at IS NOT NULL'),
    ).toBe(2);
  });

  it('does nothing when no target is configured', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await scoreItems(await insertItems(sourceId, 2));

    const outcome = await deliverPendingAlerts();

    expect(outcome.skipped).toBe('not-configured');
    expect(received).toHaveLength(0);
    // Still pending, and still visible in the widget.
    expect(await countPendingAlerts()).toBe(2);
  });

  it('refuses to push twice inside a minute', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await configureWebhook();

    await scoreItems(await insertItems(sourceId, 1));
    expect((await deliverPendingAlerts()).sent).toBe(1);

    // A second poll seconds later must not mean a second push.
    const more = await scalar<string>(
      `INSERT INTO items (source_id, url, title, published_at, content_hash)
       VALUES ($1, 'https://example.com/late', 'CVE-2026-9999 late', now(), sha256('late'::bytea))
       RETURNING id`,
      [sourceId],
    );
    await scoreItems([more]);

    const outcome = await deliverPendingAlerts();

    expect(outcome.skipped).toBe('too-soon');
    expect(outcome.retryInMs).toBeGreaterThan(0);
    expect(received).toHaveLength(1);
    // The alert is not lost -- it waits.
    expect(await countPendingAlerts()).toBe(1);
  });

  it('records the failure and keeps the alert pending', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await configureWebhook();
    await scoreItems(await insertItems(sourceId, 2));

    respondWith = 500;
    const outcome = await deliverPendingAlerts();

    expect(outcome.error).toContain('500');
    // Three attempts, per the spec.
    expect(received).toHaveLength(3);
    expect(await countPendingAlerts()).toBe(2);

    const error = await scalar<string>(
      'SELECT delivery_error FROM alerts WHERE delivery_error IS NOT NULL LIMIT 1',
    );
    expect(error).toContain('500');
  });

  it('retries the same alerts on the next run and clears the error', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await configureWebhook();
    await scoreItems(await insertItems(sourceId, 2));

    respondWith = 500;
    await deliverPendingAlerts();

    // A webhook that was down for a while must catch up, not drop the window.
    respondWith = 200;
    __resetDeliveryClock();
    const outcome = await deliverPendingAlerts();

    expect(outcome.sent).toBe(2);
    expect(await countPendingAlerts()).toBe(0);
    expect(
      await scalar<number>('SELECT count(*)::int FROM alerts WHERE delivery_error IS NOT NULL'),
    ).toBe(0);
  });

  it('does not start the interval clock on a failed push', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await configureWebhook();
    await scoreItems(await insertItems(sourceId, 1));

    respondWith = 500;
    await deliverPendingAlerts();

    // A failure must not buy the next attempt a sixty second wait.
    respondWith = 200;
    expect((await deliverPendingAlerts()).sent).toBe(1);
  });

  it('sends ntfy headers over the wire', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await updateSettings({ alertWebhookKind: 'ntfy', alertWebhookUrl: hookUrl() });
    await scoreItems(await insertItems(sourceId, 1));

    await deliverPendingAlerts();

    expect(received[0]?.headers.title).toContain('CVE mentions');
    expect(received[0]?.headers.priority).toBe('high');
    expect(received[0]?.body).toContain('CVE-2026-1000');
  });
});

describe('the alerts list', () => {
  it('surfaces the delivery error to the reader', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await configureWebhook();
    await scoreItems(await insertItems(sourceId, 1));

    respondWith = 500;
    await deliverPendingAlerts();

    const res = await agent.get('/api/alerts');
    expect(res.body.data[0].deliveryError).toContain('500');
    expect(res.body.data[0].deliveredAt).toBeNull();
    // The in-app widget is the source of truth when a push fails.
    expect(res.body.counts.undelivered).toBe(1);
  });

  it('orders pending alerts oldest first, so a catch-up reads in order', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await scoreItems(await insertItems(sourceId, 3));
    await query(`UPDATE alerts SET created_at = created_at - (id || ' hours')::interval`);

    const pending = await pendingAlerts(10);
    const times = pending.map((alert) => Date.parse(alert.createdAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('POST /api/settings/test-webhook', () => {
  it('says so when nothing is configured', async () => {
    const res = await agent.post('/api/settings/test-webhook');
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.reason).toBe('not_configured');
  });

  it('sends a real notification and touches no alerts', async () => {
    await configureWebhook();

    const res = await agent.post('/api/settings/test-webhook');

    expect(res.body.data.ok).toBe(true);
    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0]?.body ?? '{}') as { test: boolean };
    expect(payload.test).toBe(true);
    expect(await scalar<number>('SELECT count(*)::int FROM alerts')).toBe(0);
  });

  it('reports the failure without retrying three times', async () => {
    await configureWebhook();
    respondWith = 500;

    const res = await agent.post('/api/settings/test-webhook');

    expect(res.body.data.ok).toBe(false);
    expect(String(res.body.data.message)).toContain('500');
    // One attempt: the user is watching.
    expect(received).toHaveLength(1);
  });

  it('does not consume the delivery interval', async () => {
    const sourceId = await makeSource();
    await makeRule(true);
    await configureWebhook();
    await agent.post('/api/settings/test-webhook');

    await scoreItems(await insertItems(sourceId, 1));
    // A test push must not make the next real alert wait a minute.
    expect((await deliverPendingAlerts()).sent).toBe(1);
  });
});

describe('sendTestNotification directly', () => {
  it('reports a connection failure rather than throwing', async () => {
    await updateSettings({
      alertWebhookKind: 'generic',
      // Nothing listens here.
      alertWebhookUrl: 'http://127.0.0.1:1/hook',
    });

    const result = await sendTestNotification();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
