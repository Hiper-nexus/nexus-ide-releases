/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PALETTES } from './ui-theme';
import {
  auditBandCoherence,
  auditContrast,
  BAND_CHROMA_FRACTION_TOLERANCE,
  BAND_LIGHTNESS_TOLERANCE,
  contrastRatio,
  DARK_STATUS_BAND,
  DARK_STATUS_DOT_BAND,
  generatePalette,
  generateStatusHex,
  GENERATED_LIGHT_STATUS_TOKENS,
  hexToOklch,
  hexToSrgb,
  LIGHT_STATUS_BAND,
  LIGHT_STATUS_DOT_BAND,
  maxChromaAt,
  measureBandSpread,
  NON_TEXT_CONTRAST_FLOOR,
  oklchToHex,
  relativeLuminance,
  renderPaletteCss,
  SHIPPED_DARK_STATUS_TOKENS,
  STATUS_HUES,
  worstContrast,
} from './palette-gen';

// Same idiom as ui-theme.test.ts: jsdom rewrites import.meta.url, so stylesheets
// are resolved from the vitest root instead of relative to this module.
function readStyles(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/styles', file), 'utf8');
}

const baseCss = readStyles('base.css');

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

const rootBody = ruleBody(baseCss, ':root');

/** Hex a token is declared with in base.css `:root`. Throws when absent. */
function declaredToken(token: string): string {
  const match = rootBody.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!match) {
    throw new Error(`${token} is not declared as a 6-digit hex in base.css :root`);
  }
  return match[1];
}

const shippedPalette = SHIPPED_DARK_STATUS_TOKENS.map((spec) => ({
  token: spec.token,
  value: declaredToken(spec.token),
}));

/** Surfaces the status tokens actually sit on in the default dark theme. */
const darkSurfaces = ['--surface-sidebar', '--surface-1', '--surface-2', '--surface-3'].map(
  (token) => ({ token, value: declaredToken(token) }),
);

describe('colour conversion', () => {
  it('round-trips a hex through OKLCH back to the same hex', () => {
    for (const hex of ['#6cb17b', '#d8847b', '#c09664', '#a890d5', '#35c264', '#080709', '#ffffff']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });

  it('expands 3-digit hex', () => {
    expect(hexToSrgb('#fff')).toEqual([1, 1, 1]);
    expect(hexToSrgb('#000')).toEqual([0, 0, 0]);
  });

  it('rejects malformed hex at the boundary instead of returning NaN', () => {
    expect(() => hexToSrgb('6cb17b')).toThrow(TypeError);
    expect(() => hexToSrgb('#gggggg')).toThrow(TypeError);
    expect(() => hexToSrgb('#12345')).toThrow(TypeError);
  });

  it('computes WCAG luminance and contrast against the published anchors', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    // Mid-grey is the documented 4.5:1 AA anchor for body text.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
  });

  it('is symmetric in its arguments', () => {
    expect(contrastRatio('#6cb17b', '#16151a')).toBe(contrastRatio('#16151a', '#6cb17b'));
  });
});

describe('gamut', () => {
  it('finds a smaller maximum chroma for amber than for red at equal lightness', () => {
    // The whole reason chromaFraction exists: the sRGB gamut is lopsided, so an
    // equal-absolute-chroma family leaves warning visibly duller than danger.
    const amber = maxChromaAt(0.7, STATUS_HUES.warning);
    const red = maxChromaAt(0.7, STATUS_HUES.danger);
    expect(amber).toBeLessThan(red);
    expect(amber).toBeGreaterThan(0.1);
    expect(red).toBeGreaterThan(0.15);
  });

  it('keeps the generated colour inside sRGB', () => {
    const hex = generateStatusHex(DARK_STATUS_DOT_BAND, STATUS_HUES.success);
    for (const channel of hexToSrgb(hex)) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });
});

