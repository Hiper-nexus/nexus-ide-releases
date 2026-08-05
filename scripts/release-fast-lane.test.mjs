import { describe, expect, it } from 'vitest';

import {
  classifyReleaseChangedPath,
  collectReleaseChangedPaths,
  parseReleaseChangedPaths,
  qualifyReleaseFastLane,
} from './release-fast-lane.mjs';

const GREEN_BASELINE = Object.freeze({
  schemaVersion: 4,
  version: '0.26.0',
  commitSha: 'd'.repeat(40),
  artifacts: {
    zip: { name: 'NexusIDE-darwin-arm64-0.26.0.zip', sha256: 'a'.repeat(64) },
    dmg: { name: 'NexusIDE-0.26.0-arm64.dmg', sha256: 'b'.repeat(64) },
    e2eEvidence: { name: 'real-mission-evidence.json', sha256: 'c'.repeat(64) },
  },
  verification: {
    signedNotarized: true,
    realMissionE2E: true,
    physicalProductWizard: true,
  },
});

function qualify(changedPaths, baseline = GREEN_BASELINE) {
  return qualifyReleaseFastLane({ changedPaths, baseline });
}

describe('classifyReleaseChangedPath', () => {
  it('treats docs, tests and spikes as non-packageable', () => {
    expect(classifyReleaseChangedPath('docs/analysis/foo.md')).toBe(
      'non-packageable',
    );
    expect(classifyReleaseChangedPath('src/main/orch/failover.test.ts')).toBe(
      'non-packageable',
    );
    expect(classifyReleaseChangedPath('scripts/spikes/cdp-drive.mjs')).toBe(
      'non-packageable',
    );
    expect(classifyReleaseChangedPath('CHANGELOG.md')).toBe('non-packageable');
  });

  it('treats release version metadata as a version bump', () => {
    expect(classifyReleaseChangedPath('package.json')).toBe('version-bump');
    expect(classifyReleaseChangedPath('package-lock.json')).toBe('version-bump');
    expect(classifyReleaseChangedPath('server/package.json')).toBe(
      'version-bump',
    );
  });

  it('treats application source as a production module', () => {
    expect(classifyReleaseChangedPath('src/main/orch/failover.ts')).toBe(
      'production',
    );
    expect(classifyReleaseChangedPath('src/renderer/App.tsx')).toBe(
      'production',
    );
  });

  it('treats the release machinery itself as gate-critical', () => {
    expect(classifyReleaseChangedPath('scripts/release-candidate-gate.mjs')).toBe(
      'gate-critical',
    );
    expect(classifyReleaseChangedPath('build/mac-signing.ts')).toBe(
      'gate-critical',
    );
    expect(classifyReleaseChangedPath('forge.config.ts')).toBe('gate-critical');
    expect(classifyReleaseChangedPath('third_party/licenses/MIT.txt')).toBe(
      'gate-critical',
    );
    expect(
      classifyReleaseChangedPath('src/shared/real-mission-e2e-evidence.ts'),
    ).toBe('gate-critical');
  });

  it('fails closed for paths outside every declared rule', () => {
    expect(classifyReleaseChangedPath('assets/new-icon.png')).toBe(
      'gate-critical',
    );
    expect(classifyReleaseChangedPath('.github/workflows/ci.yml')).toBe(
      'gate-critical',
    );
  });

  it('normalizes separators and leading ./ before classifying', () => {
    expect(classifyReleaseChangedPath('./docs/x.md')).toBe('non-packageable');
    expect(classifyReleaseChangedPath('docs\\x.md')).toBe('non-packageable');
  });
});

describe('parseReleaseChangedPaths', () => {
  it('drops blank lines and deduplicates normalized paths', () => {
    expect(
      parseReleaseChangedPaths('docs/a.md\n\n./docs/a.md\nsrc/main/x.ts\n'),
    ).toEqual(['docs/a.md', 'src/main/x.ts']);
  });
});

