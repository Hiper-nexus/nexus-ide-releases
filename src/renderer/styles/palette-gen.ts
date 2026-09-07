/**
 * Palette generation and contrast auditing for the status families.
 *
 * Pure: no DOM, no React, no node builtins. Safe to import from the renderer,
 * from a vitest suite, and from a tsx-driven script.
 *
 * Why this exists
 * ---------------
 * DESIGN.md §2 states the status palette as a set of finished hexes plus the
 * rule that produced them ("família calibrada ~55-60% de saturação sRGB",
 * "croma 90%, WCAG 3:1"). Until now nothing in the repo implemented the rule,
 * so the hexes could only be hand-nudged and the contrast claim could only be
 * asserted in prose. This module is the rule, made executable.
 *
 * The rule, recovered from the shipped tokens
 * -------------------------------------------
 * Every member of a family shares one lightness and one chroma; only the hue
 * changes. Chroma is expressed as a FRACTION of the maximum the sRGB gamut
 * allows at that lightness and hue, because the gamut is lopsided — amber runs
 * out of room long before red does, so an equal-absolute-chroma set leaves
 * amber visibly duller than its siblings.
 *
 * Measured back out of the hexes in base.css, the two dark bands are exactly:
 *
 *   pill  L=0.700  chroma 54.7-55.1% of gamut max
 *   dot   L=0.719  chroma 89.7-89.9% of gamut max
 *
 * which rounds to the doctrine's 0.70/55% and 0.72/90%. `generateStatusHex`
 * reproduces all seven shipped dark tokens bit-for-bit from those two bands and
 * the hues below — see palette-gen.test.ts. The light bands (0.50/60% and
 * 0.62/90%) are included because the same rule generates them, but base.css
 * does not use them yet: see docs/qa/items/F-338.md before wiring them.
 *
 * Hues were measured out of the shipped tokens and then verified to reproduce
 * them; the exact windows are documented on STATUS_HUES. Regenerate the whole
 * set from a band change; never nudge one hue, or that colour starts ranking
 * instead of identifying.
 */

export interface Oklch {
  /** Perceptual lightness, 0..1. */
  readonly l: number;
  /** Chroma. Gamut max at L=0.5 is roughly 0.19-0.26 depending on hue. */
  readonly c: number;
  /** Hue in degrees, 0..360. */
  readonly h: number;
}

/** Cartesian OKLab. Kept separate from `Oklch` so polar and rectangular values
 *  can never be passed to the wrong function. */
export interface Oklab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/** sRGB channel triple, each 0..1. */
export type Srgb = readonly [number, number, number];

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const SRGB_LINEAR_THRESHOLD = 0.04045;
const LINEAR_SRGB_THRESHOLD = 0.0031308;

/** Tolerance for the gamut search; 1/255 of a channel is below rounding. */
const GAMUT_EPSILON = 1e-4;
const GAMUT_SEARCH_UPPER_BOUND = 0.5;
const GAMUT_SEARCH_ITERATIONS = 40;

function srgbToLinear(channel: number): number {
  return channel <= SRGB_LINEAR_THRESHOLD
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= LINEAR_SRGB_THRESHOLD
    ? 12.92 * channel
    : 1.055 * channel ** (1 / 2.4) - 0.055;
}

export function hexToSrgb(hex: string): Srgb {
  if (!HEX_PATTERN.test(hex)) {
    throw new TypeError(`expected a #rgb or #rrggbb hex colour, got "${hex}"`);
  }
  const body = hex.slice(1);
  const expanded =
    body.length === 3
      ? body
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : body;
  return [
    parseInt(expanded.slice(0, 2), 16) / 255,
    parseInt(expanded.slice(2, 4), 16) / 255,
    parseInt(expanded.slice(4, 6), 16) / 255,
  ];
}