describe('the doctrine reproduces the shipped palette', () => {
  it('regenerates every dark status token in base.css bit-for-bit', () => {
    // This is the load-bearing assertion. It means the (lightness, chroma
    // fraction, hue) rule in palette-gen.ts is not a description of the tokens
    // but their generator: change a band or a hue here and base.css is wrong.
    const generated = generatePalette(SHIPPED_DARK_STATUS_TOKENS);
    for (const { token, value } of generated) {
      expect(value, `${token} in base.css should equal the generated value`).toBe(
        declaredToken(token),
      );
    }
  });

  it('measures the shipped pills back to L=0.70 and 55% of gamut chroma', () => {
    const pills = shippedPalette.filter((entry) => !entry.token.includes('-dot-'));
    const spread = measureBandSpread(pills.map((entry) => entry.value));
    // Asserted against the module's own tolerances rather than a toBeCloseTo
    // precision, so the test and auditBandCoherence can never disagree about
    // what "same band" means. 8-bit hex rounding moves L by about 0.001.
    expect(Math.abs(spread.lightness.min - DARK_STATUS_BAND.lightness)).toBeLessThanOrEqual(
      BAND_LIGHTNESS_TOLERANCE,
    );
    expect(Math.abs(spread.lightness.max - DARK_STATUS_BAND.lightness)).toBeLessThanOrEqual(
      BAND_LIGHTNESS_TOLERANCE,
    );
    expect(
      Math.abs(spread.chromaFraction.min - DARK_STATUS_BAND.chromaFraction),
    ).toBeLessThanOrEqual(BAND_CHROMA_FRACTION_TOLERANCE);
    expect(
      Math.abs(spread.chromaFraction.max - DARK_STATUS_BAND.chromaFraction),
    ).toBeLessThanOrEqual(BAND_CHROMA_FRACTION_TOLERANCE);
  });

  it('measures the shipped dots back to L=0.72 and 90% of gamut chroma', () => {
    const dots = shippedPalette.filter((entry) => entry.token.includes('-dot-'));
    const spread = measureBandSpread(dots.map((entry) => entry.value));
    expect(Math.abs(spread.lightness.min - DARK_STATUS_DOT_BAND.lightness)).toBeLessThanOrEqual(
      BAND_LIGHTNESS_TOLERANCE,
    );
    expect(
      Math.abs(spread.chromaFraction.min - DARK_STATUS_DOT_BAND.chromaFraction),
    ).toBeLessThanOrEqual(BAND_CHROMA_FRACTION_TOLERANCE);
  });

  it('reports a coherent band for both families', () => {
    const pills = shippedPalette.filter((entry) => !entry.token.includes('-dot-'));
    const dots = shippedPalette.filter((entry) => entry.token.includes('-dot-'));
    expect(auditBandCoherence(pills)).toEqual([]);
    expect(auditBandCoherence(dots)).toEqual([]);
  });

  it('catches a hand-nudged member, which is the failure the doctrine exists to prevent', () => {
    const pills = shippedPalette.filter((entry) => !entry.token.includes('-dot-'));
    // Someone retunes only --status-danger by eye. Same hue family, one value off.
    const nudged = pills.map((entry) =>
      entry.token === '--status-danger' ? { ...entry, value: '#ff4444' } : entry,
    );
    const violations = auditBandCoherence(nudged);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((v) => v.axis)).toContain('lightness');
    expect(violations[0].tolerance).toBe(BAND_LIGHTNESS_TOLERANCE);
    expect(violations.some((v) => v.axis === 'chromaFraction')).toBe(true);
    expect(violations.find((v) => v.axis === 'chromaFraction')?.tolerance).toBe(
      BAND_CHROMA_FRACTION_TOLERANCE,
    );
  });

  it('emits CSS declarations for the tokens it generated', () => {
    const css = renderPaletteCss([{ token: '--status-success', value: '#6cb17b' }]);
    expect(css).toBe('  --status-success: #6cb17b;');
  });
});

describe('contrast against the dark theme', () => {
  it('clears the documented 3:1 non-text floor on every dark surface', () => {
    // DESIGN.md §2 claims the status dots hold WCAG 3:1. Measured worst case is
    // --status-danger against --surface-2 at about 6.5:1, so the claim holds
    // with a wide margin in the default dark theme.
    const violations = auditContrast(shippedPalette, darkSurfaces, NON_TEXT_CONTRAST_FLOOR);
    expect(violations).toEqual([]);
  });

  it('clears the AA text floor too, not just the non-text floor', () => {
    // The documented claim is 3:1 (WCAG non-text). Measured worst case across
    // all seven tokens and all four dark surfaces is about 5.9:1, which also
    // clears the 4.5:1 AA floor for small text. That margin matters because the
    // same hues are used as status words, not only as 6pt dots.
    const WCAG_AA_TEXT_FLOOR = 4.5;
    const worst = Math.min(
      ...shippedPalette.map((entry) =>
        worstContrast(
          entry.value,
          darkSurfaces.map((surface) => surface.value),
        ),
      ),
    );
    expect(worst).toBeGreaterThan(WCAG_AA_TEXT_FLOOR);
  });
});

