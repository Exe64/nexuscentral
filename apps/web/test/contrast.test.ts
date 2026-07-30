/**
 * The contrast guarantee (04-SPEC-frontend.md 5.5).
 *
 * Non-negotiable: body text at 4.5:1 or better, large text and UI borders at 3:1
 * or better, **in both themes at every accent hue**. Twelve hues sampled around
 * the wheel, which is the point where an HSL ramp would fall apart and an OKLCH
 * one should not.
 *
 * The failure messages name the hue, the theme and the measured ratio, because a
 * bare "expected 4.2 to be at least 4.5" would send someone hunting.
 */

import { describe, expect, it } from 'vitest';
import { CONTRAST, contrastRatio, isOutOfGamut, type Oklch } from '../src/lib/oklch.ts';
import { resolveTokens, type ThemeName } from './helpers/css-tokens.ts';
import { TAG_COLORS } from '@feedhub/shared';

/** Every 30 degrees, so yellows, greens and violets are all represented. */
const HUES = Array.from({ length: 12 }, (_unused, index) => index * 30);

/** The two chroma settings the UI offers: "Muted" and "Vivid". */
const CHROMAS = [0.06, 0.14];

const THEMES: ThemeName[] = ['light', 'dark'];

interface Case {
  theme: ThemeName;
  hue: number;
  chroma: number;
  tokens: Map<string, Oklch>;
}

const CASES: Case[] = THEMES.flatMap((theme) =>
  HUES.flatMap((hue) =>
    CHROMAS.map((chroma) => ({
      theme,
      hue,
      chroma,
      tokens: resolveTokens({ theme, accentHue: hue, accentChroma: chroma }),
    })),
  ),
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
    `${label} in ${context.theme} at hue ${context.hue}, chroma ${context.chroma}: ` +
      `measured ${measured.toFixed(2)}:1, needs ${minimum}:1`,
  ).toBeGreaterThanOrEqual(minimum);
}

describe('body text contrast at every sampled hue', () => {
  it.each(CASES)('text-primary on bg-base — $theme, hue $hue, chroma $chroma', (context) => {
    assertAtLeast(
      '--text-primary on --bg-base',
      ratio(context.tokens, '--text-primary', '--bg-base'),
      CONTRAST.bodyText,
      context,
    );
  });

  it.each(CASES)('text-primary on every surface — $theme, hue $hue, chroma $chroma', (context) => {
    // A token that passes on the base background but fails on a raised card is
    // still a failure the user meets.
    for (const surface of ['--bg-surface', '--bg-raised', '--bg-hover']) {
      assertAtLeast(
        `--text-primary on ${surface}`,
        ratio(context.tokens, '--text-primary', surface),
        CONTRAST.bodyText,
        context,
      );
    }
  });

  it.each(CASES)(
    'text-secondary on bg-base and bg-surface — $theme, hue $hue, chroma $chroma',
    (context) => {
      // Secondary text is still body text: source names and timestamps are read,
      // not decoration.
      for (const surface of ['--bg-base', '--bg-surface']) {
        assertAtLeast(
          `--text-secondary on ${surface}`,
          ratio(context.tokens, '--text-secondary', surface),
          CONTRAST.bodyText,
          context,
        );
      }
    },
  );

  it.each(CASES)('accent-fg on accent — $theme, hue $hue, chroma $chroma', (context) => {
    // The spec calls this one out by name: a button label on its own fill.
    assertAtLeast(
      '--accent-fg on --accent',
      ratio(context.tokens, '--accent-fg', '--accent'),
      CONTRAST.bodyText,
      context,
    );
  });

  it.each(CASES)('visited links stay readable — $theme, hue $hue, chroma $chroma', (context) => {
    assertAtLeast(
      '--text-visited on --bg-base',
      ratio(context.tokens, '--text-visited', '--bg-base'),
      CONTRAST.largeText,
      context,
    );
  });
});

describe('large text and UI borders', () => {
  it.each(CASES)('muted text — $theme, hue $hue, chroma $chroma', (context) => {
    // Muted text is used for large or non-essential labels only, so 3:1 applies.
    assertAtLeast(
      '--text-muted on --bg-base',
      ratio(context.tokens, '--text-muted', '--bg-base'),
      CONTRAST.largeText,
      context,
    );
  });

  it.each(CASES)('strong borders — $theme, hue $hue, chroma $chroma', (context) => {
    assertAtLeast(
      '--border-strong on --bg-base',
      ratio(context.tokens, '--border-strong', '--bg-base'),
      CONTRAST.largeText,
      context,
    );
  });

  it.each(CASES)('the accent as a focus ring — $theme, hue $hue, chroma $chroma', (context) => {
    // The focus outline is `2px solid var(--accent)`; it has to be visible against
    // whatever it surrounds, at every hue.
    for (const surface of ['--bg-base', '--bg-surface', '--bg-raised']) {
      assertAtLeast(
        `--accent on ${surface}`,
        ratio(context.tokens, '--accent', surface),
        CONTRAST.largeText,
        context,
      );
    }
  });
});

