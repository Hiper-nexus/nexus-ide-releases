#!/usr/bin/env node
/**
 * Palette contrast gate — checks that every status token clears its documented
 * contrast floor against the backgrounds it actually resolves to, per theme.
 *
 * Run with: node --import tsx scripts/check-palette-contrast.mjs
 *
 * Why this is a separate script and not a check inside design-system-sensor.mjs
 * -----------------------------------------------------------------------------
 * The sensor runs under plain `node` and is wired into a merge gate. This check
 * needs the typed colour maths in src/renderer/styles/palette-gen.ts and the
 * per-theme backgrounds in src/renderer/styles/ui-theme.ts, so it runs under
 * tsx. Keeping them apart also keeps the sensor's contract unchanged.
 *
 * Why known gaps do not fail the build
 * ------------------------------------
 * The sensor's own header records the incident this avoids: an over-eager
 * design gate flagged the project's own DESIGN.md and `merge-validation-coordinator`
 * turned that exit 1 into a blocked merge. A gate the repository cannot pass is
 * worse than no gate, because the cheapest way to pass it is to weaken it.
 *
 * So violations that are already registered as QA findings are reported under
 * `knownGaps` with their finding id and do not affect the exit code. Any NEW
 * violation fails. When a finding is fixed, delete its entry below — and
 * scripts/check-palette-contrast.test.mjs asserts the list only shrinks.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  auditContrast,
  hexToOklch,
  NON_TEXT_CONTRAST_FLOOR,
} from '../src/renderer/styles/palette-gen.ts';
import { PALETTES } from '../src/renderer/styles/ui-theme.ts';

const repositoryRoot = process.cwd();
const BASE_CSS = path.join(repositoryRoot, 'src/renderer/styles/base.css');

/**
 * Largest OKLCH lightness difference tolerated between a theme's `--bg` and the
 * `--surface-0` it resolves to. Derived from the measured spread across the
 * seven shipped themes, not chosen: the two coherent ones are 0.0000, the
 * near-black variant is 0.0188, and the four incoherent ones start at 0.0315.
 */
const SURFACE_BACKGROUND_MAX_LIGHTNESS_DRIFT = 0.02;

/** The tokens DESIGN.md §2 documents as holding a contrast floor. */
const STATUS_TOKENS = [
  '--status-success',
  '--status-danger',
  '--status-warning',
  '--status-merged',
  '--status-dot-success',
  '--status-dot-danger',
  '--status-dot-warning',
];

/**
 * Surfaces the status tokens sit on. These are declared in base.css :root and
 * are NOT part of UiPalette, so they resolve to the same values in every theme
 * — which is itself finding F-337.
 */
const SURFACE_TOKENS = [
  '--surface-sidebar',
  '--surface-0',
  '--surface-1',
  '--surface-2',
  '--surface-3',
];

/**
 * Registered gaps. Key is `${themeId} ${token} ${background}`.
 *
 * Empty as of the nexus-light fix: `--surface-*` and `--status-*` are now
 * declared per theme, so all seven themes clear the floor. This was 21 entries
 * under F-338 (the dark status band measuring 2.3-2.8:1 on a #f7f8fb
 * background) and F-337 (no theme overriding `--surface-*` at all); both are
 * closed. The mechanism stays because the next theme added starts as a gap, and
 * because check-palette-contrast.test.mjs asserts this set is exactly as small
 * as it claims to be — a gap that starts passing fails that test until its entry
 * is deleted here.
 */
const KNOWN_GAPS = new Map();

const HEX = /#[0-9a-fA-F]{6}/;

/**
 * Strip CSS comments before parsing declarations. Not optional: a declaration
 * regex of the shape /(--name)\s*:\s*([^;]+);/ matches across newlines, so
 * prose inside a comment that happens to contain `--token:` swallows the real
 * declaration that follows it up to the next semicolon. This gate shipped that
 * bug and it cost exactly one token — a comment reading "todos sobre
 * --surface-3: success 3.92 ..." consumed the following `--status-success`
 * line, so the audit silently read the dark value from :root instead of the
 * theme's override. design-system-sensor.mjs strips comments for the same
 * reason; any declaration scraper over these stylesheets has to.
 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

function declarations(body) {
  const out = new Map();
  for (const match of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1], match[2].trim());
  }
  return out;
}

/** A token's value in a theme: the theme's own block, else the :root default. */
function resolveCssToken(root, themeBlock, token) {
  return themeBlock.get(token) ?? root.get(token) ?? null;
}

function isHex(value) {
  return typeof value === 'string' && HEX.test(value) && value.length === 7;
}

