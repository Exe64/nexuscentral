import { afterEach, describe, expect, it } from 'vitest';
import { RssAdapter } from '../../src/adapters/rss/index.js';
import { HttpError } from '../../src/lib/http.js';
import { fixture, makeSource, recordingLogger } from '../helpers/fixtures.js';
import { stubFetch } from '../helpers/stub-fetch.js';

const FEED_URL = 'https://www.nutanix.com/blog/rss.xml';
const XML = { 'content-type': 'application/rss+xml' };
const HTML = { 'content-type': 'text/html; charset=utf-8' };

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function ctx(overrides: Parameters<typeof makeSource>[0] = {}, conditional?: object) {
  const { logger, records } = recordingLogger();
  return {
    records,
    context: {
      source: makeSource({ identifier: FEED_URL, ...overrides }),
      signal: new AbortController().signal,
      logger,
      ...(conditional === undefined ? {} : { conditional }),
    },
  };
}

describe('RssAdapter.fetch', () => {
  it('sends a descriptive User-Agent and a feed Accept header', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
    });
    restore = stub.restore;

    await new RssAdapter().fetch(ctx().context);

    const [request] = stub.requests;
    expect(request?.headers['user-agent']).toMatch(
      /^nexuscentral\/\d+\.\d+\.\d+ \(\+self-hosted\)$/,
    );
    expect(request?.headers['accept']).toContain('application/rss+xml');
    expect(request?.headers['accept']).toContain('application/atom+xml');
  });

  it('returns normalised items and the caching headers to store', async () => {
    const stub = stubFetch({
      [FEED_URL]: {
        body: fixture('rss', 'rss2-standard.xml'),
        headers: {
          ...XML,
          etag: 'W/"abc123"',
          'last-modified': 'Tue, 28 Jul 2026 09:00:00 GMT',
        },
      },
    });
    restore = stub.restore;

    const result = await new RssAdapter().fetch(ctx().context);

    expect(result.items).toHaveLength(4);
    expect(result.notModified).toBeUndefined();
    expect(result.etag).toBe('W/"abc123"');
    expect(result.lastModified).toBe('Tue, 28 Jul 2026 09:00:00 GMT');
  });

  it('sends the stored validators as conditional request headers', async () => {
    const stub = stubFetch({
      [FEED_URL]: { status: 304, headers: XML },
    });
    restore = stub.restore;

    await new RssAdapter().fetch(
      ctx({}, { etag: 'W/"abc123"', lastModified: 'Tue, 28 Jul 2026 09:00:00 GMT' }).context,
    );

    const [request] = stub.requests;
    expect(request?.headers['if-none-match']).toBe('W/"abc123"');
    expect(request?.headers['if-modified-since']).toBe('Tue, 28 Jul 2026 09:00:00 GMT');
  });

  it('reports 304 as notModified with no items', async () => {
    const stub = stubFetch({ [FEED_URL]: { status: 304, headers: XML } });
    restore = stub.restore;

    const result = await new RssAdapter().fetch(ctx({}, { etag: 'W/"abc123"' }).context);

    expect(result).toEqual({ items: [], notModified: true });
  });

  it('omits conditional headers entirely when nothing is stored', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
    });
    restore = stub.restore;

    await new RssAdapter().fetch(ctx().context);

    const [request] = stub.requests;
    expect(request?.headers).not.toHaveProperty('if-none-match');
    expect(request?.headers).not.toHaveProperty('if-modified-since');
  });

  it('warns when items fall through to now(), because dedup then carries the load', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss-no-dates.xml'), headers: XML },
    });
    restore = stub.restore;

    const { context, records } = ctx();
    await new RssAdapter().fetch(context);

    const warning = records.find((r) => r.level === 'warn' && /no usable date/.test(r.msg ?? ''));
    expect(warning).toBeDefined();
    expect(warning?.obj).toMatchObject({ undatedCount: 3 });
  });

  it('warns when items are skipped for having no URL', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss-messy-content.xml'), headers: XML },
    });
    restore = stub.restore;

    const { context, records } = ctx();
    const result = await new RssAdapter().fetch(context);

    expect(result.items).toHaveLength(3);
    expect(records.some((r) => r.level === 'warn' && /no usable URL/.test(r.msg ?? ''))).toBe(true);
  });

  it('throws on a 404 rather than reporting an empty feed', async () => {
    const stub = stubFetch({ [FEED_URL]: { status: 404, body: 'nope', headers: HTML } });
    restore = stub.restore;

    await expect(new RssAdapter().fetch(ctx().context)).rejects.toMatchObject({
      name: 'HttpError',
      status: 404,
    });
  });

  it('refuses a body over the size cap instead of buffering it', async () => {
    const stub = stubFetch({
      [FEED_URL]: { headers: { ...XML, 'content-length': String(11 * 1024 * 1024) } },
    });
    restore = stub.restore;

    await expect(new RssAdapter().fetch(ctx().context)).rejects.toMatchObject({
      name: 'HttpError',
      kind: 'too_large',
    });
    // A body over the cap is a property of the response, not a transient error.
    expect(stub.requests).toHaveLength(1);
  });
});

