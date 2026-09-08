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
  DARK_SURFACE_STEPS,
  generatePalette,
  generateStatusHex,
  generateSurfaceRamp,
  GENERATED_LIGHT_STATUS_TOKENS,
  hexToOklch,
  hexToSrgb,
  LIGHT_STATUS_BAND,
  LIGHT_STATUS_DOT_BAND,
  LIGHT_SURFACE_STEPS,
  maxChromaAt,
  measureBandSpread,
  NON_TEXT_CONTRAST_FLOOR,
  oklchToHex,
  relativeLuminance,
  renderPaletteCss,
  SHIPPED_DARK_STATUS_TOKENS,
  STATUS_HUES,
  SURFACE_RAMP_MAX_CHANNEL_DRIFT,
  worstContrast,
} from './palette-gen';

// Same idiom as ui-theme.test.ts: jsdom rewrites import.meta.url, so stylesheets
// are resolved from the vitest root instead of relative to this module.
function readStyles(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/styles', file), 'utf8');
}

const baseCss = readStyles('base.css');

/**
 * A declaration regex of /(--name)\s*:\s*([^;]+);/ matches across newlines, so
 * prose in a CSS comment containing `--token:` swallows the real declaration
 * that follows. Comments go first. check-palette-contrast.mjs strips them for
 * the same reason.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const commentFreeCss = stripComments(baseCss);

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

function declarationsIn(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1], match[2].trim());
  }
  return out;
}

const rootBody = ruleBody(commentFreeCss, ':root');
const rootDeclarations = declarationsIn(rootBody);
const lightDeclarations = declarationsIn(
  ruleBody(commentFreeCss, "[data-theme='nexus-light']"),
);

const SURFACE_TOKENS = [
  '--surface-0',
  '--surface-sidebar',
  '--surface-1',
  '--surface-2',
  '--surface-3',
];

/** Largest per-channel difference between two 6-digit hex colours. */
function maxChannelDrift(a: string, b: string): number {
  const left = hexToSrgb(a);
  const right = hexToSrgb(b);
  return Math.max(
    ...[0, 1, 2].map((i) => Math.abs(Math.round(left[i] * 255) - Math.round(right[i] * 255))),
  );
}

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