describe('qualifyReleaseFastLane', () => {
  it('reuses the whole green gate when nothing changed', () => {
    const decision = qualify([]);
    expect(decision.lane).toBe('reuse-green');
    expect(decision.waiver).toBeNull();
  });

  it('reuses the whole green gate for docs/test-only deltas', () => {
    const decision = qualify([
      'docs/analysis/foo.md',
      'src/main/orch/failover.test.ts',
      'scripts/spikes/cdp-drive.mjs',
    ]);
    expect(decision.lane).toBe('reuse-green');
  });

  it('demands the surgical lane once a version bump forces a rebuild', () => {
    const decision = qualify(['package.json', 'package-lock.json', 'CHANGELOG.md']);
    expect(decision.lane).toBe('surgical');
    expect(decision.waiver?.baselineCommitSha).toBe(GREEN_BASELINE.commitSha);
    expect(decision.waiver?.baselineZipSha256).toBe(
      GREEN_BASELINE.artifacts.zip.sha256,
    );
    expect(decision.waiver?.baselineEvidenceSha256).toBe(
      GREEN_BASELINE.artifacts.e2eEvidence.sha256,
    );
    expect(decision.waiver?.productionModules).toEqual([]);
  });

  it('qualifies a single production module with its tests and version bump', () => {
    const decision = qualify([
      'src/main/orch/failover.ts',
      'src/main/orch/failover.test.ts',
      'package.json',
      'package-lock.json',
      'CHANGELOG.md',
      'docs/analysis/hotfix.md',
    ]);
    expect(decision.lane).toBe('surgical');
    expect(decision.waiver?.productionModules).toEqual([
      'src/main/orch/failover.ts',
    ]);
    expect(decision.waiver?.changedPaths).toContain('src/main/orch/failover.ts');
  });

  it('falls back to the full gate for two production modules', () => {
    const decision = qualify([
      'src/main/orch/failover.ts',
      'src/main/orch/mission-scheduler.ts',
    ]);
    expect(decision.lane).toBe('full');
    expect(decision.waiver).toBeNull();
    expect(decision.reason).toMatch(/production modules/iu);
  });

  it('falls back to the full gate when release machinery changed', () => {
    const decision = qualify(['scripts/release-candidate-gate.mjs']);
    expect(decision.lane).toBe('full');
    expect(decision.disqualifiers).toEqual([
      'scripts/release-candidate-gate.mjs',
    ]);
  });

  it('falls back to the full gate for unknown paths', () => {
    const decision = qualify(['assets/icon.png']);
    expect(decision.lane).toBe('full');
    expect(decision.disqualifiers).toEqual(['assets/icon.png']);
  });

  it('refuses a baseline that never proved the real-mission E2E', () => {
    const decision = qualify(['docs/a.md'], {
      ...GREEN_BASELINE,
      verification: { ...GREEN_BASELINE.verification, realMissionE2E: false },
    });
    expect(decision.lane).toBe('full');
    expect(decision.reason).toMatch(/baseline/iu);
  });

  it('refuses a baseline whose own E2E was already waived (no chaining)', () => {
    const decision = qualify(['docs/a.md'], {
      ...GREEN_BASELINE,
      verification: {
        ...GREEN_BASELINE.verification,
        fastLaneWaiver: { lane: 'surgical' },
      },
    });
    expect(decision.lane).toBe('full');
    expect(decision.reason).toMatch(/waiv/iu);
  });

  it('refuses a baseline with an unknown receipt schema', () => {
    const decision = qualify(['docs/a.md'], {
      ...GREEN_BASELINE,
      schemaVersion: 3,
    });
    expect(decision.lane).toBe('full');
    expect(decision.reason).toMatch(/schema/iu);
  });

  it('refuses a missing baseline', () => {
    const decision = qualify(['docs/a.md'], null);
    expect(decision.lane).toBe('full');
  });
});

describe('collectReleaseChangedPaths', () => {
  it('asks git for the rename-free name list between baseline and HEAD', () => {
    const calls = [];
    const paths = collectReleaseChangedPaths({
      baselineCommitSha: 'e'.repeat(40),
      gitCapture: (args) => {
        calls.push(args);
        return { stdout: 'docs/a.md\nsrc/main/x.ts\n' };
      },
    });
    expect(calls).toEqual([
      [
        'diff',
        '--name-only',
        '--no-renames',
        `${'e'.repeat(40)}..HEAD`,
      ],
    ]);
    expect(paths).toEqual(['docs/a.md', 'src/main/x.ts']);
  });

  it('rejects a baseline sha that is not a full commit hash', () => {
    expect(() =>
      collectReleaseChangedPaths({
        baselineCommitSha: 'HEAD~1',
        gitCapture: () => ({ stdout: '' }),
      }),
    ).toThrow(/commit sha/iu);
  });
});
