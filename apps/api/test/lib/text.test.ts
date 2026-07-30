import { describe, expect, it } from 'vitest';
import {
  collapseWhitespace,
  decodeEntities,
  stripHtml,
  toSummary,
  truncateOnWord,
} from '../../src/lib/text.js';
import { isSluggable, slugify } from '../../src/lib/slug.js';

describe('decodeEntities', () => {
  it('decodes named, decimal and hexadecimal entities', () => {
    expect(decodeEntities('a &amp; b &#8212; c &#x2014; d &nbsp;e')).toBe('a & b — c — d  e');
  });

  it('leaves an unknown entity alone rather than mangling the text', () => {
    expect(decodeEntities('&notarealentity; &amp;')).toBe('&notarealentity; &');
  });

  it('rejects an out-of-range code point', () => {
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;');
  });
});

describe('stripHtml', () => {
  it('removes script and style bodies entirely', () => {
    expect(collapseWhitespace(stripHtml('<script>evil()</script>ok<style>.a{}</style>'))).toBe(
      'ok',
    );
  });

  it('inserts a boundary at block-level tags', () => {
    expect(collapseWhitespace(stripHtml('<p>one</p><p>two</p>'))).toBe('one two');
  });

  it('does not glue words across a <br>', () => {
    expect(collapseWhitespace(stripHtml('line<br/>break'))).toBe('line break');
  });

  it('keeps inline text contiguous', () => {
    expect(collapseWhitespace(stripHtml('<em>in</em><strong>line</strong>'))).toBe('inline');
  });

  it('drops comments', () => {
    expect(collapseWhitespace(stripHtml('a<!-- hidden -->b'))).toBe('a b');
  });
});

describe('truncateOnWord', () => {
  it('leaves short input untouched', () => {
    expect(truncateOnWord('short', 100)).toBe('short');
  });

  it('cuts on a word boundary and appends an ellipsis within budget', () => {
    const result = truncateOnWord('alpha beta gamma delta', 16);
    expect(result.length).toBeLessThanOrEqual(16);
    expect(result).toBe('alpha beta…');
  });

  it('cuts mid-word rather than emptying a single very long token', () => {
    const result = truncateOnWord('x'.repeat(50), 10);
    expect(result).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('toSummary', () => {
  it('returns undefined for null, undefined and whitespace-only input', () => {
    expect(toSummary(null)).toBeUndefined();
    expect(toSummary(undefined)).toBeUndefined();
    expect(toSummary('   <p> </p>  ')).toBeUndefined();
  });

  it('never exceeds the 1000-character column budget', () => {
    const summary = toSummary(`<p>${'word '.repeat(500)}</p>`);
    expect(summary?.length).toBeLessThanOrEqual(1000);
  });
});

describe('slugify', () => {
  it('lowercases and collapses non-alphanumerics to a single dash', () => {
    expect(slugify('Cloud Native  &  Storage!')).toBe('cloud-native-storage');
  });

  it('folds diacritics so Réseau and Reseau are one tag', () => {
    expect(slugify('Réseau')).toBe(slugify('Reseau'));
    expect(slugify('Réseau')).toBe('reseau');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('  --Hello--  ')).toBe('hello');
  });

  it('keeps non-Latin scripts, which have no ASCII to fold to', () => {
    expect(slugify('Кубернетес')).toBe('кубернетес');
    expect(slugify('日本語')).toBe('日本語');
  });

  it('reports a name that cannot produce a slug', () => {
    expect(isSluggable('!!!')).toBe(false);
    expect(slugify('!!!')).toBe('');
    expect(isSluggable('ok')).toBe(true);
  });
});
