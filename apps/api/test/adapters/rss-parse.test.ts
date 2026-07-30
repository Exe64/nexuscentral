import { describe, expect, it } from 'vitest';
import { FeedParseError, parseFeed } from '../../src/adapters/rss/parse.js';
import { fixture } from '../helpers/fixtures.js';

describe('parseFeed — RSS 2.0', () => {
  it('reads the channel metadata', async () => {
    const feed = await parseFeed(fixture('rss', 'rss2-standard.xml'));

    expect(feed.title).toBe('Nutanix Blog');
    expect(feed.siteUrl).toBe('https://www.nutanix.com/blog');
    expect(feed.iconUrl).toBe('https://www.nutanix.com/content/dam/nutanix/logo.png');
    expect(feed.items).toHaveLength(4);
    expect(feed.undatedCount).toBe(0);
    expect(feed.skippedCount).toBe(0);
  });

  it('normalises an item completely', async () => {
    const feed = await parseFeed(fixture('rss', 'rss2-standard.xml'));
    const [first] = feed.items;

    expect(first).toMatchObject({
      url: 'https://www.nutanix.com/blog/announcing-aos-7-2',
      title: 'Announcing AOS 7.2',
      author: 'Priya Raman',
      guid: 'urn:nutanix:blog:8841',
    });
    expect(first?.publishedAt.toISOString()).toBe('2026-07-28T09:00:00.000Z');
    // HTML stripped, entities decoded, whitespace collapsed.
    expect(first?.summary).toBe(
      'AOS 7.2 ships erasure coding improvements and a rebuilt Prism UI.',
    );
  });

  it('prefers content:encoded over description', async () => {
    const feed = await parseFeed(fixture('rss', 'rss2-standard.xml'));
    const cve = feed.items[1];

    expect(cve?.title).toContain('CVE-2026-31337');
    expect(cve?.summary).toContain('privilege escalation');
    expect(cve?.summary).not.toContain('content:encoded should win');
  });

  it('keeps the original payload in raw for adapter debugging', async () => {
    const feed = await parseFeed(fixture('rss', 'rss2-standard.xml'));
    expect(feed.items[0]?.raw).toBeTypeOf('object');
  });
});

describe('parseFeed — Atom', () => {
  it('resolves relative entry links against the feed link', async () => {
    const feed = await parseFeed(
      fixture('rss', 'atom-relative-links.xml'),
      'https://ceph.example.org/atom.xml',
    );

    expect(feed.title).toBe('Ceph Weekly');
    expect(feed.siteUrl).toBe('https://ceph.example.org/');
    expect(feed.items.map((i) => i.url)).toEqual([
      'https://ceph.example.org/posts/reef-19-2-1',
      'https://ceph.example.org/posts/pg-autoscaling',
    ]);
  });

  it('reads id, updated, author name and summary', async () => {
    const feed = await parseFeed(fixture('rss', 'atom-relative-links.xml'));
    const [first, second] = feed.items;

    expect(first).toMatchObject({
      title: 'Reef 19.2.1 released',
      author: 'Dan Vasquez',
      guid: 'tag:ceph.example.org,2026:post-441',
      summary: 'A point release with 14 backported fixes.',
    });
    expect(first?.publishedAt.toISOString()).toBe('2026-07-29T11:45:00.000Z');
    // The second entry has <published> but no <updated>.
    expect(second?.publishedAt.toISOString()).toBe('2026-07-25T08:00:00.000Z');
  });
});

describe('parseFeed — undated feeds', () => {
  it('falls back to now() and reports how many items did so', async () => {
    const before = Date.now();
    const feed = await parseFeed(fixture('rss', 'rss-no-dates.xml'));
    const after = Date.now();

    expect(feed.items).toHaveLength(3);
    expect(feed.undatedCount).toBe(3);
    for (const item of feed.items) {
      expect(item.publishedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(item.publishedAt.getTime()).toBeLessThanOrEqual(after);
    }
  });
});

describe('parseFeed — messy content', () => {
  it('drops script and style bodies and separates block elements', async () => {
    const feed = await parseFeed(fixture('rss', 'rss-messy-content.xml'));
    const entities = feed.items[0];

    expect(entities?.summary).not.toContain('alert(1)');
    expect(entities?.summary).not.toContain('color:red');
    expect(entities?.summary).toContain('First Second');
    expect(entities?.summary).toContain('café — 42°C here');
  });

  it('decodes entities in titles', async () => {
    const feed = await parseFeed(fixture('rss', 'rss-messy-content.xml'));
    expect(feed.items[0]?.title).toBe('Entities & markup — a tour');
  });

  it('falls back to the URL when an item has no title', async () => {
    const feed = await parseFeed(fixture('rss', 'rss-messy-content.xml'));
    const untitled = feed.items.find((i) => i.url === 'https://messy.example.com/untitled');
    expect(untitled?.title).toBe('https://messy.example.com/untitled');
  });

  it('skips an item with no URL instead of failing the whole feed', async () => {
    const feed = await parseFeed(fixture('rss', 'rss-messy-content.xml'));

    expect(feed.skippedCount).toBe(1);
    expect(feed.items).toHaveLength(3);
    expect(feed.items.map((i) => i.title)).not.toContain('An item with no link whatsoever');
  });

  it('truncates a long summary to 1000 characters on a word boundary', async () => {
    const feed = await parseFeed(fixture('rss', 'rss-messy-content.xml'));
    const long = feed.items.find((i) => i.url === 'https://messy.example.com/long');

    expect(long?.summary).toBeDefined();
    expect(long?.summary?.length).toBeLessThanOrEqual(1000);
    expect(long?.summary?.endsWith('…')).toBe(true);
    // Cut on a boundary, so the character before the ellipsis is not mid-word.
    expect(long?.summary).not.toMatch(/\s…$/);
  });
});

describe('parseFeed — malformed input', () => {
  it('throws FeedParseError for a truncated document', async () => {
    await expect(parseFeed(fixture('rss', 'malformed.xml'))).rejects.toThrow(FeedParseError);
  });

  it('throws FeedParseError for HTML served as a feed', async () => {
    await expect(parseFeed(fixture('rss', 'discovery-page.html'))).rejects.toThrow(FeedParseError);
  });

  it('throws FeedParseError for an empty body', async () => {
    await expect(parseFeed('')).rejects.toThrow(FeedParseError);
  });
});
