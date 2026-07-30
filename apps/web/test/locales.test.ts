/**
 * The copy contract: no string is hardcoded in a component, and no `t()` call
 * points at a key that does not exist (04-SPEC-frontend.md 6).
 *
 * The translation helper throws on a missing key in DEV, so a page test would
 * catch it -- but only on a branch that test happens to render. This checks every
 * call site.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../src/locales/en.json';

// vitest runs with the package root as cwd; import.meta.url is rewritten by the
// transform and does not reliably resolve to a real path here.
const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const files = sourceFiles(SRC);
const contents = new Map(files.map((path) => [path, readFileSync(path, 'utf8')]));

/** `t('some.key')` and `t("some.key", { … })`, but not `t(\`interpolated.${x}\`)`. */
const LITERAL_CALL = /\bt\(\s*['"]([^'"]+)['"]/g;
/** `t(`reader.sort.${option}`)` -- a prefix whose completions must all exist. */
const TEMPLATE_CALL = /\bt\(\s*`([^`$]*)\$\{/g;
/**
 * Any quoted string, so a key referenced indirectly still counts as used.
 *
 * Navigation entries and the shortcut list hold their keys in arrays and pass them
 * to `t()` later; matching only on the call site would report every one of them as
 * dead. Looser, but it still catches a key nothing mentions at all, which is the
 * rot this guards against.
 */
const ANY_STRING = /['"`]([a-z][\w.]*\.[\w.]+)['"`]/g;

const defined = new Set(Object.keys(en as Record<string, string>));

describe('translation keys', () => {
  const used = new Set<string>();
  const prefixes = new Set<string>();

  /** Keys named at a `t()` call site: these must exist. */
  const calledDirectly = new Set<string>();

  for (const [, source] of contents) {
    for (const match of source.matchAll(LITERAL_CALL)) {
      if (match[1] !== undefined) {
        used.add(match[1]);
        calledDirectly.add(match[1]);
      }
    }
    for (const match of source.matchAll(TEMPLATE_CALL)) {
      if (match[1] !== undefined && match[1] !== '') prefixes.add(match[1]);
    }
    // Indirect references, for the unused-key check only.
    for (const match of source.matchAll(ANY_STRING)) {
      if (match[1] !== undefined && defined.has(match[1])) used.add(match[1]);
    }
  }

  it('finds call sites at all — a passing-but-vacuous test would be worthless', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(used.size).toBeGreaterThan(30);
  });

  it('every literal key used by a component exists in en.json', () => {
    const missing = [...calledDirectly].filter((key) => !defined.has(key));
    expect(missing).toEqual([]);
  });

  it('every computed key prefix has at least one definition', () => {
    // e.g. `reader.sort.${option}` requires reader.sort.* to exist.
    const unmatched = [...prefixes].filter(
      (prefix) => ![...defined].some((key) => key.startsWith(prefix)),
    );
    expect(unmatched).toEqual([]);
  });

  it('has no unused keys, so the file does not rot', () => {
    const unused = [...defined].filter(
      (key) => !used.has(key) && ![...prefixes].some((prefix) => key.startsWith(prefix)),
    );
    expect(unused).toEqual([]);
  });

  it('has no empty values', () => {
    // `sources.column.actions` is intentionally blank: it labels an action column
    // whose header must stay visually empty.
    const blank = Object.entries(en as Record<string, string>)
      .filter(([key, value]) => value.trim() === '' && key !== 'sources.column.actions')
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });
});

describe('hardcoded copy', () => {
  it('no component renders a bare string literal as JSX text', () => {
    // A crude but effective check: JSX text nodes of two or more words with no
    // surrounding braces. Punctuation-only separators are allowed.
    const offenders: string[] = [];
    const JSX_TEXT = />\s*([A-Z][a-zA-Z]+(?: [a-z][a-zA-Z]+){1,})\s*</g;

    for (const [path, source] of contents) {
      for (const match of source.matchAll(JSX_TEXT)) {
        offenders.push(`${path.replace(SRC, 'src')}: "${match[1] ?? ''}"`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
