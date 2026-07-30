import { describe, expect, it } from 'vitest';
import { parseFeed } from '../../src/adapters/rss/parse.js';
import { canonicalize } from '../../src/lib/canonicalize.js';
import { contentHash } from '../../src/lib/hash.js';
import { fixture } from '../helpers/fixtures.js';

describe('canonicalize', () => {
  it('lowercases the scheme and host and strips www.', () => {
    expect(canonicalize('HTTPS://WWW.Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('leaves a path case alone — paths are case-sensitive', () => {
    expect(canonicalize('https://example.com/Blog/Post-One')).toBe(
      'https://example.com/Blog/Post-One',
    );
  });

  it('drops the fragment', () => {
    expect(canonicalize('https://example.com/post#section-3')).toBe('https://example.com/post');
  });

  it('removes utm_* and the known share tokens', () => {
    expect(
      canonicalize(
        'https://example.com/p?utm_source=nl&utm_medium=email&fbclid=a&gclid=b&ref=x&ref_src=y&s=09&si=z&id=7',
      ),
    ).toBe('https://example.com/p?id=7');
  });

  it('keeps parameters that are part of the content identity', () => {
    expect(canonicalize('https://example.com/search?q=ceph&page=2')).toBe(
      'https://example.com/search?page=2&q=ceph',
    );
  });

  it('sorts remaining parameters so order does not create a second item', () => {
    expect(canonicalize('https://example.com/p?b=2&a=1')).toBe(
      canonicalize('https://example.com/p?a=1&b=2'),
    );
  });

  it('orders repeated keys deterministically', () => {
    expect(canonicalize('https://example.com/p?tag=b&tag=a')).toBe(
      canonicalize('https://example.com/p?tag=a&tag=b'),
    );
  });

  it('strips a trailing slash on a non-empty path but not on the root', () => {
    expect(canonicalize('https://example.com/posts/hello/')).toBe(
      'https://example.com/posts/hello',
    );
    expect(canonicalize('https://example.com/')).toBe('https://example.com/');
  });

  it('returns an unparseable input unchanged rather than throwing mid-poll', () => {
    expect(canonicalize('  not a url  ')).toBe('not a url');
  });
});

describe('contentHash', () => {
  const base = { kind: 'rss' as const, identifier: 'https://example.com/feed.xml' };

  it('is stable across calls', () => {
    const input = { ...base, url: 'https://example.com/a' };
    expect(contentHash(input)).toEqual(contentHash(input));
  });

  it('prefers the guid over the URL, so a permalink rewrite does not duplicate', () => {
    const withOldUrl = contentHash({ ...base, guid: 'urn:post:1', url: 'https://example.com/old' });
    const withNewUrl = contentHash({ ...base, guid: 'urn:post:1', url: 'https://example.com/new' });
    expect(withOldUrl).toEqual(withNewUrl);
  });

  it('canonicalises the URL when there is no guid', () => {
    const tracked = contentHash({ ...base, url: 'https://www.example.com/a/?utm_source=nl' });
    const clean = contentHash({ ...base, url: 'https://example.com/a' });
    expect(tracked).toEqual(clean);
  });

  it('treats an empty guid as absent', () => {
    expect(contentHash({ ...base, guid: '', url: 'https://example.com/a' })).toEqual(
      contentHash({ ...base, url: 'https://example.com/a' }),
    );
  });

  it('includes the source, so the same article from two feeds appears twice', () => {
    // Deliberate: cross-source dedup would hide a story spreading.
    const fromA = contentHash({ kind: 'rss', identifier: 'feed-a', url: 'https://example.com/a' });
    const fromB = contentHash({ kind: 'rss', identifier: 'feed-b', url: 'https://example.com/a' });
    expect(fromA).not.toEqual(fromB);
  });

  it('includes the kind, so a handle and a subreddit of the same name differ', () => {
    const reddit = contentHash({ kind: 'reddit', identifier: 'ceph', url: 'https://x/1' });
    const nitter = contentHash({ kind: 'nitter', identifier: 'ceph', url: 'https://x/1' });
    expect(reddit).not.toEqual(nitter);
  });

  it('is a 32-byte sha256 digest', () => {
    expect(contentHash({ ...base, url: 'https://example.com/a' })).toHaveLength(32);
  });
});

describe('deduplication across two polls of the same feed', () => {
  it('hashes identically when only tracking parameters rotated', async () => {
    // These two fixtures are the same three articles with different utm_*,
    // fbclid, ref_src, s and fragment values, and no guid to fall back on.
    const first = await parseFeed(fixture('rss', 'rss-tracking-params.xml'));
    const second = await parseFeed(fixture('rss', 'rss-tracking-params-changed.xml'));

    const identifier = 'https://digest.example.io/feed.xml';
    const hash = (items: typeof first.items): string[] =>
      items.map((item) =>
        contentHash({ kind: 'rss', identifier, guid: item.guid, url: item.url }).toString('hex'),
      );

    expect(hash(first.items)).toEqual(hash(second.items));
    // Sanity: the raw URLs really are different, so this is not a vacuous pass.
    expect(first.items.map((i) => i.url)).not.toEqual(second.items.map((i) => i.url));
  });
});