describe('fixed palettes do not follow the accent', () => {
  it.each(CASES)('status colours stay readable — $theme, hue $hue, chroma $chroma', (context) => {
    // Status colours are rendered as text, so 4.5:1. An error must stay red when
    // the accent is red, and legible whatever the accent is doing to the neutrals.
    for (const status of ['--positive', '--negative', '--warning']) {
      assertAtLeast(
        `${status} on --bg-base`,
        ratio(context.tokens, status, '--bg-base'),
        CONTRAST.bodyText,
        context,
      );
    }
  });

  it.each(THEMES)('status hues do not move with the accent in %s', (theme) => {
    // The whole point of a fixed hue: a red accent must not turn errors purple.
    const atBlue = resolveTokens({ theme, accentHue: 250, accentChroma: 0.14 });
    const atRed = resolveTokens({ theme, accentHue: 25, accentChroma: 0.14 });

    for (const status of ['--positive', '--negative', '--warning']) {
      expect(atRed.get(status), status).toEqual(atBlue.get(status));
    }
  });

  it.each(THEMES)('every tag colour is legible in %s', (theme) => {
    const tokens = resolveTokens({ theme, accentHue: 250, accentChroma: 0.14 });

    for (const colour of TAG_COLORS) {
      const measured = ratio(tokens, `--tag-${colour}-fg`, `--tag-${colour}-bg`);
      expect(
        measured,
        `tag "${colour}" in ${theme}: measured ${measured.toFixed(2)}:1, needs ${CONTRAST.bodyText}:1`,
      ).toBeGreaterThanOrEqual(CONTRAST.bodyText);
    }
  });

  it('declares a token pair for every tag colour the schema allows', () => {
    // A colour in the enum with no token would render as an unstyled chip.
    const tokens = resolveTokens({ theme: 'light', accentHue: 250, accentChroma: 0.14 });
    for (const colour of TAG_COLORS) {
      expect(tokens.has(`--tag-${colour}-bg`), `--tag-${colour}-bg`).toBe(true);
      expect(tokens.has(`--tag-${colour}-fg`), `--tag-${colour}-fg`).toBe(true);
    }
  });
});

describe('the palette is displayable', () => {
  it.each(THEMES)('no fixed-palette colour is clipped by sRGB in %s', (theme) => {
    // These constants are ours to choose, so there is no excuse for one that the
    // display cannot show. The accent ramp is a different matter: at L 0.97 the
    // most constrained hue admits 0.013 chroma and the UI offers 0.14, so clipping
    // there is inherent to the spec's design rather than a defect. The contrast
    // assertions above measure the clipped colour, which is the one users see.
    const tokens = resolveTokens({ theme, accentHue: 250, accentChroma: 0.14 });

    const fixed = [...tokens.entries()].filter(
      ([name]) =>
        name.startsWith('--tag-') || ['--positive', '--negative', '--warning'].includes(name),
    );

    const clipped = fixed.filter(([, colour]) => isOutOfGamut(colour)).map(([name]) => name);
    expect(clipped, `clipped fixed colours in ${theme}`).toEqual([]);
  });

  it('reports how much of the accent ramp is clipped, without failing on it', () => {
    // Not an assertion about quality, a record of a known consequence: if this
    // number grows a lot, someone changed the ramp's lightness or chroma factors.
    const clippedPerCase = CASES.map((context) => {
      const accentTokens = [...context.tokens.entries()].filter(([name]) =>
        name.startsWith('--accent-'),
      );
      return accentTokens.filter(([, colour]) => isOutOfGamut(colour)).length;
    });

    const worst = Math.max(...clippedPerCase);
    const atMutedChroma = Math.max(
      ...CASES.filter((context) => context.chroma === 0.06).map((context) => {
        const accentTokens = [...context.tokens.entries()].filter(([name]) =>
          name.startsWith('--accent-'),
        );
        return accentTokens.filter(([, colour]) => isOutOfGamut(colour)).length;
      }),
    );

    // Twelve accent tokens (ten ramp steps plus the two aliases). The bound is set
    // just above what the current ramp does, so a change that clips noticeably more
    // trips it. The "Muted" setting should clip far less than "Vivid" -- if it did
    // not, the chroma control would be doing nothing.
    expect(worst, `worst case clipped ${worst} accent tokens`).toBeLessThanOrEqual(8);
    expect(atMutedChroma, 'muted chroma should clip less than vivid').toBeLessThan(worst);
  });
});

describe('the parser is reading the real stylesheet', () => {
  it('resolves the derived ramp rather than a hardcoded copy', () => {
    // If the parser silently failed and returned defaults, every test above would
    // pass while measuring nothing.
    const muted = resolveTokens({ theme: 'light', accentHue: 250, accentChroma: 0.06 });
    const vivid = resolveTokens({ theme: 'light', accentHue: 250, accentChroma: 0.14 });

    expect(muted.get('--accent-500')?.c).toBeCloseTo(0.06, 5);
    expect(vivid.get('--accent-500')?.c).toBeCloseTo(0.14, 5);
    // calc(var(--accent-c) * 0.55) on accent-200.
    expect(vivid.get('--accent-200')?.c).toBeCloseTo(0.14 * 0.55, 5);
    // The hue reaches the neutrals, which is what makes the accent picker feel
    // like it changes the app rather than just recolouring the buttons.
    expect(
      resolveTokens({ theme: 'dark', accentHue: 30, accentChroma: 0.14 }).get('--bg-base')?.h,
    ).toBe(30);
  });

  it('follows an alias to its target', () => {
    const tokens = resolveTokens({ theme: 'light', accentHue: 250, accentChroma: 0.14 });
    // --accent is var(--accent-600) in the light theme.
    expect(tokens.get('--accent')).toEqual(tokens.get('--accent-600'));
  });
});
