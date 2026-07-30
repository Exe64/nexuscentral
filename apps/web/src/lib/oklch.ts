/**
 * OKLCH to sRGB, and WCAG contrast.
 *
 * Needed because the contrast guarantee is a unit test, and a unit test has no
 * browser to ask. The conversion is Björn Ottosson's OKLab, which is what the CSS
 * `oklch()` function implements.
 *
 * Out-of-gamut colours are clamped before luminance is computed, deliberately: a
 * display clips them, so the contrast a user actually sees is the contrast of the
 * clipped colour. Measuring the unclipped value would flatter the palette.
 */

export interface Oklch {
  /** Perceptual lightness, 0..1. */
  l: number;
  /** Chroma, 0..~0.37 for sRGB. */
  c: number;
  /** Hue in degrees. */
  h: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** OKLCH to linear-light sRGB, before gamma encoding and before clamping. */
function oklchToLinearRgb({ l, c, h }: Oklch): Rgb {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const bb = c * Math.sin(radians);

  const lCube = (l + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const sCube = (l - 0.0894841775 * a - 1.291485548 * bb) ** 3;

  return {
    r: 4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    g: -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    b: -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  };
}

function gammaEncode(channel: number): number {
  const sign = channel < 0 ? -1 : 1;
  const magnitude = Math.abs(channel);
  return magnitude <= 0.0031308 ? 12.92 * channel : sign * (1.055 * magnitude ** (1 / 2.4) - 0.055);
}

function gammaDecode(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** True when the colour cannot be shown in sRGB and would be clipped. */
export function isOutOfGamut(colour: Oklch, tolerance = 0.001): boolean {
  const linear = oklchToLinearRgb(colour);
  return [linear.r, linear.g, linear.b].some(
    (channel) => channel < -tolerance || channel > 1 + tolerance,
  );
}

/** OKLCH to displayable sRGB, each channel 0..1. */
export function oklchToSrgb(colour: Oklch): Rgb {
  const linear = oklchToLinearRgb(colour);
  return {
    r: clamp01(gammaEncode(linear.r)),
    g: clamp01(gammaEncode(linear.g)),
    b: clamp01(gammaEncode(linear.b)),
  };
}

export function oklchToHex(colour: Oklch): string {
  const { r, g, b } = oklchToSrgb(colour);
  const channel = (value: number): string =>
    Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * WCAG 2.1 relative luminance.
 *
 * Computed from the clamped, displayable values so the figure matches the screen.
 */
export function relativeLuminance(colour: Oklch): number {
  const { r, g, b } = oklchToSrgb(colour);
  return 0.2126 * gammaDecode(r) + 0.7152 * gammaDecode(g) + 0.0722 * gammaDecode(b);
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The thresholds the project holds itself to (04-SPEC-frontend.md 5.5). */
export const CONTRAST = {
  /** Body text. */
  bodyText: 4.5,
  /** Large text and UI borders. */
  largeText: 3,
} as const;
