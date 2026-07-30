import { describe, expect, it } from 'vitest';
import { buildOpml, parseOpml } from '../../src/opml/index.js';
import { fixture } from '../helpers/fixtures.js';

describe('parseOpml', () => {
  const document = parseOpml(fixture('opml', 'nested-folders.opml'));

  it('reads the document title', () => {
    expect(document.title).toBe('My Subscriptions');
  });

  it('finds every outline that carries an xmlUrl', () => {
    expect(document.feeds.map((feed) => feed.title)).toEqual([
      'Nutanix Blog',
      'Ceph Weekly',
      'Cilium News',
      'Cloud Native Digest',
      'Ampersands & entities',
    ]);
  });

  it('turns enclosing folders into categories, innermost included', () => {
    expect(document.feeds[0]?.categories).toEqual(['Infrastructure', 'Storage']);
    expect(document.feeds[2]?.categories).toEqual(['Infrastructure', 'Networking']);
  });

  it('closes a folder before the next one opens', () => {
    // If the close tag were ignored, "Cilium News" would inherit Storage too.
    expect(document.feeds[2]?.categories).not.toContain('Storage');
  });

  it('reads a category attribute as well as folders', () => {
    expect(document.feeds[3]?.categories).toEqual(['Weekly', 'Digests']);
  });

  it('decodes entities in both attributes and titles', () => {
    expect(document.feeds[4]?.title).toBe('Ampersands & entities');
    expect(document.feeds[4]?.xmlUrl).toBe('https://amp.example.com/feed?a=1&b=2');
  });

  it('keeps htmlUrl when present and omits it otherwise', () => {
    expect(document.feeds[0]?.htmlUrl).toBe('https://www.nutanix.com/blog');
    expect(document.feeds[1]?.htmlUrl).toBeUndefined();
  });

  it('counts an unusable outline instead of inventing a feed', () => {
    expect(document.skipped).toBe(1);
  });

  it('returns no feeds for an empty or non-OPML document', () => {
    expect(parseOpml('').feeds).toEqual([]);
    expect(parseOpml('<html><body>nope</body></html>').feeds).toEqual([]);
  });
});

describe('buildOpml', () => {
  it('emits flat outlines with a category attribute', () => {
    // A source can carry several tags; a folder hierarchy can only express one.
    const xml = buildOpml([
      {
        title: 'Nutanix Blog',
        xmlUrl: 'https://www.nutanix.com/blog/rss.xml',
        htmlUrl: 'https://www.nutanix.com/blog',
        categories: ['Storage', 'Vendors'],
      },
    ]);

    expect(xml).toContain('<opml version="2.0">');
    expect(xml).toContain('category="Storage,Vendors"');
    expect(xml).toContain('xmlUrl="https://www.nutanix.com/blog/rss.xml"');
    expect(xml).toContain('htmlUrl="https://www.nutanix.com/blog"');
  });

  it('escapes attribute values', () => {
    const xml = buildOpml([
      { title: 'Q&A "quoted" <angled>', xmlUrl: 'https://x.example/feed?a=1&b=2', categories: [] },
    ]);

    expect(xml).toContain('text="Q&amp;A &quot;quoted&quot; &lt;angled&gt;"');
    expect(xml).toContain('xmlUrl="https://x.example/feed?a=1&amp;b=2"');
  });

  it('omits htmlUrl and category when there is nothing to say', () => {
    const xml = buildOpml([{ title: 'Bare', xmlUrl: 'https://bare.example/feed', categories: [] }]);
    expect(xml).not.toContain('htmlUrl');
    expect(xml).not.toContain('category');
  });

  it('round-trips through the parser', () => {
    const sources = [
      {
        title: 'Nutanix Blog',
        xmlUrl: 'https://www.nutanix.com/blog/rss.xml',
        htmlUrl: 'https://www.nutanix.com/blog',
        categories: ['Storage', 'Vendors'],
      },
      { title: 'Q&A "quoted"', xmlUrl: 'https://x.example/feed?a=1&b=2', categories: [] },
    ];

    const reparsed = parseOpml(buildOpml(sources));

    expect(reparsed.feeds).toHaveLength(2);
    expect(reparsed.feeds[0]).toMatchObject({
      title: 'Nutanix Blog',
      xmlUrl: 'https://www.nutanix.com/blog/rss.xml',
      htmlUrl: 'https://www.nutanix.com/blog',
      categories: ['Storage', 'Vendors'],
    });
    expect(reparsed.feeds[1]).toMatchObject({
      title: 'Q&A "quoted"',
      xmlUrl: 'https://x.example/feed?a=1&b=2',
    });
  });
});