function main() {
  if (!fs.existsSync(BASE_CSS)) {
    console.log(JSON.stringify({ ok: false, findings: [{ severity: 'high', message: `no base.css at ${BASE_CSS}` }] }, null, 2));
    process.exit(1);
  }
  const css = stripCssComments(fs.readFileSync(BASE_CSS, 'utf8'));
  const root = declarations(ruleBody(css, ':root'));

  const findings = [];
  const knownGaps = [];
  const notes = [];
  const themes = [];

  for (const themeId of Object.keys(PALETTES)) {
    const themeBlock = declarations(ruleBody(css, `[data-theme='${themeId}']`));
    const palette = PALETTES[themeId];

    // Backgrounds the status tokens can land on in this theme: the palette's
    // own bg/bgElevated/bgBar (written inline by applyUiTheme, never in
    // base.css) plus every surface token resolved through the cascade.
    const backgrounds = [
      { token: '--bg', value: palette.bg },
      { token: '--bg-elevated', value: palette.bgElevated },
      { token: '--bg-bar', value: palette.bgBar },
    ];
    for (const surface of SURFACE_TOKENS) {
      const value = resolveCssToken(root, themeBlock, surface);
      if (value) backgrounds.push({ token: surface, value });
    }

    const subjects = [];
    const unresolved = [];
    for (const token of STATUS_TOKENS) {
      const value = resolveCssToken(root, themeBlock, token);
      // --status-running is var(--accent), which is not a literal hex; the
      // accent is the theme's own and is audited by ui-theme.test.ts instead.
      if (value && isHex(value)) {
        subjects.push({ token, value });
      } else if (value && value.startsWith('var(')) {
        notes.push(`${themeId}: ${token} is ${value}, an alias — audited via its target token`);
      } else if (!value) {
        unresolved.push(token);
      }
    }
    if (unresolved.length > 0) {
      findings.push({
        severity: 'high',
        message: `${themeId}: ${unresolved.length} status token(s) resolve to nothing: ${unresolved.join(', ')}`,
      });
    }

    const usableBackgrounds = backgrounds.filter((b) => isHex(b.value));
    const nonHex = backgrounds.filter((b) => !isHex(b.value));
    for (const background of nonHex) {
      notes.push(`${themeId}: ${background.token} is "${background.value}", not a 6-digit hex — skipped`);
    }

    const violations = auditContrast(subjects, usableBackgrounds, NON_TEXT_CONTRAST_FLOOR);
    for (const violation of violations) {
      const key = `${themeId} ${violation.subject} ${violation.background}`;
      const finding = KNOWN_GAPS.get(key);
      const entry = {
        themeId,
        token: violation.subject,
        tokenValue: violation.subjectValue,
        background: violation.background,
        backgroundValue: violation.backgroundValue,
        ratio: Number(violation.ratio.toFixed(2)),
        floor: violation.floor,
      };
      if (finding) {
        knownGaps.push({ ...entry, finding });
      } else {
        findings.push({
          severity: 'high',
          message:
            `${themeId}: ${violation.subject} (${violation.subjectValue}) on ` +
            `${violation.background} (${violation.backgroundValue}) is ` +
            `${violation.ratio.toFixed(2)}:1, below the ${violation.floor}:1 floor ` +
            `DESIGN.md §2 documents. Regenerate the family from a band in ` +
            `palette-gen.ts; do not nudge this one hex.`,
        });
      }
    }

    // Surface/background coherence. --surface-0 IS the page-level surface: in
    // pink-city it is byte-identical to --bg (#080709) and in nexus-light it is
    // identical to --bg (#f7f8fb). A theme whose --surface-0 resolves far from
    // its own --bg is drawing cards, rails and hovers on a ramp designed for a
    // different theme. Reported as a note rather than a finding: the pairs share
    // a polarity so they clear the contrast floor, and the defect is visual
    // coherence, not legibility. 0.02 admits the near-black variants
    // (nexus-dark measures 0.0188) and flags the genuinely divergent ones
    // (nexus-red 0.0315, nexus-gray 0.0647, solarized-dark 0.1361,
    // dracula 0.1570). See F-341.
    const surface0 = resolveCssToken(root, themeBlock, '--surface-0');
    if (surface0 && isHex(surface0) && isHex(palette.bg)) {
      const drift = Math.abs(hexToOklch(surface0).l - hexToOklch(palette.bg).l);
      if (drift > SURFACE_BACKGROUND_MAX_LIGHTNESS_DRIFT) {
        notes.push(
          `${themeId}: --bg is ${palette.bg} but --surface-0 resolves to ${surface0} ` +
          `(OKLCH lightness drift ${drift.toFixed(4)}, over the ` +
          `${SURFACE_BACKGROUND_MAX_LIGHTNESS_DRIFT} budget); this theme draws on the ` +
          `pink-city surface ramp. See F-341.`,
        );
      }
    }

    themes.push({
      themeId,
      statusTokensAudited: subjects.length,
      backgroundsAudited: usableBackgrounds.length,
      violations: violations.length,
    });
  }

  const report = {
    ok: findings.length === 0,
    floor: NON_TEXT_CONTRAST_FLOOR,
    themes,
    findings,
    knownGaps: {
      count: knownGaps.length,
      byFinding: knownGaps.reduce((acc, gap) => {
        acc[gap.finding] = (acc[gap.finding] ?? 0) + 1;
        return acc;
      }, {}),
      entries: knownGaps,
    },
    notes,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(findings.length === 0 ? 0 : 1);
}

main();
