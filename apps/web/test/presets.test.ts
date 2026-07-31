/**
 * Named presets are held to the same contrast floor as the derived theme.
 *
 * That is the whole reason these are "inspired by" rather than transcriptions:
 * canonical Solarized puts its light body text at 4.13:1 on its own background and
 * its secondary text at 2.48:1. The hues are kept; the lightness is not.
 */

import { describe, expect, it } from 'vitest';
import { DARK_NATIVE_PRESETS, THEME_PRESETS, type ThemePreset } from '@nexuscentral/shared';
import { CONTRAST, contrastRatio, isOutOfGamut, type Oklch } from '../src/lib/oklch.ts';
import { resolveTokens, type ThemeName } from './helpers/css-tokens.ts';

const NAMED: ThemePreset[] = THEME_PRESETS.filter((preset) => preset !== 'default');
const THEMES: ThemeName[] = ['light', 'dark'];

interface Case {
  preset: ThemePreset;
  theme: ThemeName;
  tokens: Map<string, Oklch>;
}

const CASES: Case[] = NAMED.flatMap((preset) =>
  THEMES.map((theme) => ({
    preset,
    theme,
    // The accent settings must not matter under a preset; using a deliberately
    // garish one proves it.
    tokens: resolveTokens({ theme, preset, accentHue: 320, accentChroma: 0.14 }),
  })),
);

function ratio(tokens: Map<string, Oklch>, foreground: string, background: string): number {
  const fg = tokens.get(foreground);
  const bg = tokens.get(background);
  if (fg === undefined) throw new Error(`Missing token ${foreground}`);
  if (bg === undefined) throw new Error(`Missing token ${background}`);
  return contrastRatio(fg, bg);
}

function assertAtLeast(label: string, measured: number, minimum: number, context: Case): void {
  expect(
    measured,
    `${label} in ${context.preset}/${context.theme}: measured ${measured.toFixed(2)}:1, needs ${minimum}:1`,
  ).toBeGreaterThanOrEqual(minimum);
}

describe('every preset clears the body-text floor', () => {
  it.each(CASES)('$preset / $theme — primary text on every surface', (context) => {
    for (const surface of ['--bg-base', '--bg-surface', '--bg-raised', '--bg-hover']) {
      assertAtLeast(
        `--text-primary on ${surface}`,
        ratio(context.tokens, '--text-primary', surface),
        CONTRAST.bodyText,
        context,
      );
    }
  });

  it.each(CASES)('$preset / $theme — secondary text is still body text', (context) => {
    // Source names and timestamps get read, so they are not decoration.
    for (const surface of ['--bg-base', '--bg-surface', '--bg-raised']) {
      assertAtLeast(
        `--text-secondary on ${surface}`,
        ratio(context.tokens, '--text-secondary', surface),
        CONTRAST.bodyText,
        context,
      );
    }
  });

  it.each(CASES)('$preset / $theme — a link is readable', (context) => {
    assertAtLeast(
      '--accent on --bg-base',
      ratio(context.tokens, '--accent', '--bg-base'),
      CONTRAST.bodyText,
      context,
    );
    assertAtLeast(
      '--accent-hover on --bg-base',
      ratio(context.tokens, '--accent-hover', '--bg-base'),
      CONTRAST.bodyText,
      context,
    );
  });

  it.each(CASES)('$preset / $theme — a label on an accent fill', (context) => {
    assertAtLeast(
      '--accent-fg on --accent',
      ratio(context.tokens, '--accent-fg', '--accent'),
      CONTRAST.bodyText,
      context,
    );
  });

  it.each(CASES)('$preset / $theme — status colours are readable', (context) => {
    for (const status of ['--positive', '--negative', '--warning']) {
      assertAtLeast(
        `${status} on --bg-base`,
        ratio(context.tokens, status, '--bg-base'),
        CONTRAST.bodyText,
        context,
      );
    }
  });

  it.each(CASES)('$preset / $theme — primary text on the accent-subtle fill', (context) => {
    // The focused reader row and the active nav item both use this as a surface.
    assertAtLeast(
      '--text-primary on --accent-subtle',
      ratio(context.tokens, '--text-primary', '--accent-subtle'),
      CONTRAST.bodyText,
      context,
    );
  });
});

describe('every preset clears the large-text and UI floor', () => {
  it.each(CASES)('$preset / $theme — muted text and strong borders', (context) => {
    assertAtLeast(
      '--text-muted on --bg-base',
      ratio(context.tokens, '--text-muted', '--bg-base'),
      CONTRAST.largeText,
      context,
    );
    assertAtLeast(
      '--border-strong on --bg-base',
      ratio(context.tokens, '--border-strong', '--bg-base'),
      CONTRAST.largeText,
      context,
    );
  });

  it.each(CASES)('$preset / $theme — the focus ring is visible on every surface', (context) => {
    for (const surface of ['--bg-base', '--bg-surface', '--bg-raised']) {
      assertAtLeast(
        `--accent on ${surface}`,
        ratio(context.tokens, '--accent', surface),
        CONTRAST.largeText,
        context,
      );
    }
  });

  it.each(CASES)('$preset / $theme — visited links stay distinguishable', (context) => {
    assertAtLeast(
      '--text-visited on --bg-base',
      ratio(context.tokens, '--text-visited', '--bg-base'),
      CONTRAST.largeText,
      context,
    );
  });
});

