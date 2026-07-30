import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHash } from '../../src/lib/hash.js';
import { fixture, makeSource, recordingLogger } from '../helpers/fixtures.js';
import { stubFetch } from '../helpers/stub-fetch.js';

const XML = { 'content-type': 'application/rss+xml' };

const PRIMARY = 'https://nitter.mydomain.tld';
const BACKUP = 'https://nitter.backup.example.net';

const instances = vi.hoisted(() => ({ value: [] as string[] }));

vi.mock('../../src/db/settings.js', () => ({
  getRawSettings: vi.fn(async () => ({})),
  resolveNitterBaseUrls: vi.fn(() => ({ urls: instances.value, origin: 'settings' as const })),
}));

const { NitterAdapter, NitterNotConfiguredError, NitterUnavailableError, normalizeHandle, toXUrl } =
  await import('../../src/adapters/nitter/index.js');

let restore: (() => void) | undefined;

beforeEach(() => {
  instances.value = [PRIMARY, BACKUP];
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

function ctx(identifier = 'nutanix') {
  const { logger, records } = recordingLogger();
  return {
    records,
    context: {
      source: makeSource({ kind: 'nitter', identifier, title: `@${identifier}` }),
      signal: new AbortController().signal,
      logger,
    },
  };
}

describe('normalizeHandle', () => {
  it('accepts every form a user might paste', () => {
    expect(normalizeHandle('nutanix')).toBe('nutanix');
    expect(normalizeHandle('@Nutanix')).toBe('nutanix');
    expect(normalizeHandle('https://x.com/nutanix')).toBe('nutanix');
    expect(normalizeHandle('https://twitter.com/nutanix/status/123')).toBe('nutanix');
    expect(normalizeHandle('https://nitter.mydomain.tld/nutanix/rss')).toBe('nutanix');
    expect(normalizeHandle('https://x.com/nutanix?ref_src=twsrc')).toBe('nutanix');
  });
});

describe('toXUrl', () => {
  it('moves a status URL to x.com and drops the fragment', () => {
    expect(
      toXUrl('https://nitter.mydomain.tld/nutanix/status/1948800000000000001#m', 'nutanix'),
    ).toBe('https://x.com/nutanix/status/1948800000000000001');
  });

  it('produces the same answer whatever instance served it', () => {
    const a = toXUrl('https://nitter.mydomain.tld/nutanix/status/1#m', 'nutanix');
    const b = toXUrl('https://some.other.instance.example/nutanix/status/1', 'nutanix');
    expect(a).toBe(b);
  });

  it('falls back to something stable for a non-URL guid', () => {
    expect(toXUrl('opaque-guid-1234', 'nutanix')).toBe(
      'https://x.com/nutanix/status/opaque-guid-1234',
    );
  });
});

describe('NitterAdapter.fetch', () => {
  it('leaves nothing in the item pointing at the instance', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { body: fixture('nitter', 'timeline.xml'), headers: XML },
    });
    restore = stub.restore;

    const result = await new NitterAdapter().fetch(ctx().context);

    expect(result.items).toHaveLength(3);
    for (const item of result.items) {
      expect(item.url.startsWith('https://x.com/')).toBe(true);
      // Nitter sets guid equal to link, so the parser drops it as redundant and
      // the canonicalised x.com URL carries the identity. Either way, no part of
      // what deduplication reads may mention the instance.
      expect(`${item.url}${item.guid ?? ''}`).not.toContain('nitter');
    }
    expect(result.items[0]?.url).toBe('https://x.com/nutanix/status/1948800000000000001');
  });

  it('rewrites a guid that differs from the link', async () => {
    // Not every instance sets guid == link; when it does not, the guid is what
    // deduplication prefers, so leaving it on the old host would reinsert the
    // whole timeline on an instance change even with the URL fixed.
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
        <title>Nutanix / @nutanix</title>
        <link>${PRIMARY}/nutanix</link>
        <item>
          <title>A post</title>
          <link>${PRIMARY}/nutanix/status/42#m</link>
          <guid isPermaLink="false">${PRIMARY}/nutanix/status/42</guid>
          <pubDate>Tue, 28 Jul 2026 09:05:00 GMT</pubDate>
        </item>
      </channel></rss>`;

    const stub = stubFetch({ [`${PRIMARY}/nutanix/rss`]: { body: feed, headers: XML } });
    restore = stub.restore;

    const result = await new NitterAdapter().fetch(ctx().context);

    expect(result.items[0]?.guid).toBe('https://x.com/nutanix/status/42');
    expect(result.items[0]?.url).toBe('https://x.com/nutanix/status/42');
  });

  it('strips the retweet prefix into a flag on raw', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { body: fixture('nitter', 'timeline.xml'), headers: XML },
    });
    restore = stub.restore;

    const result = await new NitterAdapter().fetch(ctx().context);
    const retweet = result.items[1];

    expect(retweet?.title).toBe(
      'Our team shipped a fix for the Prism Central advisory in under six hours.',
    );
    expect(retweet?.raw).toMatchObject({ retweet: true, retweetedBy: 'nutanix' });
    expect(result.items[0]?.raw).toMatchObject({ retweet: false });
  });

  it('tries the next instance when the first fails, in order', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { status: 502, body: 'bad gateway' },
      [`${BACKUP}/nutanix/rss`]: {
        body: fixture('nitter', 'timeline-other-instance.xml'),
        headers: XML,
      },
    });
    restore = stub.restore;

    const result = await new NitterAdapter().fetch(ctx().context);

    expect(result.items).toHaveLength(3);
    // Self-hosted first, and it is tried first.
    expect(stub.requests[0]?.url).toBe(`${PRIMARY}/nutanix/rss`);
    expect(stub.requests[1]?.url).toBe(`${BACKUP}/nutanix/rss`);
  });

  it('stops at the first instance that works', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { body: fixture('nitter', 'timeline.xml'), headers: XML },
      [`${BACKUP}/nutanix/rss`]: { body: fixture('nitter', 'timeline.xml'), headers: XML },
    });
    restore = stub.restore;

    await new NitterAdapter().fetch(ctx().context);

    expect(stub.requests).toHaveLength(1);
  });

  it('rotates past an instance that serves HTML instead of a feed', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: {
        body: '<html><body>Instance offline</body></html>',
        headers: { 'content-type': 'text/html' },
      },
      [`${BACKUP}/nutanix/rss`]: {
        body: fixture('nitter', 'timeline-other-instance.xml'),
        headers: XML,
      },
    });
    restore = stub.restore;

    const result = await new NitterAdapter().fetch(ctx().context);
    expect(result.items).toHaveLength(3);
  });

  it('reports every attempt when no instance works', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { status: 502, body: '' },
      [`${BACKUP}/nutanix/rss`]: { status: 404, body: '' },
    });
    restore = stub.restore;

    const { context, records } = ctx();
    const error = await new NitterAdapter()
      .fetch(context)
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NitterUnavailableError);
    expect((error as InstanceType<typeof NitterUnavailableError>).attempts).toEqual([
      { baseUrl: PRIMARY, reason: 'HTTP 502' },
      { baseUrl: BACKUP, reason: 'HTTP 404' },
    ]);
    expect(records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('returns an empty result and warns when the feed is well-formed but empty', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { body: fixture('nitter', 'timeline-empty.xml'), headers: XML },
    });
    restore = stub.restore;

    const { context, records } = ctx();
    const result = await new NitterAdapter().fetch(context);

    expect(result.items).toEqual([]);
    // Never marked as expected: this counter is the whole silent-death mechanism.
    expect(result.emptyIsExpected).toBeUndefined();
    expect(records.some((r) => r.level === 'warn' && /dies silently/.test(r.msg ?? ''))).toBe(true);
  });

  it('refuses to run with no instance configured', async () => {
    instances.value = [];
    const stub = stubFetch({});
    restore = stub.restore;

    await expect(new NitterAdapter().fetch(ctx().context)).rejects.toBeInstanceOf(
      NitterNotConfiguredError,
    );
    expect(stub.requests).toHaveLength(0);
  });
});

describe('switching instance must not duplicate history', () => {
  it('hashes the same three posts identically across two instances', async () => {
    // The acceptance criterion, checked at the level that actually decides it.
    const first = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { body: fixture('nitter', 'timeline.xml'), headers: XML },
    });
    const before = await new NitterAdapter().fetch(ctx().context);
    first.restore();

    instances.value = [BACKUP];
    const second = stubFetch({
      [`${BACKUP}/nutanix/rss`]: {
        body: fixture('nitter', 'timeline-other-instance.xml'),
        headers: XML,
      },
    });
    restore = second.restore;
    const after = await new NitterAdapter().fetch(ctx().context);

    const hash = (items: typeof before.items): string[] =>
      items.map((item) =>
        contentHash({
          kind: 'nitter',
          identifier: 'nutanix',
          guid: item.guid,
          url: item.url,
        }).toString('hex'),
      );

    expect(hash(before.items)).toEqual(hash(after.items));
    expect(hash(before.items)).toHaveLength(3);
  });
});

describe('NitterAdapter.resolve', () => {
  it('returns the handle, the x.com site URL and sample items', async () => {
    const stub = stubFetch({
      [`${PRIMARY}/nutanix/rss`]: { body: fixture('nitter', 'timeline.xml'), headers: XML },
    });
    restore = stub.restore;

    const [candidate] = await new NitterAdapter().resolve('https://x.com/Nutanix');

    expect(candidate).toMatchObject({
      kind: 'nitter',
      identifier: 'nutanix',
      title: '@nutanix',
      siteUrl: 'https://x.com/nutanix',
    });
    expect(candidate?.sampleItems).toHaveLength(3);
    expect(candidate?.sampleItems[0]?.url.startsWith('https://x.com/')).toBe(true);
  });

  it('rejects an invalid handle before making a request', async () => {
    const stub = stubFetch({});
    restore = stub.restore;

    await expect(new NitterAdapter().resolve('@this-is-far-too-long-for-x')).rejects.toBeInstanceOf(
      NitterUnavailableError,
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('explains that no instance is configured', async () => {
    instances.value = [];
    const stub = stubFetch({});
    restore = stub.restore;

    await expect(new NitterAdapter().resolve('@nutanix')).rejects.toThrow(/self-hosted instance/);
  });
});
