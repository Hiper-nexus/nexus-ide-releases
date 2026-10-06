import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertFreshCandidateArtifacts,
  assertCandidateBuildReceipt,
  assertCandidateArtifactSeal,
  captureCandidateArtifactSeal,
  assertReleaseRepositoryState,
  runReleaseCandidateGate,
  runReleaseCandidateGateTestCore,
} from './release-candidate-gate.mjs';
import { buildReleaseSecurityArtifacts } from './release-security-gate.mjs';

const roots = [];
const TAG_AUTHORITY = {
  tagObjectSha: 'b'.repeat(40),
  tagObjectType: 'tag',
  tagSignerFingerprint: 'A'.repeat(40),
};
const RELEASE_AUTHORITY = {
  version: '1.2.3',
  tag: 'v1.2.3',
  nodeVersion: '22.23.1',
  npmVersion: '12.0.0',
  npmPackageIntegrity:
    'sha512-qzvPQfNSY7louiM6rv7dL0hi5esBGLn1lLwxbdyL5XOIssWzoYMwn8xqvWhYcZL6onTkenYSxrtKxsFrFbUFyw==',
  allowedTagSignerFingerprints: ['A'.repeat(40)],
};

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-candidate-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'out', 'make', 'nested'), { recursive: true });
  fs.mkdirSync(
    path.join(root, 'out', 'NexusIDE-darwin-arm64', 'NexusIDE.app'),
    { recursive: true },
  );
  fs.mkdirSync(path.join(root, 'release-artifacts', 'security'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'nexus-ide',
      version: '1.2.3',
      packageManager: 'npm@12.0.0',
      nexusRelease: { node: '22.23.1' },
    }),
  );
  fs.writeFileSync(path.join(root, 'package-lock.json'), 'lock');
  return root;
}

const hash = (value) =>
  createHash('sha256').update(value).digest('hex');

