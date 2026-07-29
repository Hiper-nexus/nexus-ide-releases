import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertReleaseSecurityManifest,
  buildReleaseSecurityArtifacts,
  buildReleaseSecurityArtifactsWithPinnedNpm,
  buildFinalizedReleaseSecurityFields,
  finalizeReleaseSecurityArtifacts,
} from './release-security-gate.mjs';
import { makeValidRealMissionEvidence } from './test-support/real-mission-evidence.mjs';

const roots = [];
const securityAuthority = {
  tagObjectSha: 'b'.repeat(40),
  tagSignerFingerprint: 'A'.repeat(40),
  tagSignatureVerified: true,
};

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-security-gate-'));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'nexus-ide',
      version: '1.2.3',
      packageManager: 'npm@12.0.0',
      nexusRelease: { node: '22.23.1' },
    }),
  );
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('manual release security artifacts', () => {
  it('records an explicit Claude outage without claiming or fabricating Claude evidence', () => {
    const common = {
      signingIdentity:
        'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
      dmg: { name: 'NexusIDE.dmg', bytes: 3, sha256: 'a'.repeat(64) },
      zip: { name: 'NexusIDE.zip', bytes: 3, sha256: 'b'.repeat(64) },
      e2eEvidence: {
        name: 'real-mission-evidence.json',
        bytes: 10,
        sha256: 'c'.repeat(64),
      },
    };

    expect(() =>
      buildFinalizedReleaseSecurityFields(common),
    ).toThrow(/claude orchestrator evidence/i);

    const skipped = buildFinalizedReleaseSecurityFields({
      ...common,
      skippedOrchestrators: ['claude'],
    });
    expect(skipped.verification).toEqual({
      physicalProductWizard: true,
      skippedOrchestrators: ['claude'],
    });
    expect(skipped.verification).not.toHaveProperty(
      'physicalClaudeOrchestrator',
    );
    expect(skipped.releaseArtifacts).not.toHaveProperty(
      'e2eEvidenceClaudeOrchestrator',
    );
    expect(() =>
      buildFinalizedReleaseSecurityFields({
        ...common,
        skippedOrchestrators: ['claude'],
        e2eEvidenceClaudeOrchestrator: {
          name: 'real-mission-evidence-claude-orchestrator.json',
          bytes: 10,
          sha256: 'd'.repeat(64),
        },
      }),
    ).toThrow(/fabricated Claude evidence/i);
  });

  it('requires the exact repository-authorized Node patch', () => {
    expect(() =>
      buildReleaseSecurityArtifactsWithPinnedNpm({
        root: tempRoot(),
        nodeVersion: 'v22.23.0',
        expectedNodeVersion: '22.23.1',
      }),
    ).toThrow(/requires Node 22\.23\.1/);
  });

  it('writes a production audit, CycloneDX SBOM and hashed manifest', () => {
    const root = tempRoot();
    const runCommand = vi.fn((args) => {
      if (args[0] === 'audit') {
        return {
          status: 0,
          stdout: JSON.stringify({
            auditReportVersion: 2,
            vulnerabilities: {},
            metadata: {
              vulnerabilities: {
                info: 0,
                low: 0,
                moderate: 0,
                high: 0,
                critical: 0,
                total: 0,
              },
            },
          }),
          stderr: '',
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          bomFormat: 'CycloneDX',
          specVersion: '1.5',
          version: 1,
          components: [],
        }),
        stderr: '',
      };
    });

    const result = buildReleaseSecurityArtifacts({
      root,
      outDir: path.join(root, 'artifacts'),
      runCommand,
      commitSha: 'a'.repeat(40),
      ...securityAuthority,
      runtime: { node: 'v22.23.1', npm: '12.0.0' },
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(runCommand).toHaveBeenNthCalledWith(1, [
      'audit',
      '--omit=dev',
      '--json',
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(2, [
      'sbom',
      '--omit=dev',
      '--package-lock-only',
      '--sbom-format=cyclonedx',
      '--sbom-type=application',
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(3, ['audit', '--json']);
    expect(runCommand).toHaveBeenNthCalledWith(4, [
      'sbom',
      '--package-lock-only',
      '--sbom-format=cyclonedx',
      '--sbom-type=application',
    ]);
    expect(result.manifest).toMatchObject({
      schemaVersion: 3,
      package: { name: 'nexus-ide', version: '1.2.3' },
      commitSha: 'a'.repeat(40),
      runtime: { node: 'v22.23.1', npm: '12.0.0' },
      audit: {
        productionVulnerabilities: 0,
        buildToolchainVulnerabilities: 0,
      },
    });
    expect(result.manifest.packageLockSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.manifest.files).toHaveLength(4);
    expect(
      result.manifest.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256)),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, 'artifacts', 'nexus-1.2.3.cdx.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'artifacts', 'audit-production.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'artifacts', 'audit-build-toolchain.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'artifacts', 'nexus-1.2.3-toolchain.cdx.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'artifacts', 'security-manifest.json'))).toBe(true);
  });

  it('fails closed before generating an SBOM when production audit is nonzero', () => {
    const root = tempRoot();
    const runCommand = vi.fn(() => ({
      status: 1,
      stdout: JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: { unsafe: {} },
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 1,
            critical: 0,
            total: 1,
          },
        },
      }),
      stderr: '',
    }));

    expect(() =>
      buildReleaseSecurityArtifacts({
        root,
        outDir: path.join(root, 'artifacts'),
        runCommand,
        commitSha: 'a'.repeat(40),
        ...securityAuthority,
      }),
    ).toThrow(/1 vulnerabilidade/i);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed command output instead of publishing an unverifiable file', () => {
    const root = tempRoot();
    const runCommand = vi.fn(() => ({ status: 0, stdout: '{}', stderr: '' }));
    expect(() =>
      buildReleaseSecurityArtifacts({
        root,
        outDir: path.join(root, 'artifacts'),
        runCommand,
        commitSha: 'a'.repeat(40),
        ...securityAuthority,
      }),
    ).toThrow(/audit.*inválido/i);
  });

  it('fails closed when the build toolchain audit is nonzero', () => {
    const root = tempRoot();
    let auditCount = 0;
    const runCommand = vi.fn((args) => {
      if (args[0] === 'audit') {
        auditCount += 1;
        const total = auditCount === 2 ? 1 : 0;
        return {
          status: total === 0 ? 0 : 1,
          stdout: JSON.stringify({
            metadata: {
              vulnerabilities: {
                info: 0, low: 0, moderate: 0, high: total, critical: 0, total,
              },
            },
          }),
          stderr: '',
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          bomFormat: 'CycloneDX',
          components: [],
        }),
        stderr: '',
      };
    });
    expect(() => buildReleaseSecurityArtifacts({
      root,
      outDir: path.join(root, 'artifacts'),
      runCommand,
      commitSha: 'a'.repeat(40),
      ...securityAuthority,
    })).toThrow(/build toolchain.*1 vulnerabilidade/i);
  });

  it('never finalizes a structurally valid but synthetic physical receipt', () => {
    const root = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    buildReleaseSecurityArtifacts({
      root,
      outDir: artifacts,
      runCommand: (args) => ({
        status: 0,
        stdout: JSON.stringify(
          args[0] === 'audit'
            ? {
                metadata: {
                  vulnerabilities: {
                    info: 0,
                    low: 0,
                    moderate: 0,
                    high: 0,
                    critical: 0,
                    total: 0,
                  },
                },
              }
            : { bomFormat: 'CycloneDX', components: [] },
        ),
        stderr: '',
      }),
      commitSha: 'a'.repeat(40),
      ...securityAuthority,
      runtime: { node: 'v22.23.1', npm: '12.0.0' },
    });
    const dmg = path.join(root, 'NexusIDE.dmg');
    const zip = path.join(root, 'NexusIDE.zip');
    const evidence = path.join(root, 'real-mission-evidence.json');
    fs.writeFileSync(dmg, 'dmg');
    fs.writeFileSync(zip, 'zip');
    fs.writeFileSync(
      evidence,
      JSON.stringify(makeValidRealMissionEvidence()),
    );

    expect(() =>
      finalizeReleaseSecurityArtifacts({
        securityDir: artifacts,
        root,
        dmgPath: dmg,
        zipPath: zip,
        evidencePath: evidence,
        commitSha: 'a'.repeat(40),
        version: '1.2.3',
        ...securityAuthority,
        expectedE2EArtifactSha256: shaFor('zip'),
        expectedSigningIdentity:
          'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
        now: () => new Date('2026-07-23T01:00:00.000Z'),
      }),
    ).toThrow(/live verified runtime proof/i);
  });

  it('never finalizes private-runner evidence as release security proof', () => {
    const root = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    buildReleaseSecurityArtifacts({
      root,
      outDir: artifacts,
      runCommand: (args) => ({
        status: 0,
        stdout: JSON.stringify(
          args[0] === 'audit'
            ? { metadata: { vulnerabilities: { total: 0 } } }
            : { bomFormat: 'CycloneDX', components: [] },
        ),
        stderr: '',
      }),
      commitSha: 'a'.repeat(40),
      ...securityAuthority,
      runtime: { node: 'v22.23.1', npm: '12.0.0' },
    });
    const dmg = path.join(root, 'NexusIDE.dmg');
    const zip = path.join(root, 'NexusIDE.zip');
    const evidence = path.join(root, 'private-runner.json');
    fs.writeFileSync(dmg, 'dmg');
    fs.writeFileSync(zip, 'zip');
    fs.writeFileSync(
      evidence,
      JSON.stringify(
        makeValidRealMissionEvidence({
          launchSurface: 'private-runner',
        }),
      ),
    );

    expect(() =>
      finalizeReleaseSecurityArtifacts({
        securityDir: artifacts,
        root,
        dmgPath: dmg,
        zipPath: zip,
        evidencePath: evidence,
        commitSha: 'a'.repeat(40),
        version: '1.2.3',
        ...securityAuthority,
        expectedE2EArtifactSha256: shaFor('zip'),
        expectedSigningIdentity:
          'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
      }),
    ).toThrow(/product-wizard|diagnostic-only|physical/i);
    expect(
      fs.existsSync(path.join(artifacts, 'real-mission-evidence.json')),
    ).toBe(false);
  });

  it('rejects a structurally forged PASS receipt during finalization', () => {
    const root = tempRoot();
    const artifacts = path.join(root, 'artifacts');
    buildReleaseSecurityArtifacts({
      root,
      outDir: artifacts,
      runCommand: (args) => ({
        status: 0,
        stdout: JSON.stringify(
          args[0] === 'audit'
            ? { metadata: { vulnerabilities: { total: 0 } } }
            : { bomFormat: 'CycloneDX', components: [] },
        ),
        stderr: '',
      }),
      commitSha: 'a'.repeat(40),
      ...securityAuthority,
      runtime: { node: 'v22.23.1', npm: '12.0.0' },
    });
    const dmg = path.join(root, 'NexusIDE.dmg');
    const zip = path.join(root, 'NexusIDE.zip');
    const evidence = path.join(root, 'real-mission-evidence.json');
    fs.writeFileSync(dmg, 'dmg');
    fs.writeFileSync(zip, 'zip');
    fs.writeFileSync(
      evidence,
      JSON.stringify({
        status: 'pass',
        release: {
          commitSha: 'a'.repeat(40),
          appVersion: '1.2.3',
          artifact: {
            sha256: shaFor('zip'),
            identity:
              'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
          },
        },
      }),
    );

    expect(() =>
      finalizeReleaseSecurityArtifacts({
        securityDir: artifacts,
        root,
        dmgPath: dmg,
        zipPath: zip,
        evidencePath: evidence,
        commitSha: 'a'.repeat(40),
        version: '1.2.3',
        ...securityAuthority,
        expectedE2EArtifactSha256: shaFor('zip'),
        expectedSigningIdentity:
          'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
      }),
    ).toThrow(/real mission evidence|incomplete|PASS/i);
  });

  it('rejects a forged or stale security manifest before finalization', () => {
    const root = tempRoot();
    const manifest = {
      schemaVersion: 3,
      package: { name: 'nexus-ide', version: '1.2.3' },
      commitSha: 'a'.repeat(40),
      tagObjectSha: 'b'.repeat(40),
      tagSignerFingerprint: 'A'.repeat(40),
      tagSignatureVerified: true,
      generatedAt: '2026-07-23T00:00:00.000Z',
      runtime: { node: 'v22.23.1', npm: '12.0.0' },
      packageLockSha256: '0'.repeat(64),
      audit: {
        productionVulnerabilities: 0,
        buildToolchainVulnerabilities: 0,
      },
      files: [],
    };
    expect(() => assertReleaseSecurityManifest({
      root,
      manifest,
      commitSha: 'a'.repeat(40),
      version: '1.2.3',
      tagObjectSha: 'b'.repeat(40),
      tagSignerFingerprint: 'A'.repeat(40),
      tagSignatureVerified: true,
    })).toThrow(/package-lock/i);
    expect(() => assertReleaseSecurityManifest({
      root,
      manifest: {
        ...manifest,
        packageLockSha256: shaFor('{"lockfileVersion":3}\n'),
        audit: {
          productionVulnerabilities: 1,
          buildToolchainVulnerabilities: 0,
        },
      },
      commitSha: 'a'.repeat(40),
      version: '1.2.3',
      tagObjectSha: 'b'.repeat(40),
      tagSignerFingerprint: 'A'.repeat(40),
      tagSignatureVerified: true,
    })).toThrow(/vulnerabilit/i);
  });
});

function shaFor(value) {
  return createHash('sha256').update(value).digest('hex');
}