export function srgbToHex(rgb: Srgb): string {
  const toByte = (channel: number): string => {
    const clamped = Math.min(1, Math.max(0, channel));
    return Math.round(clamped * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${toByte(rgb[0])}${toByte(rgb[1])}${toByte(rgb[2])}`;
}

export function srgbToOklab(rgb: Srgb): Oklab {
  const [r, g, b] = [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    l: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/**
 * OKLab -> linear sRGB -> gamma sRGB. The result can fall outside 0..1 for
 * out-of-gamut OKLCH inputs; callers that need a displayable colour use
 * `oklchToHex`, which clips.
 */
export function oklabToSrgb(lab: Oklab): Srgb {
  const l_ = lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function srgbToOklch(rgb: Srgb): Oklch {
  const lab = srgbToOklab(rgb);
  const chroma = Math.hypot(lab.a, lab.b);
  let hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { l: lab.l, c: chroma, h: hue };
}

export function oklchToSrgb(o: Oklch): Srgb {
  const radians = (o.h * Math.PI) / 180;
  return oklabToSrgb({
    l: o.l,
    a: o.c * Math.cos(radians),
    b: o.c * Math.sin(radians),
  });
}

/** Clips to the sRGB cube. Use `maxChromaAt` first if clipping is not wanted. */
export function oklchToHex(o: Oklch): string {
  return srgbToHex(oklchToSrgb(o));
}

export function hexToOklch(hex: string): Oklch {
  return srgbToOklch(hexToSrgb(hex));
}

function isInGamut(rgb: Srgb): boolean {
  return rgb.every(
    (channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON,
  );
}

/**
 * Largest chroma at (lightness, hue) that still lands inside sRGB. This is what
 * makes `chromaFraction` meaningful: 90% of gamut max is a comparable amount of
 * colour at every hue, whereas an absolute chroma is not.
 */
export function maxChromaAt(l: number, h: number): number {
  let low = 0;
  let high = GAMUT_SEARCH_UPPER_BOUND;
  for (let i = 0; i < GAMUT_SEARCH_ITERATIONS; i += 1) {
    const mid = (low + high) / 2;
    if (isInGamut(oklchToSrgb({ l, c: mid, h }))) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

/** WCAG 2.x relative luminance of a hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToSrgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21, symmetric in its arguments. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** A lightness plus a chroma expressed as a fraction of the gamut maximum. */
export interface PaletteBand {
  readonly lightness: number;
  readonly chromaFraction: number;
}

export const DARK_STATUS_BAND: PaletteBand = { lightness: 0.7, chromaFraction: 0.55 };
export const DARK_STATUS_DOT_BAND: PaletteBand = { lightness: 0.72, chromaFraction: 0.9 };
export const LIGHT_STATUS_BAND: PaletteBand = { lightness: 0.5, chromaFraction: 0.6 };
export const LIGHT_STATUS_DOT_BAND: PaletteBand = { lightness: 0.62, chromaFraction: 0.9 };

export type StatusHueName = 'success' | 'danger' | 'warning' | 'merged' | 'running';

/**
 * One hue per family, measured from the shipped tokens and then verified: each
 * value below sits inside the window that reproduces BOTH the pill and the dot
 * hex bit-for-bit from the two dark bands (success 149.80-150.01,
 * danger 26.94-27.18, warning 70.24-70.69, merged 299.48-300.34). Picking the
 * centre of each window keeps the round-trip stable under small band changes.
 *
 * Regenerate the whole set from a band change; never nudge one hue, or that
 * colour starts ranking instead of identifying.
 */
export const STATUS_HUES: Readonly<Record<StatusHueName, number>> = Object.freeze({
  success: 150,
  danger: 27,
  warning: 70.5,
  merged: 300,
  running: 250,
});

export function generateStatusHex(band: PaletteBand, hue: number): string {
  return oklchToHex({
    l: band.lightness,
    c: band.chromaFraction * maxChromaAt(band.lightness, hue),
    h: hue,
  });
}

export interface StatusTokenSpec {
  readonly token: string;
  readonly hue: StatusHueName;
  readonly band: PaletteBand;
}

/** The seven tokens base.css declares today, with the band each belongs to. */
export const SHIPPED_DARK_STATUS_TOKENS: readonly StatusTokenSpec[] = Object.freeze([
  { token: '--status-success', hue: 'success', band: DARK_STATUS_BAND },
  { token: '--status-danger', hue: 'danger', band: DARK_STATUS_BAND },
  { token: '--status-warning', hue: 'warning', band: DARK_STATUS_BAND },
  { token: '--status-merged', hue: 'merged', band: DARK_STATUS_BAND },
  { token: '--status-dot-success', hue: 'success', band: DARK_STATUS_DOT_BAND },
  { token: '--status-dot-danger', hue: 'danger', band: DARK_STATUS_DOT_BAND },
  { token: '--status-dot-warning', hue: 'warning', band: DARK_STATUS_DOT_BAND },
]);

/** The same rule applied to the light band. Not yet used by base.css. */
export const GENERATED_LIGHT_STATUS_TOKENS: readonly StatusTokenSpec[] = Object.freeze([
  { token: '--status-success', hue: 'success', band: LIGHT_STATUS_BAND },
  { token: '--status-danger', hue: 'danger', band: LIGHT_STATUS_BAND },
  { token: '--status-warning', hue: 'warning', band: LIGHT_STATUS_BAND },
  { token: '--status-merged', hue: 'merged', band: LIGHT_STATUS_BAND },
  { token: '--status-dot-success', hue: 'success', band: LIGHT_STATUS_DOT_BAND },
  { token: '--status-dot-danger', hue: 'danger', band: LIGHT_STATUS_DOT_BAND },
  { token: '--status-dot-warning', hue: 'warning', band: LIGHT_STATUS_DOT_BAND },
]);

export function generatePalette(
  specs: readonly StatusTokenSpec[],
): ReadonlyArray<{ readonly token: string; readonly value: string }> {
  return specs.map((spec) => ({
    token: spec.token,
    value: generateStatusHex(spec.band, STATUS_HUES[spec.hue]),
  }));
}

export function renderPaletteCss(
  entries: readonly { readonly token: string; readonly value: string }[],
  indent = '  ',
): string {
  return entries.map((entry) => `${indent}${entry.token}: ${entry.value};`).join('\n');
}

/** WCAG 2.x non-text minimum. DESIGN.md §2 claims the status dots meet it. */
export const NON_TEXT_CONTRAST_FLOOR = 3;

export interface ContrastViolation {
  readonly subject: string;
  readonly subjectValue: string;
  readonly background: string;
  readonly backgroundValue: string;
  readonly ratio: number;
  readonly floor: number;
}

/**
 * Every subject against every background, keeping only the pairs that fail.
 * Deliberately a cross product: a token that clears its floor on the sidebar
 * but not on a card is still a failure, and picking one background hides that.
 */
export function auditContrast(
  subjects: readonly { readonly token: string; readonly value: string }[],
  backgrounds: readonly { readonly token: string; readonly value: string }[],
  floor: number = NON_TEXT_CONTRAST_FLOOR,
): ContrastViolation[] {
  const violations: ContrastViolation[] = [];
  for (const subject of subjects) {
    for (const background of backgrounds) {
      const ratio = contrastRatio(subject.value, background.value);
      if (ratio < floor) {
        violations.push({
          subject: subject.token,
          subjectValue: subject.value,
          background: background.token,
          backgroundValue: background.value,
          ratio,
          floor,
        });
      }
    }
  }
  return violations;
}

/**
 * Worst-case contrast of a subject across a set of backgrounds. This is the
 * number a family should be tuned against, not the best case.
 */
export function worstContrast(
  subjectValue: string,
  backgroundValues: readonly string[],
): number {
  return Math.min(...backgroundValues.map((bg) => contrastRatio(subjectValue, bg)));
}

export interface BandSpread {
  readonly lightness: { readonly min: number; readonly max: number };
  readonly chromaFraction: { readonly min: number; readonly max: number };
}

/**
 * Measures whether a set of hexes really shares one band. This is the check
 * that catches a hand-nudged value: the whole point of the doctrine is that
 * family members differ in hue only.
 */
export function measureBandSpread(hexes: readonly string[]): BandSpread {
  if (hexes.length === 0) {
    throw new TypeError('measureBandSpread needs at least one colour');
  }
  const measured = hexes.map((hex) => {
    const oklch = hexToOklch(hex);
    return {
      lightness: oklch.l,
      chromaFraction: oklch.c / maxChromaAt(oklch.l, oklch.h),
    };
  });
  const lightnesses = measured.map((m) => m.lightness);
  const fractions = measured.map((m) => m.chromaFraction);
  return {
    lightness: { min: Math.min(...lightnesses), max: Math.max(...lightnesses) },
    chromaFraction: { min: Math.min(...fractions), max: Math.max(...fractions) },
  };
}

/**
 * 8-bit hex rounding moves lightness by ~0.001 and the chroma fraction by
 * ~0.4pp, so a band that was generated from one rule measures back inside
 * these tolerances while a hand-nudged value does not.
 */
export const BAND_LIGHTNESS_TOLERANCE = 0.005;
export const BAND_CHROMA_FRACTION_TOLERANCE = 0.015;

export interface CoherenceViolation {
  readonly axis: 'lightness' | 'chromaFraction';
  readonly spread: number;
  readonly tolerance: number;
  readonly members: readonly string[];
}

export function auditBandCoherence(
  members: readonly { readonly token: string; readonly value: string }[],
): CoherenceViolation[] {
  if (members.length < 2) return [];
  const spread = measureBandSpread(members.map((m) => m.value));
  const violations: CoherenceViolation[] = [];
  const lightnessSpread = spread.lightness.max - spread.lightness.min;
  if (lightnessSpread > BAND_LIGHTNESS_TOLERANCE) {
    violations.push({
      axis: 'lightness',
      spread: lightnessSpread,
      tolerance: BAND_LIGHTNESS_TOLERANCE,
      members: members.map((m) => m.token),
    });
  }
  const chromaSpread = spread.chromaFraction.max - spread.chromaFraction.min;
  if (chromaSpread > BAND_CHROMA_FRACTION_TOLERANCE) {
    violations.push({
      axis: 'chromaFraction',
      spread: chromaSpread,
      tolerance: BAND_CHROMA_FRACTION_TOLERANCE,
      members: members.map((m) => m.token),
    });
  }
  return violations;
}