const buildTestSecurityArtifacts = (options) =>
  buildReleaseSecurityArtifacts({
    ...options,
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
    runtime: { node: 'v22.23.1', npm: '12.0.0' },
  });

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('manual release candidate gate', () => {
  it('keeps dependency injection outside the sealed production entrypoint', () => {
    expect(() =>
      runReleaseCandidateGate({
        runPackagedSmoke: vi.fn(),
      }),
    ).toThrow(/rejects dependency override/i);
    const inherited = Object.create({
      runPackagedSmoke: vi.fn(),
      runChecked: vi.fn(),
      repository: {},
    });
    expect(() => runReleaseCandidateGate(inherited)).toThrow(
      /rejects dependency override/i,
    );
  });

  it('requires clean tracked/staged/untracked state and tag^{commit}=HEAD', () => {
    expect(() => assertReleaseRepositoryState({
      statusPorcelain: '?? forgotten.txt\n',
      headSha: 'a'.repeat(40),
      tagCommitSha: 'a'.repeat(40),
      ...TAG_AUTHORITY,
      allowedTagSignerFingerprints:
        RELEASE_AUTHORITY.allowedTagSignerFingerprints,
      version: '1.2.3',
    })).toThrow(/untracked|dirty/i);
    expect(() => assertReleaseRepositoryState({
      statusPorcelain: '',
      headSha: 'a'.repeat(40),
      tagCommitSha: 'b'.repeat(40),
      ...TAG_AUTHORITY,
      allowedTagSignerFingerprints:
        RELEASE_AUTHORITY.allowedTagSignerFingerprints,
      version: '1.2.3',
    })).toThrow(/tag.*HEAD/i);
    expect(assertReleaseRepositoryState({
      statusPorcelain: '',
      headSha: 'a'.repeat(40),
      tagCommitSha: 'a'.repeat(40),
      ...TAG_AUTHORITY,
      allowedTagSignerFingerprints:
        RELEASE_AUTHORITY.allowedTagSignerFingerprints,
      version: '1.2.3',
    })).toEqual({
      commitSha: 'a'.repeat(40),
      tag: 'v1.2.3',
      tagObjectSha: TAG_AUTHORITY.tagObjectSha,
      tagSignerFingerprint: TAG_AUTHORITY.tagSignerFingerprint,
      tagSignatureVerified: true,
    });
  });

  it('requires exactly one freshly generated host-architecture DMG and ZIP', () => {
    const root = tempRoot();
    const dmg = path.join(root, 'out', 'make', 'nested', 'NexusIDE-arm64.dmg');
    const zip = path.join(root, 'out', 'make', 'nested', 'NexusIDE-arm64.zip');
    fs.writeFileSync(dmg, 'dmg');
    fs.writeFileSync(zip, 'zip');
    const generatedAfterMs = Date.now() - 1_000;
    fs.utimesSync(dmg, new Date(), new Date());
    fs.utimesSync(zip, new Date(), new Date());
    expect(assertFreshCandidateArtifacts({
      paths: [dmg, zip],
      generatedAfterMs,
      expectedArch: 'arm64',
    })).toEqual({ dmg, zip });
    fs.utimesSync(zip, new Date(0), new Date(0));
    expect(() => assertFreshCandidateArtifacts({
      paths: [dmg, zip],
      generatedAfterMs,
      expectedArch: 'arm64',
    })).toThrow(/fresh/i);
  });

  it('detects candidate byte replacement after signed verification', () => {
    const root = tempRoot();
    const dmg = path.join(root, 'out', 'make', 'nested', 'NexusIDE-arm64.dmg');
    const zip = path.join(root, 'out', 'make', 'nested', 'NexusIDE-arm64.zip');
    fs.writeFileSync(dmg, 'dmg');
    fs.writeFileSync(zip, 'zip');
    const seal = captureCandidateArtifactSeal({ dmg, zip });

    fs.writeFileSync(zip, 'replaced after codesign verification');
    expect(() => assertCandidateArtifactSeal(seal)).toThrow(
      /bytes changed after signed verification/i,
    );
  });

  it('binds the exact artifact bytes/path/mtime emitted by the tagged build', () => {
    const root = tempRoot();
    const dmg = path.join(root, 'out', 'make', 'nested', 'NexusIDE-arm64.dmg');
    const zip = path.join(root, 'out', 'make', 'nested', 'NexusIDE-arm64.zip');
    fs.writeFileSync(dmg, 'dmg');
    fs.writeFileSync(zip, 'zip');
    const entries = [dmg, zip].map((filePath) => {
      const stat = fs.statSync(filePath);
      return {
        path: path.relative(root, filePath),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: hash(fs.readFileSync(filePath)),
      };
    });
    const receipt = {
      schemaVersion: 2,
      startedAt: '2026-07-23T00:00:00.000Z',
      version: '1.2.3',
      tag: 'v1.2.3',
      architecture: 'arm64',
      commitSha: 'a'.repeat(40),
      tagObjectSha: 'b'.repeat(40),
      tagSignerFingerprint: 'A'.repeat(40),
      tagSignatureVerified: true,
      provenance: {
        mode: 'clean-git-worktree',
        npmCi: true,
        sourceCommitSha: 'a'.repeat(40),
        packageLockSha256: hash('lock'),
        nodeVersion: 'v22.23.1',
        npmVersion: '12.0.0',
        npmPackageIntegrity:
          'sha512-qzvPQfNSY7louiM6rv7dL0hi5esBGLn1lLwxbdyL5XOIssWzoYMwn8xqvWhYcZL6onTkenYSxrtKxsFrFbUFyw==',
      },
      artifacts: entries,
    };
    expect(assertCandidateBuildReceipt({
      root,
      receipt,
      commitSha: 'a'.repeat(40),
      version: '1.2.3',
      tagObjectSha: 'b'.repeat(40),
      tagSignerFingerprint: 'A'.repeat(40),
      tagSignatureVerified: true,
      packageLockSha256: hash('lock'),
      npmVersion: '12.0.0',
      npmPackageIntegrity: RELEASE_AUTHORITY.npmPackageIntegrity,
      nodeVersion: '22.23.1',
      expectedArch: 'arm64',
      artifacts: { dmg, zip },
    })).toBe(Date.parse(receipt.startedAt));
    fs.writeFileSync(zip, 'tampered');
    expect(() => assertCandidateBuildReceipt({
      root,
      receipt,
      commitSha: 'a'.repeat(40),
      version: '1.2.3',
      tagObjectSha: 'b'.repeat(40),
      tagSignerFingerprint: 'A'.repeat(40),
      tagSignatureVerified: true,
      packageLockSha256: hash('lock'),
      npmVersion: '12.0.0',
      npmPackageIntegrity: RELEASE_AUTHORITY.npmPackageIntegrity,
      nodeVersion: '22.23.1',
      expectedArch: 'arm64',
      artifacts: { dmg, zip },
    })).toThrow(/diverges/);
    expect(() => assertCandidateBuildReceipt({
      root,
      receipt: { ...receipt, provenance: { ...receipt.provenance, npmCi: false } },
      commitSha: 'a'.repeat(40),
      version: '1.2.3',
      tagObjectSha: 'b'.repeat(40),
      tagSignerFingerprint: 'A'.repeat(40),
      tagSignatureVerified: true,
      packageLockSha256: hash('lock'),
      npmVersion: '12.0.0',
      npmPackageIntegrity: RELEASE_AUTHORITY.npmPackageIntegrity,
      nodeVersion: '22.23.1',
      expectedArch: 'arm64',
      artifacts: { dmg, zip },
    })).toThrow(/provenance/i);
  });

  it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('runs signed verifier and the packaged smoke before producing a commit/artifact-bound receipt', async () => {
    const root = tempRoot();
    const dmg = path.join(root, 'out', 'make', 'nested', 'NexusIDE-arm64.dmg');
    const zip = path.join(root, 'out', 'make', 'nested', 'NexusIDE-arm64.zip');
    const app = path.join(
      root,
      'out',
      'NexusIDE-darwin-arm64',
      'NexusIDE.app',
    );
    fs.writeFileSync(dmg, 'dmg');
    fs.writeFileSync(zip, 'zip');
    const runChecked = vi.fn(() => ({ stdout: '', stderr: '' }));
    const runPackagedSmoke = vi.fn(async () => ({ code: 0, output:
      '[smoke] renderer-mounted\n[smoke] functional-ready\n' +
      '[smoke] main-owned-command {"status":"passed","densePathFiles":768,"profileBytes":4096,"exitCode":0,"physicalExitProven":true}\n',
    }));
    const result = await runReleaseCandidateGateTestCore({
      root,
      environment: {
        NEXUS_MAC_PUBLISH_RELEASE: '1',
        APPLE_TEAM_ID: '35P5XL3JN6',
        APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
      },
      generatedAfterMs: Date.now() - 1_000,
      authority: RELEASE_AUTHORITY,
      repository: {
        statusPorcelain: '',
        headSha: 'a'.repeat(40),
        tagCommitSha: 'a'.repeat(40),
        ...TAG_AUTHORITY,
      },
      buildSecurityArtifacts: buildTestSecurityArtifacts,
      runChecked,
      runPackagedSmoke,
      extractE2EApp: async (_zipPath, _expectedSha256, callback) =>
        callback(app),
      now: () => new Date('2026-07-23T01:00:00.000Z'),
    });

    expect(runChecked).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringMatching(/verify-macos-release\.mjs$/u),
        '--artifacts',
        path.join(root, 'out', 'make'),
      ]),
      expect.any(Object),
    );
    expect(runPackagedSmoke).toHaveBeenCalledWith(app);
    expect(runPackagedSmoke).toHaveBeenCalledOnce();
    const smokeReportPath = path.join(
      root,
      'release-artifacts',
      'security',
      'packaged-smoke-report.json',
    );
    const smokeReport = JSON.parse(fs.readFileSync(smokeReportPath, 'utf8'));
    expect(smokeReport).toMatchObject({
      mainOwnedCommandProof: { status: 'passed', densePathFiles: 768, profileBytes: 4096, exitCode: 0, physicalExitProven: true },
      schemaVersion: 1,
      status: 'pass',
      smoke: 'packaged-app',
      appVersion: '1.2.3',
      commitSha: 'a'.repeat(40),
      artifact: {
        sha256: hash('zip'),
        identity:
          'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
      },
    });
    expect(result.receipt).toMatchObject({
      schemaVersion: 5,
      version: '1.2.3',
      tag: 'v1.2.3',
      commitSha: 'a'.repeat(40),
      tagObjectSha: TAG_AUTHORITY.tagObjectSha,
      tagSignerFingerprint: TAG_AUTHORITY.tagSignerFingerprint,
      tagSignatureVerified: true,
      architecture: 'arm64',
      artifacts: {
        dmg: { name: 'NexusIDE-arm64.dmg', sha256: hash('dmg') },
        zip: { name: 'NexusIDE-arm64.zip', sha256: hash('zip') },
        packagedSmoke: {
          name: 'packaged-smoke-report.json',
          sha256: hash(fs.readFileSync(smokeReportPath, 'utf8')),
        },
      },
      verification: {
        signedNotarized: true,
        packagedSmoke: true,
        sameCommitAndArtifacts: true,
        tagSignatureVerified: true,
      },
    });
    expect(result.smokeReportPath).toBe(smokeReportPath);
    expect(result.receiptPath).toBeNull();
    const testCoreManifest = JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          'release-artifacts',
          'security',
          'security-manifest.json',
        ),
        'utf8',
      ),
    );
    expect(testCoreManifest.verification).toBeUndefined();
    expect(testCoreManifest.releaseArtifacts).toBeUndefined();
    expect(
      fs.existsSync(
        path.join(
          root,
          'release-artifacts',
          'security',
          'release-candidate-receipt.json',
        ),
      ),
    ).toBe(false);
    expect(result.receipt.securityAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'security-manifest.json',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          name: 'packaged-smoke-report.json',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ]),
    );
  });

  it.runIf(process.platform === 'darwin' && process.arch === 'arm64').each(['failed', 'missing-proof', 'ad-hoc-proof'])('fails closed when packaged smoke has %s against the sealed ZIP app', async fault => {
    const root = tempRoot();
    const dmg = path.join(root, 'out', 'make', 'nested', 'NexusIDE-arm64.dmg');
    const zip = path.join(root, 'out', 'make', 'nested', 'NexusIDE-arm64.zip');
    const app = path.join(
      root,
      'out',
      'NexusIDE-darwin-arm64',
      'NexusIDE.app',
    );
    fs.writeFileSync(dmg, 'dmg');
    fs.writeFileSync(zip, 'zip');
    const runPackagedSmoke = vi.fn(async () => {
      if (fault === 'failed') throw new Error('functional smoke probes failed');
      return { code: 0, output: '[smoke] renderer-mounted\n[smoke] functional-ready\n' +
        (fault === 'ad-hoc-proof' ? '[smoke] main-owned-command {"status":"unavailable","reason":"ad-hoc"}\n' : '') };
    });

    await expect(
      runReleaseCandidateGateTestCore({
        root,
        environment: {
          NEXUS_MAC_PUBLISH_RELEASE: '1',
          APPLE_TEAM_ID: '35P5XL3JN6',
          APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
        },
        generatedAfterMs: Date.now() - 1_000,
        authority: RELEASE_AUTHORITY,
        repository: {
          statusPorcelain: '',
          headSha: 'a'.repeat(40),
          tagCommitSha: 'a'.repeat(40),
          ...TAG_AUTHORITY,
        },
        buildSecurityArtifacts: buildTestSecurityArtifacts,
        runChecked: vi.fn(() => ({ stdout: '', stderr: '' })),
        runPackagedSmoke,
        extractE2EApp: async (_zipPath, _expectedSha256, callback) =>
          callback(app),
      }),
    ).rejects.toThrow(fault === 'failed' ? /functional smoke probes failed/i : /Main-owned command proof/);
    expect(runPackagedSmoke).toHaveBeenCalledOnce();
    expect(
      fs.existsSync(
        path.join(
          root,
          'release-artifacts',
          'security',
          'packaged-smoke-report.json',
        ),
      ),
    ).toBe(false);
  });
});
