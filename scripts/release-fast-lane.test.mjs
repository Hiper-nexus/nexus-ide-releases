import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertFastLaneWaiverDocument,
  buildFastLaneWaiverDocument,
  classifyReleaseChangedPath,
  collectReleaseChangedPaths,
  parseReleaseChangedPaths,
  planReleaseFastLane,
  qualifyReleaseFastLane,
  RELEASE_FAST_LANE_ENV,
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

const roots = [];

afterEach(() => {
  while (roots.length) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** securityDir de um gate verde anterior, com recibo + evidência coerentes. */
function greenSecurityDirFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-fast-lane-'));
  roots.push(root);
  const securityDir = path.join(root, 'release-artifacts', 'security');
  fs.mkdirSync(securityDir, { recursive: true });
  const evidenceBody = JSON.stringify({ status: 'pass', release: { commitSha: GREEN_BASELINE.commitSha } });
  fs.writeFileSync(path.join(securityDir, 'real-mission-evidence.json'), evidenceBody);
  const receipt = {
    ...GREEN_BASELINE,
    tag: `v${GREEN_BASELINE.version}`,
    artifacts: {
      ...GREEN_BASELINE.artifacts,
      e2eEvidence: {
        name: 'real-mission-evidence.json',
        sha256: sha256(evidenceBody),
      },
    },
    ...overrides,
  };
  fs.writeFileSync(
    path.join(securityDir, 'release-candidate-receipt.json'),
    JSON.stringify(receipt),
  );
  return { root, securityDir, receipt, evidenceBody };
}

describe('planReleaseFastLane', () => {
  it('stays on the full gate unless the operator declares the fast lane', () => {
    const { securityDir } = greenSecurityDirFixture();
    const plan = planReleaseFastLane({
      securityDir,
      environment: {},
      gitCapture: () => ({ stdout: 'docs/a.md\n' }),
    });
    expect(plan.lane).toBe('full');
    expect(plan.reason).toMatch(/not requested/iu);
  });

  it('plans the surgical lane and snapshots the baseline evidence bytes', () => {
    const { securityDir, evidenceBody } = greenSecurityDirFixture();
    const plan = planReleaseFastLane({
      securityDir,
      environment: { [RELEASE_FAST_LANE_ENV]: '1' },
      gitCapture: () => ({
        stdout: 'src/main/orch/failover.ts\npackage.json\nCHANGELOG.md\n',
      }),
    });
    expect(plan.lane).toBe('surgical');
    expect(plan.waiver.productionModules).toEqual(['src/main/orch/failover.ts']);
    expect(plan.baselineEvidence).toHaveLength(1);
    expect(plan.baselineEvidence[0].name).toBe('real-mission-evidence.json');
    expect(plan.baselineEvidence[0].bytes.toString('utf8')).toBe(evidenceBody);
    expect(plan.baselineEvidence[0].sha256).toBe(sha256(evidenceBody));
  });

  it('falls back to the full gate when the baseline evidence bytes drifted', () => {
    const { securityDir } = greenSecurityDirFixture();
    fs.writeFileSync(
      path.join(securityDir, 'real-mission-evidence.json'),
      '{"status":"tampered"}',
    );
    const plan = planReleaseFastLane({
      securityDir,
      environment: { [RELEASE_FAST_LANE_ENV]: '1' },
      gitCapture: () => ({ stdout: 'docs/a.md\n' }),
    });
    expect(plan.lane).toBe('full');
    expect(plan.reason).toMatch(/evidence/iu);
  });

  it('falls back to the full gate when there is no previous receipt', () => {
    const { securityDir } = greenSecurityDirFixture();
    fs.rmSync(path.join(securityDir, 'release-candidate-receipt.json'));
    const plan = planReleaseFastLane({
      securityDir,
      environment: { [RELEASE_FAST_LANE_ENV]: '1' },
      gitCapture: () => ({ stdout: '' }),
    });
    expect(plan.lane).toBe('full');
  });

  it('falls back to the full gate when git cannot answer the diff', () => {
    const { securityDir } = greenSecurityDirFixture();
    const plan = planReleaseFastLane({
      securityDir,
      environment: { [RELEASE_FAST_LANE_ENV]: '1' },
      gitCapture: () => {
        throw new Error('fatal: bad object');
      },
    });
    expect(plan.lane).toBe('full');
    expect(plan.reason).toMatch(/bad object/iu);
  });
});

describe('fast lane waiver document', () => {
  const CANDIDATE = Object.freeze({
    version: '0.26.1',
    commitSha: 'f'.repeat(40),
    zipSha256: '1'.repeat(64),
    dmgSha256: '2'.repeat(64),
  });

  function documentFor(securityDir) {
    const plan = planReleaseFastLane({
      securityDir,
      environment: { [RELEASE_FAST_LANE_ENV]: '1' },
      gitCapture: () => ({ stdout: 'src/main/orch/failover.ts\npackage.json\n' }),
    });
    return buildFastLaneWaiverDocument({
      plan,
      candidate: CANDIDATE,
      now: () => new Date('2026-08-05T23:00:00.000Z'),
    });
  }

  it('binds both the new candidate and the reused baseline', () => {
    const { securityDir } = greenSecurityDirFixture();
    const document = documentFor(securityDir);
    expect(document.schemaVersion).toBe(1);
    expect(document.lane).toBe('surgical');
    expect(document.candidate).toEqual(CANDIDATE);
    expect(document.baseline.commitSha).toBe(GREEN_BASELINE.commitSha);
    expect(document.baseline.zipSha256).toBe(GREEN_BASELINE.artifacts.zip.sha256);
    expect(document.provedInstead).toContain('packaged-smoke');
    expect(document.qualifiedAt).toBe('2026-08-05T23:00:00.000Z');
  });

  it('re-verifies against the security dir it was written into', () => {
    const { securityDir } = greenSecurityDirFixture();
    const document = documentFor(securityDir);
    expect(
      assertFastLaneWaiverDocument(document, { securityDir, candidate: CANDIDATE }),
    ).toBe(document);
  });

  it('rejects a waiver whose candidate binding drifted', () => {
    const { securityDir } = greenSecurityDirFixture();
    const document = documentFor(securityDir);
    expect(() =>
      assertFastLaneWaiverDocument(document, {
        securityDir,
        candidate: { ...CANDIDATE, zipSha256: '9'.repeat(64) },
      }),
    ).toThrow(/candidate/iu);
  });

  it('rejects a waiver whose reused evidence file changed on disk', () => {
    const { securityDir } = greenSecurityDirFixture();
    const document = documentFor(securityDir);
    fs.writeFileSync(
      path.join(securityDir, 'real-mission-evidence.json'),
      '{"status":"tampered"}',
    );
    expect(() =>
      assertFastLaneWaiverDocument(document, { securityDir, candidate: CANDIDATE }),
    ).toThrow(/evidence/iu);
  });

  it('refuses to build a waiver for the full gate', () => {
    const { securityDir } = greenSecurityDirFixture();
    const plan = planReleaseFastLane({
      securityDir,
      environment: {},
      gitCapture: () => ({ stdout: 'docs/a.md\n' }),
    });
    expect(() =>
      buildFastLaneWaiverDocument({ plan, candidate: CANDIDATE }),
    ).toThrow(/full gate/iu);
  });
});