describe('nexus-light: surfaces and status are declared for the theme (F-337, F-338)', () => {
  const light = PALETTES['nexus-light'];
  // Every background a status token can land on in this theme: the palette's
  // three, written inline by applyUiTheme, plus the five surfaces now resolved
  // from the theme's own block instead of falling through to the dark :root.
  const lightBackgrounds = [
    { token: '--bg', value: light.bg },
    { token: '--bg-elevated', value: light.bgElevated },
    { token: '--bg-bar', value: light.bgBar },
    ...SURFACE_TOKENS.map((token) => ({ token, value: lightDeclarations.get(token) ?? '' })),
  ];
  const declaredLightStatus = SHIPPED_DARK_STATUS_TOKENS.map((spec) => ({
    token: spec.token,
    value: lightDeclarations.get(spec.token) ?? '',
  }));

  it('nexus-light really is a light background', () => {
    expect(relativeLuminance(light.bg)).toBeGreaterThan(0.8);
  });

  it('declares its own surface ramp, all of it light — F-337', () => {
    // Before the fix no theme block declared --surface-*, so 35 usages resolved
    // to the near-black :root values on a #f7f8fb page.
    for (const token of SURFACE_TOKENS) {
      const value = lightDeclarations.get(token);
      expect(value, `${token} must be declared for nexus-light`).toMatch(/^#[0-9a-f]{6}$/i);
      // Light means closer to white than to black.
      expect(contrastRatio(value as string, '#ffffff')).toBeLessThan(
        contrastRatio(value as string, '#000000'),
      );
    }
  });

  it('orders the ramp so a higher N is a stronger interaction state', () => {
    // The semantic the stylesheets actually use: surface-1 is a card,
    // surface-2 its hover, surface-3 selected/active. On a light theme that
    // means descending lightness, mirroring the dark ramp's ascent.
    const lightness = SURFACE_TOKENS.filter((t) => t !== '--surface-sidebar').map((token) =>
      hexToOklch(lightDeclarations.get(token) as string).l,
    );
    for (let i = 1; i < lightness.length; i += 1) {
      expect(lightness[i]).toBeLessThan(lightness[i - 1]);
    }
  });

  it('declares its own status band, so the dark band is no longer used on a light page', () => {
    for (const { token, value } of declaredLightStatus) {
      expect(value, `${token} must be declared for nexus-light`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(value).not.toBe(rootDeclarations.get(token));
    }
  });

  it('the declared light status tokens clear 3:1 on every light background — F-338', () => {
    expect(auditContrast(declaredLightStatus, lightBackgrounds, NON_TEXT_CONTRAST_FLOOR)).toEqual(
      [],
    );
  });

  it('the declared values are exactly what the generator produces', () => {
    for (const { token, value } of generatePalette(GENERATED_LIGHT_STATUS_TOKENS)) {
      expect(lightDeclarations.get(token), `${token} should match the generated value`).toBe(value);
    }
    for (const { token, value } of generateSurfaceRamp(
      { background: light.bg, bar: light.bgBar },
      LIGHT_SURFACE_STEPS,
    )) {
      expect(lightDeclarations.get(token), `${token} should match the generated ramp`).toBe(value);
    }
  });

  it('the dark band would fail here, which is what F-338 was', () => {
    // Regression anchor for the fix rather than a description of current state:
    // these are the :root values that nexus-light used to inherit.
    const violations = auditContrast(shippedPalette, lightBackgrounds, NON_TEXT_CONTRAST_FLOOR);
    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.every((violation) => violation.ratio < NON_TEXT_CONTRAST_FLOOR),
    ).toBe(true);
  });
});

describe('generateSurfaceRamp', () => {
  const pinkCity = PALETTES['nexus-pink-city'];
  const light = PALETTES['nexus-light'];

  it('mirrors the dark step sizes with an inverted sign', () => {
    expect(LIGHT_SURFACE_STEPS).toHaveLength(DARK_SURFACE_STEPS.length);
    LIGHT_SURFACE_STEPS.forEach((step, index) => {
      expect(step.token).toBe(DARK_SURFACE_STEPS[index].token);
      expect(step.lightnessDelta).toBeCloseTo(-DARK_SURFACE_STEPS[index].lightnessDelta, 10);
    });
  });

  it('approximates the shipped dark ramp within the documented drift', () => {
    // Not exact, and deliberately not asserted as exact: the dark ramp was
    // hand-tuned after generation. Regenerating :root would shift shipped
    // colours by up to 3/255 for no benefit, so the generator derives ramps
    // that have no shipped values yet and this pins how far it may drift.
    const generated = generateSurfaceRamp(
      { background: pinkCity.bg, bar: pinkCity.bgBar },
      DARK_SURFACE_STEPS,
    );
    for (const { token, value } of generated) {
      const shipped = rootDeclarations.get(token) as string;
      expect(maxChannelDrift(value, shipped)).toBeLessThanOrEqual(
        SURFACE_RAMP_MAX_CHANNEL_DRIFT,
      );
    }
  });

  it('keeps each theme tint its own rather than sharing one neutral hue', () => {
    const darkRamp = generateSurfaceRamp(
      { background: pinkCity.bg, bar: pinkCity.bgBar },
      DARK_SURFACE_STEPS,
    );
    const lightRamp = generateSurfaceRamp(
      { background: light.bg, bar: light.bgBar },
      LIGHT_SURFACE_STEPS,
    );
    const darkHue = hexToOklch(darkRamp[3].value).h;
    const lightHue = hexToOklch(lightRamp[3].value).h;
    // pink-city neutrals run violet, nexus-light neutrals run blue.
    expect(darkHue).toBeGreaterThan(290);
    expect(lightHue).toBeLessThan(280);
  });

  it('refuses anchors with equal lightness instead of dividing by zero', () => {
    expect(() =>
      generateSurfaceRamp({ background: '#ffffff', bar: '#ffffff' }, LIGHT_SURFACE_STEPS),
    ).toThrow(TypeError);
  });

  it('keeps every generated surface inside sRGB', () => {
    const ramp = generateSurfaceRamp(
      { background: light.bg, bar: light.bgBar },
      LIGHT_SURFACE_STEPS,
    );
    for (const { value } of ramp) {
      for (const channel of hexToSrgb(value)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
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
