import { describe, expect, it } from 'vitest';
import { extractImageUrl } from '../../src/adapters/rss/image.js';

const BASE = 'https://example.com/posts/one';

/** The shape xml2js gives a namespaced element with attributes. */
const node = (attrs: Record<string, string>) => ({ $: attrs });

describe('extractImageUrl', () => {
  it('prefers media:thumbnail, the shape Reddit and Ars Technica emit', () => {
    expect(
      extractImageUrl({
        'media:thumbnail': node({ url: 'https://preview.redd.it/abc.png?width=640' }),
      }),
    ).toBe('https://preview.redd.it/abc.png?width=640');
  });

  it('reads media:content when it is an image, and skips it when it says it is not', () => {
    expect(
      extractImageUrl({
        'media:content': node({ url: 'https://cdn.example.com/a.jpg', medium: 'image' }),
      }),
    ).toBe('https://cdn.example.com/a.jpg');

    // A podcast feed's media:content is the audio file, not a preview.
    expect(
      extractImageUrl({
        'media:content': node({ url: 'https://cdn.example.com/ep.mp3', type: 'audio/mpeg' }),
      }),
    ).toBeUndefined();
  });

  it('accepts a media element that arrived as an array', () => {
    // xml2js gives one node or a list depending on how many the document had;
    // treating the list case as "no image" would silently lose whole feeds.
    expect(
      extractImageUrl({
        'media:content': [
          node({ url: 'https://cdn.example.com/first.jpg', medium: 'image' }),
          node({ url: 'https://cdn.example.com/second.jpg', medium: 'image' }),
        ],
      }),
    ).toBe('https://cdn.example.com/first.jpg');
  });

  it('falls back to the first <img> in the body, which is all The Verge gives', () => {
    expect(
      extractImageUrl(
        { content: '<p>Intro</p><img src="/media/hero.jpg" width="1200"><p>More</p>' },
        BASE,
      ),
    ).toBe('https://example.com/media/hero.jpg');
  });

  it('skips a tracking pixel rather than making it the thumbnail', () => {
    // Publishers open the body with one often enough that taking the first
    // <img> on faith gives a feed of 1x1 previews.
    expect(
      extractImageUrl(
        {
          content:
            '<img src="https://example.com/p.gif" width="1" height="1">' +
            '<img src="https://example.com/real.jpg" width="800">',
        },
        BASE,
      ),
    ).toBe('https://example.com/real.jpg');
  });

  it('skips a known pixel host even when it declares no size', () => {
    expect(
      extractImageUrl(
        {
          content:
            '<img src="https://feeds.feedburner.com/~ff/blog?d=abc">' +
            '<img src="https://example.com/real.jpg">',
        },
        BASE,
      ),
    ).toBe('https://example.com/real.jpg');
  });

  it('prefers data-src, because lazy markup leaves a placeholder in src', () => {
    expect(
      extractImageUrl(
        { content: '<img src="/placeholder.gif" data-src="https://cdn.example.com/real.jpg">' },
        BASE,
      ),
    ).toBe('https://cdn.example.com/real.jpg');
  });

  it('decodes entities in the URL, which a signed CDN link cannot survive without', () => {
    expect(
      extractImageUrl({ content: '<img src="https://cdn.example.com/a.jpg?w=1&amp;sig=xyz">' }),
    ).toBe('https://cdn.example.com/a.jpg?w=1&sig=xyz');
  });

  it('refuses data: URIs rather than storing them', () => {
    // Unbounded base64 in a text column that is read on every render.
    expect(
      extractImageUrl({ content: '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' }),
    ).toBeUndefined();
  });

  it('returns undefined for a feed with no body at all, like Hacker News', () => {
    expect(extractImageUrl({ title: 'Something' } as never, BASE)).toBeUndefined();
  });
});