describe('presets are complete and displayable', () => {
  const REQUIRED = [
    '--bg-base',
    '--bg-surface',
    '--bg-raised',
    '--bg-hover',
    '--border-subtle',
    '--border-strong',
    '--text-primary',
    '--text-secondary',
    '--text-muted',
    '--text-visited',
    '--accent',
    '--accent-hover',
    '--accent-fg',
    '--accent-subtle',
    '--positive',
    '--negative',
    '--warning',
  ];

  it.each(CASES)('$preset / $theme — overrides every semantic token', (context) => {
    // Inheriting one from the derived theme would leave a stray accent-tinted
    // colour in the middle of a fixed palette.
    const derived = resolveTokens({
      theme: context.theme,
      accentHue: 320,
      accentChroma: 0.14,
    });

    const inherited = REQUIRED.filter((name) => {
      const preset = context.tokens.get(name);
      const base = derived.get(name);
      return (
        preset !== undefined &&
        base !== undefined &&
        preset.l === base.l &&
        preset.c === base.c &&
        preset.h === base.h
      );
    });

    expect(inherited, `${context.preset}/${context.theme} left these on the derived theme`).toEqual(
      [],
    );
  });

  it.each(CASES)('$preset / $theme — nothing is clipped by sRGB', (context) => {
    // These are hand-picked constants, so there is no excuse for one the display
    // cannot show.
    const clipped = REQUIRED.filter((name) => {
      const colour = context.tokens.get(name);
      return colour !== undefined && isOutOfGamut(colour);
    });
    expect(clipped, `clipped in ${context.preset}/${context.theme}`).toEqual([]);
  });

  it.each(CASES)('$preset / $theme — ignores the accent entirely', (context) => {
    // A preset that still moved with the accent hue would make the picker look
    // half-broken rather than deliberately disabled.
    const atOtherAccent = resolveTokens({
      theme: context.theme,
      preset: context.preset,
      accentHue: 40,
      accentChroma: 0.06,
    });

    for (const name of REQUIRED) {
      expect(atOtherAccent.get(name), `${name} moved with the accent`).toEqual(
        context.tokens.get(name),
      );
    }
  });

  it.each(NAMED)('%s declares both a light and a dark variant', (preset) => {
    // resolveTokens throws when a block is missing, so this is the assertion.
    expect(() =>
      resolveTokens({ theme: 'light', preset, accentHue: 250, accentChroma: 0.14 }),
    ).not.toThrow();
    expect(() =>
      resolveTokens({ theme: 'dark', preset, accentHue: 250, accentChroma: 0.14 }),
    ).not.toThrow();
  });
});

describe('the palettes still look like themselves', () => {
  it('keeps Solarized on its own hues', () => {
    // Adjusting lightness is the compromise; changing hue would make the name a
    // lie. base03 is at hue 220, base3 at 90.
    const dark = resolveTokens({
      theme: 'dark',
      preset: 'solarized',
      accentHue: 250,
      accentChroma: 0.14,
    });
    const light = resolveTokens({
      theme: 'light',
      preset: 'solarized',
      accentHue: 250,
      accentChroma: 0.14,
    });

    expect(dark.get('--bg-base')?.h).toBeCloseTo(220, 0);
    expect(light.get('--bg-base')?.h).toBeCloseTo(90, 0);
    // Solarized blue.
    expect(dark.get('--accent')?.h).toBeCloseTo(245, 0);
  });

  it('keeps the phosphor presets monochrome, apart from their alarms', () => {
    for (const [preset, hue] of [
      ['terminal', 145],
      ['vt220', 75],
    ] as const) {
      const tokens = resolveTokens({ theme: 'dark', preset, accentHue: 250, accentChroma: 0.14 });
      for (const name of ['--bg-base', '--text-primary', '--text-secondary', '--accent']) {
        expect(tokens.get(name)?.h, `${preset} ${name}`).toBeCloseTo(hue, 0);
      }
      // Red still has to be red, or an error is indistinguishable from a heading.
      expect(tokens.get('--negative')?.h).toBeCloseTo(27, 0);
    }
  });

  it('keeps the PowerShell console navy and its warning yellow', () => {
    const tokens = resolveTokens({
      theme: 'dark',
      preset: 'powershell',
      accentHue: 250,
      accentChroma: 0.14,
    });
    // #012456 converted to OKLCH.
    expect(tokens.get('--bg-base')?.l).toBeCloseTo(0.272, 2);
    expect(tokens.get('--bg-base')?.h).toBeCloseTo(258, 0);
    // #eeedf0, the console's actual foreground.
    expect(tokens.get('--text-primary')?.l).toBeCloseTo(0.948, 2);
    // Yellow accent, pulled inside the gamut.
    expect(tokens.get('--accent')?.h).toBeCloseTo(100, 0);
  });

  it('marks the dark-native presets as such', () => {
    expect(DARK_NATIVE_PRESETS).toContain('terminal');
    expect(DARK_NATIVE_PRESETS).toContain('vt220');
    expect(DARK_NATIVE_PRESETS).toContain('powershell');
    // Solarized is equally at home in either.
    expect(DARK_NATIVE_PRESETS).not.toContain('solarized');
  });
});
