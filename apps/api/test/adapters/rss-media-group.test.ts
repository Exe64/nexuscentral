/**
 * `media:group`, the wrapper YouTube puts everything in.
 *
 * Measured against the live channel feed before this existed: reading only the
 * entry found 0 of 15 thumbnails and 0 of 15 summaries, because YouTube emits
 * neither on the entry itself. A channel arrived as fifteen bare titles.
 */

import { describe, expect, it } from 'vitest';
import { extractImageUrl } from '../../src/adapters/rss/image.js';
import { parseFeed } from '../../src/adapters/rss/parse.js';
import { fixture } from '../helpers/fixtures.js';

/** The shape xml2js gives a namespaced element with attributes. */
const node = (attrs: Record<string, string>) => ({ $: attrs });

/**
 * The group literals below wrap each child in an array on purpose: inside a
 * group rss-parser hands children back as arrays even when there is one of
 * them, where at item level the same element arrives unwrapped. Measured
 * against the live feed, not assumed -- and the reason the fixture test at the
 * bottom exists as well as these.
 */
describe('extractImageUrl and media:group', () => {
  it('finds a thumbnail nested in the group', () => {
    expect(
      extractImageUrl({
        'media:group': {
          'media:thumbnail': [node({ url: 'https://i3.ytimg.com/vi/x/hqdefault.jpg' })],
        },
      }),
    ).toBe('https://i3.ytimg.com/vi/x/hqdefault.jpg');
  });

  it('does not mistake the group for a preview when it holds no image', () => {
    expect(
      extractImageUrl({
        'media:group': {
          'media:title': ['Some video'],
          'media:community': [{ 'media:statistics': [node({ views: '1000' })] }],
        },
      }),
    ).toBeUndefined();
  });

  it('refuses the Flash media:content YouTube lists before the thumbnail', () => {
    // The trap: it is 640x390 so no size guard rejects it, and it comes first in
    // document order. Anything taking the first media element in the group would
    // store a dead Flash URL as the article image.
    expect(
      extractImageUrl({
        'media:group': {
          'media:content': [
            node({
              url: 'https://www.youtube.com/v/x?version=3',
              type: 'application/x-shockwave-flash',
              width: '640',
              height: '390',
            }),
          ],
        },
      }),
    ).toBeUndefined();
  });

  it('takes the item-level thumbnail over the group one', () => {
    // A publisher emitting both hoisted one deliberately.
    expect(
      extractImageUrl({
        'media:thumbnail': node({ url: 'https://example.com/hoisted.jpg' }),
        'media:group': {
          'media:thumbnail': [node({ url: 'https://example.com/grouped.jpg' })],
        },
      }),
    ).toBe('https://example.com/hoisted.jpg');
  });

  it('ignores a group that is not an object', () => {
    expect(extractImageUrl({ 'media:group': 'nonsense' })).toBeUndefined();
    expect(extractImageUrl({ 'media:group': null })).toBeUndefined();
    expect(extractImageUrl({ 'media:group': [] })).toBeUndefined();
  });

  it('still applies the size floor inside the group', () => {
    expect(
      extractImageUrl({
        'media:group': {
          'media:thumbnail': [
            node({ url: 'https://example.com/pixel.gif', width: '1', height: '1' }),
          ],
        },
      }),
    ).toBeUndefined();
  });
});

describe('a YouTube channel feed end to end', () => {
  it('gives every video a thumbnail and a summary', async () => {
    const feed = await parseFeed(
      fixture('rss', 'youtube-channel.atom.xml'),
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA',
    );

    expect(feed.title).toBe('Fireship');
    expect(feed.items).toHaveLength(2);

    for (const item of feed.items) {
      expect(item.imageUrl).toMatch(/^https:\/\/i3\.ytimg\.com\/vi\/.+\/hqdefault\.jpg$/);
      expect(item.summary).toBeTruthy();
    }
  });

  it('picks the thumbnail, never the Flash content that precedes it', async () => {
    const feed = await parseFeed(fixture('rss', 'youtube-channel.atom.xml'), 'https://x/');

    for (const item of feed.items) {
      expect(item.imageUrl).not.toContain('/v/');
      expect(item.imageUrl).not.toContain('version=3');
    }
  });

  it('keeps the video link, the title and the date', async () => {
    const feed = await parseFeed(fixture('rss', 'youtube-channel.atom.xml'), 'https://x/');
    const first = feed.items[0];

    expect(first?.url).toBe('https://www.youtube.com/watch?v=jxGJT1weu4w');
    expect(first?.title).toBe('Did Anthropic just kill the indie hacker...?');
    expect(first?.publishedAt.toISOString()).toBe('2026-07-29T16:33:51.000Z');
    expect(first?.author).toBe('Fireship');
  });

  it('uses media:description as the summary', async () => {
    const feed = await parseFeed(fixture('rss', 'youtube-channel.atom.xml'), 'https://x/');

    expect(feed.items[0]?.summary).toContain('killing the indie hacker dream');
  });

  it('lets a real body beat media:description', async () => {
    // media:description describes the media, not the item. Where an entry has
    // both, its own body is the better summary and has to win.
    const document = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Both</title>
  <entry>
    <title>An entry with a body of its own</title>
    <link rel="alternate" href="https://example.com/one"/>
    <published>2026-07-20T10:00:00+00:00</published>
    <summary>The entry's own words.</summary>
    <media:group>
      <media:description>The media description.</media:description>
    </media:group>
  </entry>
</feed>`;

    const feed = await parseFeed(document, 'https://example.com/');

    expect(feed.items[0]?.summary).toBe("The entry's own words.");
  });
});
