/**
 * Mapping a JSON response onto the generic item shape.
 *
 * The shapes here are taken from the APIs the ported Glance widgets actually
 * call, because that is what the mapping has to survive: a top-level array, a
 * nested array, Unix timestamps, and fields that are sometimes missing.
 */

import { describe, expect, it } from 'vitest';
import { applyMapping, selectRoot, MAX_ITEMS, __testing } from '../../src/customapi/mapping.js';

const RELEASES = [
  {
    name: 'v2.1.0',
    html_url: 'https://github.com/a/b/releases/v2.1.0',
    tag_name: 'v2.1.0',
    published_at: '2026-07-01T10:00:00Z',
  },
  {
    name: 'v2.0.0',
    html_url: 'https://github.com/a/b/releases/v2.0.0',
    tag_name: 'v2.0.0',
    published_at: '2026-06-01T10:00:00Z',
  },
];

const FIELDS = {
  title: '$.name',
  url: '$.html_url',
  subtitle: '$.tag_name',
  timestamp: '$.published_at',
};

describe('selectRoot', () => {
  it('treats $ on an array as the array itself', () => {
    expect(selectRoot(RELEASES, '$')).toHaveLength(2);
  });

  it('wraps a single object so one element still maps', () => {
    expect(selectRoot({ name: 'x' }, '$')).toHaveLength(1);
  });

  it('follows a path to a nested array', () => {
    const json = { data: { items: RELEASES } };
    expect(selectRoot(json, '$.data.items')).toHaveLength(2);
  });

  it('returns nothing for a path that matches nothing', () => {
    expect(selectRoot(RELEASES, '$.nope')).toEqual([]);
  });
});

describe('applyMapping', () => {
  it('maps a top-level array', () => {
    const result = applyMapping(RELEASES, { root: '$', fields: FIELDS });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      title: 'v2.1.0',
      url: 'https://github.com/a/b/releases/v2.1.0',
      subtitle: 'v2.1.0',
      timestamp: '2026-07-01T10:00:00.000Z',
    });
  });

  it('drops an element with no title rather than rendering a blank row', () => {
    const result = applyMapping([{ name: 'ok' }, { other: 'x' }, { name: '  ' }], {
      root: '$',
      fields: { title: '$.name' },
    });

    expect(result.items).toHaveLength(1);
    expect(result.dropped).toBe(2);
  });

  it('leaves out fields whose path matches nothing', () => {
    const result = applyMapping([{ name: 'ok' }], { root: '$', fields: FIELDS });
    expect(result.items[0]).toEqual({ title: 'ok' });
  });

  it('refuses a non-http url rather than rendering it as a link', () => {
    // A mapped `javascript:` URL would otherwise become a clickable anchor.
    const result = applyMapping([{ t: 'x', u: 'javascript:alert(1)' }], {
      root: '$',
      fields: { title: '$.t', url: '$.u' },
    });
    expect(result.items[0]?.url).toBeUndefined();
  });

  it('does not render an object as [object Object]', () => {
    const result = applyMapping([{ t: 'x', s: { nested: true } }], {
      root: '$',
      fields: { title: '$.t', subtitle: '$.s' },
    });
    // A field pointed at the wrong node should show nothing, not a plausible lie.
    expect(result.items[0]?.subtitle).toBeUndefined();
  });

  it('caps how many items one widget can render', () => {
    const many = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => ({ name: `item ${i}` }));
    const result = applyMapping(many, { root: '$', fields: { title: '$.name' } });

    expect(result.items).toHaveLength(MAX_ITEMS);
    // `matched` reports the truth so the widget can say what it hid.
    expect(result.matched).toBe(MAX_ITEMS + 50);
  });

  it('returns nothing for a path that selects nothing, without throwing', () => {
    // jsonpath-plus does not validate: `nonsense((` returns an empty result and
    // `$[` is quietly treated as `$`. Neither throws. There is no validation to
    // lean on, which is why the preview endpoint reports what a path actually
    // selected rather than claiming to check it.
    const result = applyMapping(RELEASES, { root: 'nonsense((', fields: FIELDS });

    expect(result.items).toEqual([]);
    expect(result.matched).toBe(0);
  });
});

describe('timestamps', () => {
  it.each([
    ['ISO', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00.000Z'],
    // An exact multiple of 86400, so it lands on midnight.
    ['Unix seconds', 1_782_000_000, '2026-06-21T00:00:00.000Z'],
    ['Unix milliseconds', 1_782_000_000_000, '2026-06-21T00:00:00.000Z'],
    ['seconds as a string', '1782000000', '2026-06-21T00:00:00.000Z'],
    ['RFC 2822', 'Wed, 01 Jul 2026 10:00:00 GMT', '2026-07-01T10:00:00.000Z'],
  ])('accepts %s', (_label, input, expected) => {
    expect(__testing.timestamp(input)).toBe(expected);
  });

  it.each([['not a date'], [{}], [null]])('returns nothing for %s', (input) => {
    expect(__testing.timestamp(input)).toBeUndefined();
  });
});

describe('values', () => {
  it('keeps a number a number, for single_value', () => {
    const result = applyMapping([{ t: 'Subscribers', n: 4213 }], {
      root: '$',
      fields: { title: '$.t', value: '$.n' },
    });
    expect(result.items[0]?.value).toBe(4213);
  });

  it('accepts a string value too', () => {
    const result = applyMapping([{ t: 'Status', v: 'operational' }], {
      root: '$',
      fields: { title: '$.t', value: '$.v' },
    });
    expect(result.items[0]?.value).toBe('operational');
  });
});