describe('nexus-light: known gaps, pinned so they cannot regress silently', () => {
  const lightBackgrounds = [
    { token: '--bg (nexus-light)', value: PALETTES['nexus-light'].bg },
    { token: '--bg-elevated (nexus-light)', value: PALETTES['nexus-light'].bgElevated },
  ];

  it('nexus-light really is a light background', () => {
    expect(relativeLuminance(PALETTES['nexus-light'].bg)).toBeGreaterThan(0.8);
  });

  it('base.css declares no status override for nexus-light, so the dark band is used', () => {
    const lightBlock = ruleBody(baseCss, "[data-theme='nexus-light']");
    expect(lightBlock).not.toMatch(/--status-/);
    expect(lightBlock).not.toMatch(/--surface-/);
  });

  it('the dark status band therefore fails 3:1 on the light background — F-338', () => {
    // Pinned as a failing expectation on purpose. When this is fixed by giving
    // nexus-light its own status band, this test must be inverted, and F-338
    // closed. It is asserted rather than skipped so the gap stays visible.
    const violations = auditContrast(shippedPalette, lightBackgrounds, NON_TEXT_CONTRAST_FLOOR);
    expect(violations.length).toBe(shippedPalette.length * lightBackgrounds.length);
    for (const violation of violations) {
      expect(violation.ratio).toBeLessThan(NON_TEXT_CONTRAST_FLOOR);
    }
  });

  it('the generated light band clears 3:1 on the same background — the fix candidate', () => {
    const lightPalette = generatePalette(GENERATED_LIGHT_STATUS_TOKENS);
    const violations = auditContrast(lightPalette, lightBackgrounds, NON_TEXT_CONTRAST_FLOOR);
    expect(violations).toEqual([]);
  });

  it('--surface-* is declared once and never overridden by any theme — F-337', () => {
    // 35 declarations across the stylesheets read --surface-*. In nexus-light
    // they resolve to the near-black :root values while --bg resolves to
    // #f7f8fb, because UiPalette carries bg/bgElevated/bgBar but no surfaces.
    const surfaceDeclarations = baseCss.match(/--surface-0\s*:/g) ?? [];
    expect(surfaceDeclarations).toHaveLength(1);
    for (const themeId of Object.keys(PALETTES)) {
      expect(ruleBody(baseCss, `[data-theme='${themeId}']`)).not.toMatch(/--surface-/);
    }
  });
});

describe('the light bands are the same rule at a different lightness', () => {
  it('generates a coherent light family', () => {
    const lightPalette = generatePalette(GENERATED_LIGHT_STATUS_TOKENS);
    const pills = lightPalette.filter((entry) => !entry.token.includes('-dot-'));
    const dots = lightPalette.filter((entry) => entry.token.includes('-dot-'));
    expect(auditBandCoherence(pills)).toEqual([]);
    expect(auditBandCoherence(dots)).toEqual([]);
  });

  it('keeps each hue constant across the dark and light bands', () => {
    // "Regenerate the set, never one hue": lightness moves, identity does not.
    for (const spec of SHIPPED_DARK_STATUS_TOKENS) {
      const darkHue = hexToOklch(generateStatusHex(spec.band, STATUS_HUES[spec.hue])).h;
      const lightBand = spec.token.includes('-dot-') ? LIGHT_STATUS_DOT_BAND : LIGHT_STATUS_BAND;
      const lightHue = hexToOklch(generateStatusHex(lightBand, STATUS_HUES[spec.hue])).h;
      expect(Math.abs(darkHue - lightHue)).toBeLessThan(1);
    }
  });

  it('makes the light pills darker than the dark pills, as a light theme requires', () => {
    expect(LIGHT_STATUS_BAND.lightness).toBeLessThan(DARK_STATUS_BAND.lightness);
    expect(LIGHT_STATUS_DOT_BAND.lightness).toBeLessThan(DARK_STATUS_DOT_BAND.lightness);
  });
});
