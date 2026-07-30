/**
 * Theming behaviour (04-SPEC-frontend.md 5.1).
 *
 * Two acceptance criteria live here: reloading in dark mode produces no white
 * flash, and changing the accent survives a reload.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  CHROMA_MUTED,
  CHROMA_VIVID,
  clampChroma,
  clampHue,
  resolveMode,
  STORAGE_KEY,
} from '../src/theme/store.ts';

const INDEX_HTML = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

function setPrefersDark(dark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('dark') ? dark : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  // happy-dom exposes matchMedia on window too.
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
  setPrefersDark(false);
});

describe('the no-flash guard', () => {
  it('is inline in index.html, before any stylesheet', () => {
    // A module import would resolve after the first paint. That frame is the flash.
    const scriptAt = INDEX_HTML.indexOf('feedhub.theme');
    const moduleAt = INDEX_HTML.indexOf('src="/src/main.tsx"');

    expect(scriptAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeLessThan(moduleAt);
    // No external stylesheet may load before it either.
    const stylesheetAt = INDEX_HTML.indexOf('rel="stylesheet"');
    expect(stylesheetAt === -1 || stylesheetAt > scriptAt).toBe(true);
  });

  it('reads the same storage key the store writes', () => {
    expect(INDEX_HTML).toContain(`'${STORAGE_KEY}'`);
  });

  /** Run the actual inline script from index.html against the current globals. */
  function runInlineScript(): void {
    const match = /<script>([\s\S]*?)<\/script>/.exec(INDEX_HTML);
    if (match?.[1] === undefined) throw new Error('No inline script found in index.html');
    new Function(match[1])();
  }

  it('applies the stored dark theme before anything else runs', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'dark', hue: 30, chroma: 0.06 }));

    runInlineScript();

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--accent-h')).toBe('30');
    expect(document.documentElement.style.getPropertyValue('--accent-c')).toBe('0.06');
  });

  it('follows the OS preference in system mode', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'system' }));
    setPrefersDark(true);

    runInlineScript();

    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('falls back to light rather than throwing on a corrupt cache', () => {
    localStorage.setItem(STORAGE_KEY, 'not json at all');

    expect(() => runInlineScript()).not.toThrow();
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('defaults to light with nothing stored and a light OS', () => {
    runInlineScript();
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});

describe('applyTheme', () => {
  it('always writes a concrete theme, never "system"', () => {
    // So no stylesheet has to branch on a media query.
    setPrefersDark(true);
    applyTheme({ mode: 'system', hue: 250, chroma: CHROMA_VIVID });
    expect(document.documentElement.dataset['theme']).toBe('dark');

    setPrefersDark(false);
    applyTheme({ mode: 'system', hue: 250, chroma: CHROMA_VIVID });
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('writes the accent as custom properties on the root', () => {
    applyTheme({ mode: 'light', hue: 120, chroma: CHROMA_MUTED });

    // The whole UI reads these, which is what makes the picker feel global.
    expect(document.documentElement.style.getPropertyValue('--accent-h')).toBe('120');
    expect(document.documentElement.style.getPropertyValue('--accent-c')).toBe('0.06');
  });

  it('overrides the OS preference when the mode is explicit', () => {
    setPrefersDark(true);
    applyTheme({ mode: 'light', hue: 250, chroma: CHROMA_VIVID });
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});

describe('the store survives a reload', () => {
  it('persists the accent and reads it back into a fresh module instance', async () => {
    const { useThemeStore } = await import('../src/theme/store.ts');

    useThemeStore.getState().setHue(42);
    useThemeStore.getState().setChroma(CHROMA_MUTED);
    useThemeStore.getState().setMode('dark');

    // What a reload sees.
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored).toEqual({ mode: 'dark', hue: 42, chroma: CHROMA_MUTED });

    vi.resetModules();
    const reloaded = await import('../src/theme/store.ts');
    expect(reloaded.useThemeStore.getState().hue).toBe(42);
    expect(reloaded.useThemeStore.getState().mode).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('does not persist a drag preview', async () => {
    vi.resetModules();
    const { useThemeStore } = await import('../src/theme/store.ts');
    useThemeStore.getState().setHue(100);

    useThemeStore.getState().previewHue(200);

    // Applied to the page...
    expect(document.documentElement.style.getPropertyValue('--accent-h')).toBe('200');
    // ...but not written to storage sixty times a second.
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { hue: number };
    expect(stored.hue).toBe(100);
  });

  it('adopts the server value, because the database is the source of truth', async () => {
    vi.resetModules();
    const { useThemeStore } = await import('../src/theme/store.ts');
    useThemeStore.getState().setHue(10);

    useThemeStore.getState().adoptFromServer({ mode: 'light', hue: 300, chroma: CHROMA_VIVID });

    expect(useThemeStore.getState().hue).toBe(300);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { hue: number };
    expect(stored.hue).toBe(300);
  });

  it('ignores a corrupt cache rather than failing to start', async () => {
    localStorage.setItem(STORAGE_KEY, '{{{');
    vi.resetModules();
    const { useThemeStore, DEFAULT_THEME } = await import('../src/theme/store.ts');
    expect(useThemeStore.getState().hue).toBe(DEFAULT_THEME.hue);
  });
});

describe('input clamping', () => {
  it('keeps the hue on the wheel and the chroma inside what the column allows', () => {
    expect(clampHue(-20)).toBe(0);
    expect(clampHue(400)).toBe(360);
    expect(clampHue(180.6)).toBe(181);

    // The CHECK constraint on settings.accent_chroma is 0..0.37.
    expect(clampChroma(-1)).toBe(0);
    expect(clampChroma(5)).toBe(0.37);
  });

  it('resolves system against the OS preference', () => {
    setPrefersDark(true);
    expect(resolveMode('system')).toBe('dark');
    expect(resolveMode('light')).toBe('light');
    setPrefersDark(false);
    expect(resolveMode('system')).toBe('light');
  });
});