describe('RssAdapter.resolve', () => {
  it('treats an XML response as the feed itself', async () => {
    const stub = stubFetch({
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
    });
    restore = stub.restore;

    const [candidate, ...rest] = await new RssAdapter().resolve(FEED_URL);

    expect(rest).toHaveLength(0);
    expect(candidate).toMatchObject({
      kind: 'rss',
      identifier: FEED_URL,
      title: 'Nutanix Blog',
      siteUrl: 'https://www.nutanix.com/blog',
    });
    expect(candidate?.sampleItems).toHaveLength(3);
    expect(candidate?.sampleItems[0]?.title).toBe('Announcing AOS 7.2');
  });

  it('accepts a bare hostname and assumes https, never http', async () => {
    const stub = stubFetch({
      'https://example.com/': { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
    });
    restore = stub.restore;

    await new RssAdapter().resolve('example.com/');

    expect(stub.requests[0]?.url).toBe('https://example.com/');
  });

  it('discovers feeds advertised by an HTML page, in document order', async () => {
    const pageUrl = 'https://www.nutanix.com/blog';
    const stub = stubFetch({
      [pageUrl]: { body: fixture('rss', 'discovery-page.html'), headers: HTML },
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
      'https://www.nutanix.com/blog/comments/atom.xml': {
        body: fixture('rss', 'atom-relative-links.xml'),
        headers: XML,
      },
    });
    restore = stub.restore;

    const candidates = await new RssAdapter().resolve(pageUrl);

    expect(candidates.map((c) => c.identifier)).toEqual([
      FEED_URL,
      'https://www.nutanix.com/blog/comments/atom.xml',
    ]);
    // The application/json alternate must not be treated as a feed.
    expect(stub.requests.map((r) => r.url)).not.toContain('https://www.nutanix.com/blog/feed.json');
  });

  it('drops a candidate that does not resolve, keeping the ones that do', async () => {
    const pageUrl = 'https://www.nutanix.com/blog';
    const stub = stubFetch({
      [pageUrl]: { body: fixture('rss', 'discovery-page.html'), headers: HTML },
      [FEED_URL]: { body: fixture('rss', 'rss2-standard.xml'), headers: XML },
      'https://www.nutanix.com/blog/comments/atom.xml': { status: 500, body: 'boom' },
    });
    restore = stub.restore;

    const candidates = await new RssAdapter().resolve(pageUrl);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.identifier).toBe(FEED_URL);
  });

  it('falls back to the conventional paths when nothing is advertised', async () => {
    const pageUrl = 'https://plain.example.org/';
    const stub = stubFetch({
      [pageUrl]: {
        body: '<html><head><title>Plain</title></head><body>hi</body></html>',
        headers: HTML,
      },
      'https://plain.example.org/feed': { status: 404, body: '' },
      'https://plain.example.org/rss': { body: fixture('rss', 'rss-no-dates.xml'), headers: XML },
    });
    restore = stub.restore;

    const candidates = await new RssAdapter().resolve(pageUrl);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.identifier).toBe('https://plain.example.org/rss');
    // Stops at the first hit rather than probing /index.xml and /atom.xml too.
    expect(stub.requests.map((r) => r.url)).not.toContain('https://plain.example.org/index.xml');
  });

  it('returns no candidates when a page advertises and hosts nothing', async () => {
    const pageUrl = 'https://barren.example.org/';
    const stub = stubFetch({
      [pageUrl]: { body: '<html><head><title>Barren</title></head></html>', headers: HTML },
      'https://barren.example.org/feed': { status: 404, body: '' },
      'https://barren.example.org/rss': { status: 404, body: '' },
      'https://barren.example.org/index.xml': { status: 404, body: '' },
      'https://barren.example.org/atom.xml': { status: 404, body: '' },
    });
    restore = stub.restore;

    await expect(new RssAdapter().resolve(pageUrl)).resolves.toEqual([]);
  });

  it('derives a favicon and page title when the feed supplies neither', async () => {
    const pageUrl = 'https://plain.example.org/';
    const stub = stubFetch({
      [pageUrl]: {
        body: '<html><head><title>Plain Blog</title></head><body>hi</body></html>',
        headers: HTML,
      },
      'https://plain.example.org/feed': {
        // A feed with no <title> and no <image>.
        body: '<?xml version="1.0"?><rss version="2.0"><channel><item><title>One</title><link>https://plain.example.org/one</link></item></channel></rss>',
        headers: XML,
      },
    });
    restore = stub.restore;

    const [candidate] = await new RssAdapter().resolve(pageUrl);

    expect(candidate?.title).toBe('Plain Blog');
    expect(candidate?.iconUrl).toBe('https://plain.example.org/favicon.ico');
  });

  it('surfaces an unreachable entry URL as an HttpError', async () => {
    const stub = stubFetch({ 'https://gone.example.org/': { status: 410, body: 'gone' } });
    restore = stub.restore;

    await expect(new RssAdapter().resolve('https://gone.example.org/')).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});
