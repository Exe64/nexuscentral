/**
 * Read the shipped token stylesheet and resolve its custom properties.
 *
 * The contrast test parses `tokens.css` rather than a TypeScript copy of it. That
 * matters: a duplicated palette drifts, and a passing test against the copy would
 * say nothing about what users see. Whatever anyone edits in the CSS, the test
 * follows.
 *
 * The subset of CSS understood here is exactly what the file uses: custom property
 * declarations, `oklch(L C H)`, `var(--name)`, and `calc(var(--name) * factor)`.
 * Anything else raises rather than being silently skipped.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThemePreset } from '@nexuscentral/shared';
import type { Oklch } from '../../src/lib/oklch.ts';

const TOKENS_PATH = join(process.cwd(), 'src', 'styles', 'tokens.css');
const PRESETS_PATH = join(process.cwd(), 'src', 'styles', 'presets.css');

/** Declarations grouped by the selector they appeared under. */
type Blocks = Map<string, Map<string, string>>;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseBlocks(css: string): Blocks {
  const blocks: Blocks = new Map();
  const pattern = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of stripComments(css).matchAll(pattern)) {
    const selector = (match[1] ?? '').trim();
    const body = match[2] ?? '';

    // A selector can appear more than once; later declarations win, as in CSS.
    const declarations = blocks.get(selector) ?? new Map<string, string>();

    for (const line of body.split(';')) {
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (name.startsWith('--')) declarations.set(name, value);
    }

    blocks.set(selector, declarations);
  }

  return blocks;
}

export type ThemeName = 'light' | 'dark';

export interface ResolveOptions {
  theme: ThemeName;
  accentHue: number;
  accentChroma: number;
  /** `default` uses the derived ramp; anything else overrides it. */
  preset?: ThemePreset;
}

const CALC_PATTERN = /^calc\(\s*var\((--[\w-]+)\)\s*\*\s*([\d.]+)\s*\)$/;
const VAR_PATTERN = /^var\((--[\w-]+)\)$/;

/**
 * Split the three components of an `oklch(...)` value.
 *
 * Splitting on whitespace would break the moment a component is itself a function
 * call: `calc(var(--accent-c) * 0.2)` contains spaces. So the split happens only
 * at parenthesis depth zero.
 */
function oklchComponents(expression: string): [string, string, string] | null {
  const trimmed = expression.trim();
  if (!trimmed.startsWith('oklch(') || !trimmed.endsWith(')')) return null;

  const body = trimmed.slice('oklch('.length, -1);
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const character of body) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;

    if (depth === 0 && /\s/.test(character)) {
      if (current !== '') {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (current !== '') parts.push(current);

  if (parts.length !== 3) return null;
  return [parts[0] as string, parts[1] as string, parts[2] as string];
}

/**
 * Resolve every colour token for one theme and one accent setting.
 *
 * Mirrors the cascade the browser applies: `:root` first, then the theme block,
 * then any later block for the same selector.
 */
export function resolveTokens(options: ResolveOptions): Map<string, Oklch> {
  const preset = options.preset ?? 'default';

  const raw = new Map<string, string>();

  // Base layer: the derived ramp and the per-theme semantic tokens.
  for (const [selector, declarations] of parseBlocks(readFileSync(TOKENS_PATH, 'utf8'))) {
    const applies =
      selector === ':root' ||
      selector === `[data-theme='${options.theme}']` ||
      selector === `[data-theme="${options.theme}"]`;
    if (!applies) continue;
    for (const [name, value] of declarations) raw.set(name, value);
  }

  // Preset layer, applied on top -- the same order the cascade produces, since a
  // preset selector is strictly more specific than a theme selector.
  if (preset !== 'default') {
    let matched = false;
    for (const [selector, declarations] of parseBlocks(readFileSync(PRESETS_PATH, 'utf8'))) {
      const normalised = selector.replace(/"/g, "'");
      if (normalised !== `[data-preset='${preset}'][data-theme='${options.theme}']`) continue;
      matched = true;
      for (const [name, value] of declarations) raw.set(name, value);
    }
    // A preset with no block for one of the two modes would silently fall back to
    // the derived theme, which is exactly the bug this guards against.
    if (!matched) {
      throw new Error(`Preset "${preset}" declares no block for the ${options.theme} theme`);
    }
  }

  // The accent settings are what the app writes onto <html> at runtime.
  raw.set('--accent-h', String(options.accentHue));
  raw.set('--accent-c', String(options.accentChroma));

  const resolved = new Map<string, Oklch>();
  const inProgress = new Set<string>();

  const scalar = (expression: string): number => {
    const trimmed = expression.trim();

    const calc = CALC_PATTERN.exec(trimmed);
    if (calc !== null) {
      return scalar(raw.get(calc[1] as string) ?? '') * Number.parseFloat(calc[2] as string);
    }

    const reference = VAR_PATTERN.exec(trimmed);
    if (reference !== null) return scalar(raw.get(reference[1] as string) ?? '');

    const value = Number.parseFloat(trimmed);
    if (Number.isNaN(value)) throw new Error(`Cannot evaluate "${expression}" as a number`);
    return value;
  };

  const colour = (name: string): Oklch => {
    const cached = resolved.get(name);
    if (cached !== undefined) return cached;

    if (inProgress.has(name)) throw new Error(`Circular token reference at ${name}`);
    inProgress.add(name);

    const expression = raw.get(name);
    if (expression === undefined) throw new Error(`Token ${name} is not declared`);

    const reference = VAR_PATTERN.exec(expression);
    const value =
      reference !== null
        ? colour(reference[1] as string)
        : (() => {
            const parts = oklchComponents(expression);
            if (parts === null) {
              throw new Error(`Token ${name} is not an oklch() or var() value: "${expression}"`);
            }
            return { l: scalar(parts[0]), c: scalar(parts[1]), h: scalar(parts[2]) };
          })();

    inProgress.delete(name);
    resolved.set(name, value);
    return value;
  };

  for (const name of raw.keys()) {
    // The two inputs are plain numbers, not colours.
    if (name === '--accent-h' || name === '--accent-c') continue;
    colour(name);
  }

  return resolved;
}

/** Every token name declared for a theme, for tests that assert coverage. */
export function tokenNames(theme: ThemeName): string[] {
  return [...resolveTokens({ theme, accentHue: 250, accentChroma: 0.14 }).keys()];
}
