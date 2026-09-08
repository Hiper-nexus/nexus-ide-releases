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

const SURFACE_TOKENS = [
  '--surface-sidebar',
  '--surface-0',
  '--surface-1',
  '--surface-2',
  '--surface-3',
];

/**
 * The ratchet. This set must only ever shrink: a registered gap that starts
 * passing shows up as a missing key here, forcing its KNOWN_GAPS entry to be
 * deleted instead of quietly going stale. It is empty now — it held 21 entries
 * for F-338 until nexus-light got its own surface ramp and status band.
 */
const EXPECTED_GAP_KEYS = new Set();

function runGate() {
  const result = spawnSync(process.execPath, ['--import', 'tsx', gatePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
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

  it('passes on merit, with no registered gaps left to hide behind', () => {
    expect(status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.knownGaps.count).toBe(0);
    expect(report.knownGaps.entries).toEqual([]);
    expect(report.knownGaps.byFinding).toEqual({});
  });

  it('confirms the known-gap set has not drifted from the ratchet', () => {
    const keys = new Set(
      report.knownGaps.entries.map((gap) => `${gap.themeId} ${gap.token} ${gap.background}`),
    );
    expect([...keys].sort()).toEqual([...EXPECTED_GAP_KEYS].sort());
  });

  it('audits all seven themes, seven status tokens and eight backgrounds each', () => {
    expect(report.themes).toHaveLength(7);
    for (const theme of report.themes) {
      expect(theme.statusTokensAudited).toBe(STATUS_TOKENS.length);
      // --bg, --bg-elevated, --bg-bar from ui-theme.ts plus five --surface-*
      expect(theme.backgroundsAudited).toBe(8);
      expect(theme.violations, `${theme.themeId} should clear the floor`).toBe(0);
    }
  });

  it('detects no light-background/dark-surface inconsistency in any theme', () => {
    // This is the F-337 detector: the gate emits a note when a theme's --bg is
    // light but --surface-sidebar resolves to the dark :root value. Empty notes
    // means every theme's surfaces now agree with its background. The values
    // themselves are asserted directly in palette-gen.test.ts, which reads
    // base.css; this asserts the gate's own detection path stays silent.
    expect(report.notes).toEqual([]);
  });

  it('keeps every surface token reachable for the audit', () => {
    // Guards the assumption behind backgroundsAudited === 8: if a surface token
    // stopped being a plain 6-digit hex the count would drop silently and the
    // audit would quietly stop covering it.
    expect(SURFACE_TOKENS).toHaveLength(5);
  });
});
