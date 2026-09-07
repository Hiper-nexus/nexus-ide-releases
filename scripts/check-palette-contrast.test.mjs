import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptDir);
const gatePath = path.join(repositoryRoot, 'scripts', 'check-palette-contrast.mjs');

const STATUS_TOKENS = [
  '--status-success',
  '--status-danger',
  '--status-warning',
  '--status-merged',
  '--status-dot-success',
  '--status-dot-danger',
  '--status-dot-warning',
];

// Every light background nexus-light resolves to, cross-multiplied with the
// seven status tokens. This snapshot is the ratchet: the gate must be updated
// (and the entry deleted) the moment any one of these starts passing.
const EXPECTED_GAP_KEYS = new Set(
  ['nexus-light'].flatMap((themeId) =>
    STATUS_TOKENS.flatMap((token) =>
      ['--bg', '--bg-elevated', '--bg-bar'].map(
        (background) => `${themeId} ${token} ${background}`,
      ),
    ),
  ),
);

function runGate() {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', gatePath],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `gate did not emit JSON on stdout (exit ${result.status}).\n` +
        `stdout: ${result.stdout.slice(0, 600)}\nstderr: ${result.stderr.slice(0, 600)}`,
    );
  }
  return { status: result.status, report };
}

describe('check-palette-contrast gate', () => {
  const { status, report } = runGate();

  it('passes today, so it can be wired into a gate without blocking anyone', () => {
    // The sensor's own header records what happens when a design gate the repo
    // cannot pass reaches a merge coordinator: the cheapest fix becomes
    // weakening the gate. Every current violation is a registered finding.
    expect(status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('audits all seven themes, seven status tokens and eight backgrounds each', () => {
    expect(report.themes).toHaveLength(7);
    for (const theme of report.themes) {
      expect(theme.statusTokensAudited).toBe(STATUS_TOKENS.length);
      // --bg, --bg-elevated, --bg-bar from ui-theme.ts plus five --surface-*
      expect(theme.backgroundsAudited).toBe(8);
    }
  });

  it('reports a violation for every dark-band status token on the light theme', () => {
    const light = report.themes.find((theme) => theme.themeId === 'nexus-light');
    expect(light.violations).toBe(EXPECTED_GAP_KEYS.size);
  });

  it('confines the known gaps to exactly the F-338 snapshot', () => {
    const keys = new Set(
      report.knownGaps.entries.map((gap) => `${gap.themeId} ${gap.token} ${gap.background}`),
    );
    // A gap that started passing shows up as a missing key here, forcing the
    // KNOWN_GAPS entry to be deleted instead of quietly going stale.
    expect([...keys].sort()).toEqual([...EXPECTED_GAP_KEYS].sort());
    for (const gap of report.knownGaps.entries) {
      expect(gap.finding).toBe('F-338');
      expect(gap.ratio).toBeLessThan(gap.floor);
    }
    expect(report.knownGaps.byFinding).toEqual({ 'F-338': EXPECTED_GAP_KEYS.size });
  });

  it('reports no violation at all in the six dark themes', () => {
    for (const theme of report.themes) {
      if (theme.themeId === 'nexus-light') continue;
      expect(theme.violations, `${theme.themeId} should clear the floor`).toBe(0);
    }
  });

  it('surfaces F-337: a light --bg with dark --surface-* resolved from :root', () => {
    const note = report.notes.find((entry) => entry.includes('F-337'));
    expect(note).toBeDefined();
    expect(note).toContain('nexus-light');
    expect(note).toContain('--surface-sidebar');
  });
});
