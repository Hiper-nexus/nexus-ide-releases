import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeValidRealMissionEvidence } from './test-support/real-mission-evidence.mjs';

import {
  CANONICAL_RELEASE_REPO,
  PUBLIC_RELEASE_REPO,
  buildAtomicReleasePushArgs,
  buildGitHubReleaseDraftArgs,
  buildGitHubReleasePublishArgs,
  buildGitHubReleaseUploadArgs,
  buildGitHubReleaseViewArgs,
  classifyGitHubReleaseResult,
  describeLocalReleaseAssets,
  assertPublishPhysicalCandidate,
  loadReusableReleaseCandidate,
  publishManualRelease,
  publishManualReleaseTestCore,
  resolveSecurityAssets,
  stageReleaseAssets,
  verifyRemoteMain,
  verifyRemoteTag,
  verifyCanonicalOrigin,
  verifyResumableGitHubDraft,
  verifyGitHubReleaseSnapshot,
} from './publish-release.mjs';

const publicationRoots = [];
afterAll(() => {
  for (const root of publicationRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('manual GitHub release publication', () => {
  it('keeps publication effects outside caller-controlled production seams', () => {
    expect(() =>
      publishManualRelease({ github: {} }),
    ).toThrow(/rejects dependency override/i);
    const inherited = Object.create({
      runCandidateGate: async () => ({}),
      github: {},
      repositoryPublisher: {},
    });
    expect(() => publishManualRelease(inherited)).toThrow(
      /rejects dependency override/i,
    );
  });

  it('rejects literal/private evidence even when receipt booleans claim physical UI', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-publish-physical-'));
    publicationRoots.push(root);
    const evidencePath = path.join(root, 'evidence.json');
    const privateEvidence = makeValidRealMissionEvidence({
      appVersion: '1.2.3',
      commitSha: 'a'.repeat(40),
      artifactSha256: 'b'.repeat(64),
      launchSurface: 'private-runner',
    });
    fs.writeFileSync(evidencePath, JSON.stringify(privateEvidence));
    expect(() =>
      assertPublishPhysicalCandidate({
        evidencePath,
        receipt: {
          version: '1.2.3',
          commitSha: 'a'.repeat(40),
          artifacts: {
            zip: { sha256: 'b'.repeat(64) },
            e2eEvidence: {
              sha256: digest(fs.readFileSync(evidencePath)),
            },
          },
          verification: {
            physicalProductWizard: true,
          },
        },
      }),
    ).toThrow(/product-wizard|physical/i);
  });

  it('rejects a literal single-mission flag when the physical inventory disagrees', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-publish-inventory-'));
    publicationRoots.push(root);
    const evidencePath = path.join(root, 'evidence.json');
    const evidence = makeValidRealMissionEvidence();
    evidence.missionInventory.observedMissionCount = 2;
    evidence.missionInventory.observedMissionIds.push('mission-extra');
    evidence.missionInventory.exactSingleProductMission = false;
    fs.writeFileSync(evidencePath, JSON.stringify(evidence));

    expect(() =>
      assertPublishPhysicalCandidate({
        evidencePath,
        receipt: {
          version: '1.2.3',
          commitSha: 'a'.repeat(40),
          artifacts: {
            zip: { sha256: evidence.release.artifact.sha256 },
            e2eEvidence: {
              sha256: digest(fs.readFileSync(evidencePath)),
            },
          },
          verification: {
            physicalProductWizard: true,
            singleProductMission: true,
          },
        },
      }),
    ).toThrow(/inventory|product-wizard|physical/i);
  });

  it('requires the repository-pinned Node patch before touching GitHub', async () => {
    let inspected = false;
    await expect(
      publishManualReleaseTestCore({
        root: '/unused',
        environment: publishEnvironment(),
        authority: releaseAuthority(),
        nodeVersion: 'v22.23.0',
        github: {
          async inspect() {
            inspected = true;
            throw new Error('must not inspect');
          },
        },
      }),
    ).rejects.toThrow(/requires Node 22\.23\.1/i);
    expect(inspected).toBe(false);
  });

  it('pins every gh operation to an explicit repository', () => {
    const assetPaths = [
      '/root/out/make/NexusIDE-arm64.dmg',
      '/root/out/make/NexusIDE-arm64.zip',
      '/root/release-artifacts/security/security-manifest.json',
    ];
    expect(buildGitHubReleaseDraftArgs({
      tag: 'v1.2.3',
      repo: CANONICAL_RELEASE_REPO,
    })).toEqual([
      'release',
      'create',
      'v1.2.3',
      '--repo',
      `github.com/${CANONICAL_RELEASE_REPO}`,
      '--verify-tag',
      '--draft',
      '--title',
      'NexusIDE v1.2.3',
      '--generate-notes',
    ]);
    expect(buildGitHubReleaseUploadArgs({
      tag: 'v1.2.3',
      repo: CANONICAL_RELEASE_REPO,
      assetPaths,
    })).toEqual([
      'release',
      'upload',
      'v1.2.3',
      '--repo',
      `github.com/${CANONICAL_RELEASE_REPO}`,
      '--clobber',
      '/root/out/make/NexusIDE-arm64.dmg',
      '/root/out/make/NexusIDE-arm64.zip',
      '/root/release-artifacts/security/security-manifest.json',
    ]);
    expect(buildGitHubReleaseViewArgs({
      tag: 'v1.2.3',
      repo: PUBLIC_RELEASE_REPO,
    })).toEqual([
      'release',
      'view',
      'v1.2.3',
      '--repo',
      `github.com/${PUBLIC_RELEASE_REPO}`,
      '--json',
      'tagName,isDraft,publishedAt,assets',
    ]);
    expect(buildGitHubReleasePublishArgs({
      tag: 'v1.2.3',
      repo: PUBLIC_RELEASE_REPO,
    })).toEqual([
      'release',
      'edit',
      'v1.2.3',
      '--repo',
      `github.com/${PUBLIC_RELEASE_REPO}`,
      '--draft=false',
    ]);
    expect(buildGitHubReleaseDraftArgs({
      tag: 'v1.2.3',
      repo: PUBLIC_RELEASE_REPO,
      verifyTag: false,
    })).not.toContain('--verify-tag');
  });

  it('resumes only an exact private draft and refuses a public/foreign inventory', () => {
    const expectedAssets = [
      { name: 'NexusIDE.dmg', size: 10, sha256: 'a'.repeat(64) },
      { name: 'receipt.json', size: 20, sha256: 'b'.repeat(64) },
    ];
    expect(verifyResumableGitHubDraft({
      tagName: 'v1.2.3',
      isDraft: true,
      assets: [{ name: 'NexusIDE.dmg', size: 3, state: 'uploaded' }],
    }, { tag: 'v1.2.3', expectedAssets })).toMatchObject({ isDraft: true });
    expect(() => verifyResumableGitHubDraft({
      tagName: 'v1.2.3',
      isDraft: false,
      assets: [],
    }, { tag: 'v1.2.3', expectedAssets })).toThrow(/expected draft/);
    expect(() => verifyResumableGitHubDraft({
      tagName: 'v1.2.3',
      isDraft: true,
      assets: [{ name: 'foreign.bin', size: 1, state: 'uploaded' }],
    }, { tag: 'v1.2.3', expectedAssets })).toThrow(/unexpected asset/);
  });

  it('requires origin/main to resolve to the verified release commit', () => {
    const sha = 'a'.repeat(40);
    const tagObjectSha = 'c'.repeat(40);
    expect(buildAtomicReleasePushArgs({
      commitSha: sha,
      tag: 'v1.2.3',
      tagObjectSha,
    })).toEqual([
      'push',
      '--atomic',
      'origin',
      `${sha}:refs/heads/main`,
      `${tagObjectSha}:refs/tags/v1.2.3`,
    ]);
    expect(verifyRemoteMain(`${sha}\trefs/heads/main\n`, sha)).toBe(sha);
    expect(() => verifyRemoteMain(
      `${'b'.repeat(40)}\trefs/heads/main\n`,
      sha,
    )).toThrow(/origin\/main/);
    expect(verifyRemoteTag(
      `${tagObjectSha}\trefs/tags/v1.2.3\n${sha}\trefs/tags/v1.2.3^{}\n`,
      { tag: 'v1.2.3', expectedCommitSha: sha, expectedTagObjectSha: tagObjectSha },
    )).toBe(sha);
    expect(() => verifyRemoteTag(
      `${tagObjectSha}\trefs/tags/v1.2.3\n${'b'.repeat(40)}\trefs/tags/v1.2.3^{}\n`,
      { tag: 'v1.2.3', expectedCommitSha: sha, expectedTagObjectSha: tagObjectSha },
    )).toThrow(/release tag/);
  });

  it('proves fetch and push origin are the canonical GitHub repository', () => {
    expect(
      verifyCanonicalOrigin(
        'https://github.com/cleofasvolarehost/nexus-ide.git\n',
        'git@github.com:cleofasvolarehost/nexus-ide.git\n',
        CANONICAL_RELEASE_REPO,
      ),
    ).toBe(CANONICAL_RELEASE_REPO);
    expect(() =>
      verifyCanonicalOrigin(
        'https://github.com/mallory/nexus-ide.git\n',
        'https://github.com/mallory/nexus-ide.git\n',
        CANONICAL_RELEASE_REPO,
      ),
    ).toThrow(/canonical origin/i);
    expect(() =>
      verifyCanonicalOrigin(
        'https://github.com/cleofasvolarehost/nexus-ide.git\n',
        'https://github.com/mallory/nexus-ide.git\n',
        CANONICAL_RELEASE_REPO,
      ),
    ).toThrow(/canonical origin/i);
  });

  it('checks the exact remote draft inventory before publication', () => {
    const expectedAssets = [
      { name: 'NexusIDE.dmg', size: 10, sha256: 'a'.repeat(64) },
      { name: 'receipt.json', size: 20, sha256: 'b'.repeat(64) },
    ];
    const draft = {
      tagName: 'v1.2.3',
      isDraft: true,
      assets: [
        {
          name: 'receipt.json',
          size: 20,
          state: 'uploaded',
          digest: `sha256:${'b'.repeat(64)}`,
        },
        {
          name: 'NexusIDE.dmg',
          size: 10,
          state: 'uploaded',
          digest: `sha256:${'a'.repeat(64)}`,
        },
      ],
    };
    expect(verifyGitHubReleaseSnapshot(draft, {
      tag: 'v1.2.3',
      expectedDraft: true,
      expectedAssets,
    })).toBe(draft);
    expect(() => verifyGitHubReleaseSnapshot(
      {
        ...draft,
        assets: draft.assets.map(({ digest: _digest, ...asset }) => asset),
      },
      { tag: 'v1.2.3', expectedDraft: true, expectedAssets },
    )).toThrow(/do not match/);
    expect(() => verifyGitHubReleaseSnapshot(
      { ...draft, assets: [{ name: 'NexusIDE.dmg', size: 9 }] },
      { tag: 'v1.2.3', expectedDraft: true, expectedAssets },
    )).toThrow(/do not match/);
    expect(() => verifyGitHubReleaseSnapshot(
      { ...draft, isDraft: false },
      { tag: 'v1.2.3', expectedDraft: true, expectedAssets },
    )).toThrow(/draft state/);
    expect(() => verifyGitHubReleaseSnapshot(
      {
        ...draft,
        isDraft: false,
        assets: draft.assets.map(({ digest: _digest, ...asset }) => asset),
      },
      { tag: 'v1.2.3', expectedDraft: false, expectedAssets },
    )).toThrow(/do not match/);
    const published = {
      ...draft,
      isDraft: false,
      assets: draft.assets.map((asset) => ({
        ...asset,
        digest:
          asset.name === 'NexusIDE.dmg'
            ? `sha256:${'a'.repeat(64)}`
            : `sha256:${'b'.repeat(64)}`,
      })),
    };
    expect(verifyGitHubReleaseSnapshot(
      published,
      { tag: 'v1.2.3', expectedDraft: false, expectedAssets },
    )).toMatchObject({ isDraft: false });
  });

  it('rejects duplicate basenames before any GitHub upload', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-assets-test-'));
    try {
      const left = path.join(root, 'left');
      const right = path.join(root, 'right');
      fs.mkdirSync(left);
      fs.mkdirSync(right);
      fs.writeFileSync(path.join(left, 'same.zip'), 'left');
      fs.writeFileSync(path.join(right, 'same.zip'), 'right');
      expect(() => describeLocalReleaseAssets([
        path.join(left, 'same.zip'),
        path.join(right, 'same.zip'),
      ])).toThrow(/duplicate/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes only from a private read-only staging snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stage-test-'));
    try {
      const dmg = path.join(root, 'NexusIDE.dmg');
      const zip = path.join(root, 'NexusIDE.zip');
      fs.writeFileSync(dmg, 'dmg');
      fs.writeFileSync(zip, 'zip');
      const canonicalAssetPaths = [dmg, zip];
      const staged = stageReleaseAssets({
        canonicalAssetPaths,
        publicAssetPaths: [zip],
        canonicalAssets: describeLocalReleaseAssets(canonicalAssetPaths),
        publicAssets: describeLocalReleaseAssets([zip]),
      });
      try {
        expect(staged.release.canonicalAssetPaths).not.toEqual(
          canonicalAssetPaths,
        );
        expect(
          fs.statSync(path.dirname(staged.release.canonicalAssetPaths[0])).mode &
            0o777,
        ).toBe(0o700);
        expect(
          fs.statSync(staged.release.canonicalAssetPaths[0]).mode & 0o777,
        ).toBe(0o400);
        fs.writeFileSync(dmg, 'changed after staging');
        expect(describeLocalReleaseAssets(
          staged.release.canonicalAssetPaths,
        )).toEqual(staged.release.canonicalAssets);
      } finally {
        staged.cleanup();
      }
      expect(fs.existsSync(staged.release.canonicalAssetPaths[0])).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects undeclared or modified security assets before upload', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-publish-test-'));
    try {
      const fixture = createCandidateSecurityFixture(root);
      expect(resolveSecurityAssets(
        fixture.securityDir,
        fixture.receipt,
      )).toHaveLength(8);
      fs.writeFileSync(
        path.join(fixture.securityDir, 'undeclared-secret.txt'),
        'private',
      );
      expect(() => resolveSecurityAssets(
        fixture.securityDir,
        fixture.receipt,
      )).toThrow(/undeclared/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a self-consistent rewritten security manifest not sealed by the gate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-seal-test-'));
    try {
      const fixture = createCandidateSecurityFixture(root);
      const auditPath = path.join(
        fixture.securityDir,
        'audit-production.json',
      );
      const manifestPath = path.join(
        fixture.securityDir,
        'security-manifest.json',
      );
      const replacement = `${JSON.stringify({
        metadata: { vulnerabilities: { total: 0 } },
        forged: true,
      }, null, 2)}\n`;
      fs.writeFileSync(auditPath, replacement);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const entry = manifest.files.find(
        (candidate) => candidate.name === 'audit-production.json',
      );
      entry.bytes = Buffer.byteLength(replacement);
      entry.sha256 = digest(replacement);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      expect(() =>
        resolveSecurityAssets(fixture.securityDir, fixture.receipt),
      ).toThrow(/sealed security asset|security asset seal/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes an absent release from an inspection failure', () => {
    expect(classifyGitHubReleaseResult({
      ok: false,
      status: 1,
      stdout: '',
      stderr: 'release not found',
    }, {
      repo: CANONICAL_RELEASE_REPO,
      tag: 'v1.2.3',
    })).toMatchObject({ kind: 'missing' });
    expect(() => classifyGitHubReleaseResult({
      ok: false,
      status: 1,
      stdout: '',
      stderr: 'network timeout',
    }, {
      repo: CANONICAL_RELEASE_REPO,
      tag: 'v1.2.3',
    })).toThrow(/cannot inspect/);
  });

  it('revalidates a durable candidate without rerunning packaged E2E', () => {
    const root = createReusableCandidateFixture();
    try {
      const commitSha = 'a'.repeat(40);
      const candidate = loadReusableReleaseCandidate({
        root,
        environment: publishEnvironment(),
        authority: releaseAuthority(),
        repository: {
          statusPorcelain: '?? out/\n?? release-artifacts/\n',
          headSha: commitSha,
          tagCommitSha: commitSha,
          tagObjectSha: 'e'.repeat(40),
          tagObjectType: 'tag',
          tagSignerFingerprint: null,
        },
      });
      expect(candidate.receipt.tag).toBe('v1.2.3');
      expect(path.basename(candidate.artifacts.dmg)).toBe('NexusIDE-arm64.dmg');
      expect(() => loadReusableReleaseCandidate({
        root,
        environment: publishEnvironment(),
        authority: releaseAuthority(),
        repository: {
          statusPorcelain: '?? out/\n?? release-artifacts/\n',
          headSha: commitSha,
          tagCommitSha: commitSha,
          tagObjectSha: 'f'.repeat(40),
          tagObjectType: 'tag',
          tagSignerFingerprint: null,
        },
      })).toThrow(/receipt/i);
      fs.appendFileSync(candidate.artifacts.zip, 'changed');
      expect(() => loadReusableReleaseCandidate({
        root,
        environment: publishEnvironment(),
        authority: releaseAuthority(),
        repository: {
          statusPorcelain: '',
          headSha: commitSha,
          tagCommitSha: commitSha,
          tagObjectSha: 'e'.repeat(40),
          tagObjectType: 'tag',
          tagSignerFingerprint: null,
        },
      })).toThrow(/artifact digest/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prepares both exact drafts before publishing canonical then public', async () => {
    const fixture = publicationFixture();
    const events = [];
    const github = fakeGitHub({
      states: new Map(),
      fixture,
      events,
    });
    const result = await publishManualReleaseTestCore({
      root: '/unused',
      environment: publishEnvironment(),
      version: '1.2.3',
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      stageReleaseAssets: passthroughStage,
      github,
      repositoryPublisher: {
        async push({ commitSha, tag, tagObjectSha }) {
          events.push(`push:${commitSha}:${tag}:${tagObjectSha}`);
        },
        async verify() {
          events.push('verify-refs');
        },
      },
      async runCandidateGate() {
        events.push('candidate-gate');
        return fixture.candidate;
      },
      async loadReusableCandidate() {
        throw new Error('fresh path must not use a prior receipt');
      },
      materializeCandidate: () => fixture.release,
    });
    expect(result.resumedFromPublishedCanonical).toBe(false);
    expect(events).toEqual([
      'candidate-gate',
      `push:${'a'.repeat(40)}:v1.2.3:${'e'.repeat(40)}`,
      'verify-refs',
      `create:${CANONICAL_RELEASE_REPO}:verify`,
      `upload:${CANONICAL_RELEASE_REPO}:dmg,security,zip`,
      `create:${PUBLIC_RELEASE_REPO}:no-verify`,
      `upload:${PUBLIC_RELEASE_REPO}:dmg,zip`,
      'verify-refs',
      `publish:${CANONICAL_RELEASE_REPO}`,
      'verify-refs',
      `publish:${PUBLIC_RELEASE_REPO}`,
      'verify-refs',
    ]);
    expect(events.indexOf(`upload:${PUBLIC_RELEASE_REPO}:dmg,zip`))
      .toBeLessThan(events.indexOf(`publish:${CANONICAL_RELEASE_REPO}`));
  });

  it('reruns the candidate gate and clobbers both resumable drafts', async () => {
    const fixture = publicationFixture();
    const events = [];
    const states = new Map([
      [
        CANONICAL_RELEASE_REPO,
        releaseState(
          CANONICAL_RELEASE_REPO,
          'v1.2.3',
          true,
          [fixture.release.canonicalAssets[0]],
        ),
      ],
      [
        PUBLIC_RELEASE_REPO,
        releaseState(
          PUBLIC_RELEASE_REPO,
          'v1.2.3',
          true,
          [fixture.release.publicAssets[1]],
        ),
      ],
    ]);
    await publishManualReleaseTestCore({
      root: '/unused',
      environment: publishEnvironment(),
      version: '1.2.3',
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      stageReleaseAssets: passthroughStage,
      github: fakeGitHub({ states, fixture, events }),
      repositoryPublisher: {
        async push() {
          events.push('push-and-verify-refs');
        },
        async verify() {
          events.push('verify-refs');
        },
      },
      async runCandidateGate() {
        events.push('candidate-gate');
        return fixture.candidate;
      },
      async loadReusableCandidate() {
        throw new Error('draft path must not reuse old evidence');
      },
      materializeCandidate: () => fixture.release,
    });
    expect(events).toEqual([
      'candidate-gate',
      'push-and-verify-refs',
      'verify-refs',
      `upload:${CANONICAL_RELEASE_REPO}:dmg,security,zip`,
      `upload:${PUBLIC_RELEASE_REPO}:dmg,zip`,
      'verify-refs',
      `publish:${CANONICAL_RELEASE_REPO}`,
      'verify-refs',
      `publish:${PUBLIC_RELEASE_REPO}`,
      'verify-refs',
    ]);
  });

  it('resumes after canonical publication from the sealed local receipt only', async () => {
    const fixture = publicationFixture();
    const events = [];
    const states = new Map([
      [
        CANONICAL_RELEASE_REPO,
        releaseState(
          CANONICAL_RELEASE_REPO,
          'v1.2.3',
          false,
          fixture.release.canonicalAssets,
        ),
      ],
      [
        PUBLIC_RELEASE_REPO,
        releaseState(
          PUBLIC_RELEASE_REPO,
          'v1.2.3',
          true,
          [fixture.release.publicAssets[0]],
        ),
      ],
    ]);
    const result = await publishManualReleaseTestCore({
      root: '/unused',
      environment: publishEnvironment(),
      version: '1.2.3',
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      stageReleaseAssets: passthroughStage,
      github: fakeGitHub({ states, fixture, events }),
      repositoryPublisher: {
        async push() {
          throw new Error('published canonical retry must not push');
        },
        async verify({ commitSha, tag, tagObjectSha }) {
          events.push(`verify-refs:${commitSha}:${tag}:${tagObjectSha}`);
        },
      },
      async runCandidateGate() {
        throw new Error('published canonical retry must not rerun E2E');
      },
      async loadReusableCandidate() {
        events.push('load-sealed-candidate');
        return fixture.candidate;
      },
      materializeCandidate: () => fixture.release,
    });
    expect(result.resumedFromPublishedCanonical).toBe(true);
    expect(events).toEqual([
      'load-sealed-candidate',
      `verify-refs:${'a'.repeat(40)}:v1.2.3:${'e'.repeat(40)}`,
      `upload:${PUBLIC_RELEASE_REPO}:dmg,zip`,
      `verify-refs:${'a'.repeat(40)}:v1.2.3:${'e'.repeat(40)}`,
      `verify-refs:${'a'.repeat(40)}:v1.2.3:${'e'.repeat(40)}`,
      `publish:${PUBLIC_RELEASE_REPO}`,
      `verify-refs:${'a'.repeat(40)}:v1.2.3:${'e'.repeat(40)}`,
    ]);
  });

  it('is a write-free success when both published snapshots are exact', async () => {
    const fixture = publicationFixture();
    const events = [];
    const states = new Map([
      [
        CANONICAL_RELEASE_REPO,
        releaseState(
          CANONICAL_RELEASE_REPO,
          'v1.2.3',
          false,
          fixture.release.canonicalAssets,
        ),
      ],
      [
        PUBLIC_RELEASE_REPO,
        releaseState(
          PUBLIC_RELEASE_REPO,
          'v1.2.3',
          false,
          fixture.release.publicAssets,
        ),
      ],
    ]);
    await publishManualReleaseTestCore({
      root: '/unused',
      environment: publishEnvironment(),
      version: '1.2.3',
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      stageReleaseAssets: passthroughStage,
      github: fakeGitHub({ states, fixture, events }),
      repositoryPublisher: {
        async push() {
          throw new Error('idempotent retry must not push');
        },
        async verify() {
          events.push('verify-refs');
        },
      },
      async runCandidateGate() {
        throw new Error('idempotent retry must not rerun E2E');
      },
      async loadReusableCandidate() {
        events.push('load-sealed-candidate');
        return fixture.candidate;
      },
      materializeCandidate: () => fixture.release,
    });
    expect(events).toEqual([
      'load-sealed-candidate',
      'verify-refs',
      'verify-refs',
      'verify-refs',
      'verify-refs',
    ]);
  });

  it('rejects published inventory without every sha256 digest', async () => {
    const fixture = publicationFixture();
    const canonical = releaseState(
      CANONICAL_RELEASE_REPO,
      'v1.2.3',
      false,
      fixture.release.canonicalAssets,
    );
    delete canonical.snapshot.assets[0].digest;
    await expect(publishManualReleaseTestCore({
      root: '/unused',
      environment: publishEnvironment(),
      version: '1.2.3',
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      stageReleaseAssets: passthroughStage,
      github: fakeGitHub({
        states: new Map([[CANONICAL_RELEASE_REPO, canonical]]),
        fixture,
        events: [],
      }),
      repositoryPublisher: {
        async push() {},
        async verify() {},
      },
      async runCandidateGate() {
        throw new Error('must not rerun gate');
      },
      async loadReusableCandidate() {
        return fixture.candidate;
      },
      materializeCandidate: () => fixture.release,
    })).rejects.toThrow(/do not match/);
  });

  it('fails closed when the public mirror is ahead of canonical', async () => {
    const fixture = publicationFixture();
    let candidateTouched = false;
    await expect(publishManualReleaseTestCore({
      root: '/unused',
      environment: publishEnvironment(),
      version: '1.2.3',
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      stageReleaseAssets: passthroughStage,
      github: fakeGitHub({
        states: new Map([
          [
            PUBLIC_RELEASE_REPO,
            releaseState(
              PUBLIC_RELEASE_REPO,
              'v1.2.3',
              false,
              fixture.release.publicAssets,
            ),
          ],
        ]),
        fixture,
        events: [],
      }),
      repositoryPublisher: {
        async push() {},
        async verify() {},
      },
      async runCandidateGate() {
        candidateTouched = true;
      },
      async loadReusableCandidate() {
        candidateTouched = true;
      },
      materializeCandidate: () => fixture.release,
    })).rejects.toThrow(/before the canonical/);
    expect(candidateTouched).toBe(false);
  });

  it('rejects a mirror timestamp that predates an existing canonical release', async () => {
    const fixture = publicationFixture();
    const canonical = releaseState(
      CANONICAL_RELEASE_REPO,
      'v1.2.3',
      false,
      fixture.release.canonicalAssets,
    );
    canonical.snapshot.publishedAt = '2026-07-23T00:00:02.000Z';
    const mirror = releaseState(
      PUBLIC_RELEASE_REPO,
      'v1.2.3',
      false,
      fixture.release.publicAssets,
    );
    mirror.snapshot.publishedAt = '2026-07-23T00:00:01.000Z';
    await expect(publishManualReleaseTestCore({
      root: '/unused',
      environment: publishEnvironment(),
      version: '1.2.3',
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      stageReleaseAssets: passthroughStage,
      github: fakeGitHub({
        states: new Map([
          [CANONICAL_RELEASE_REPO, canonical],
          [PUBLIC_RELEASE_REPO, mirror],
        ]),
        fixture,
        events: [],
      }),
      repositoryPublisher: {
        async push() {},
        async verify() {},
      },
      async runCandidateGate() {
        throw new Error('timestamp split-brain must fail before the gate');
      },
      async loadReusableCandidate() {
        throw new Error('timestamp split-brain must fail before receipt load');
      },
      materializeCandidate: () => fixture.release,
    })).rejects.toThrow(/timestamp precedes/);
  });

  it('rejects a foreign asset in an already published canonical release', async () => {
    const fixture = publicationFixture();
    const canonical = releaseState(
      CANONICAL_RELEASE_REPO,
      'v1.2.3',
      false,
      [
        ...fixture.release.canonicalAssets,
        { name: 'foreign.bin', size: 1, sha256: 'f'.repeat(64) },
      ],
    );
    await expect(publishManualReleaseTestCore({
      root: '/unused',
      environment: publishEnvironment(),
      version: '1.2.3',
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      stageReleaseAssets: passthroughStage,
      github: fakeGitHub({
        states: new Map([[CANONICAL_RELEASE_REPO, canonical]]),
        fixture,
        events: [],
      }),
      repositoryPublisher: {
        async push() {},
        async verify() {},
      },
      async runCandidateGate() {
        throw new Error('published canonical retry must not run gate');
      },
      async loadReusableCandidate() {
        return fixture.candidate;
      },
      materializeCandidate: () => fixture.release,
    })).rejects.toThrow(/do not match/);
  });
});

const digest = (value) =>
  createHash('sha256').update(value).digest('hex');

function publishEnvironment() {
  return {
    NEXUS_MAC_PUBLISH_RELEASE: '1',
    APPLE_TEAM_ID: '35P5XL3JN6',
    APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
  };
}

function releaseAuthority() {
  return {
    version: '1.2.3',
    tag: 'v1.2.3',
    nodeVersion: '22.23.1',
    npmVersion: '12.0.0',
    allowedTagSignerFingerprints: [],
  };
}

function releaseNodeVersion() {
  return `v${releaseAuthority().nodeVersion}`;
}

function passthroughStage(release) {
  return {
    release,
    cleanup() {},
  };
}

function publicationFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-publish-fixture-'));
  publicationRoots.push(root);
  const canonicalAssetPaths = ['dmg', 'zip', 'security'].map((name) =>
    path.join(root, name));
  fs.writeFileSync(canonicalAssetPaths[0], 'verified dmg');
  fs.writeFileSync(canonicalAssetPaths[1], 'verified zip');
  fs.writeFileSync(canonicalAssetPaths[2], 'verified security');
  const canonicalAssets = describeLocalReleaseAssets(canonicalAssetPaths);
  const publicAssetPaths = canonicalAssetPaths.slice(0, 2);
  const publicAssets = describeLocalReleaseAssets(publicAssetPaths);
  const physicalEvidence = makeValidRealMissionEvidence({
    appVersion: '1.2.3',
    commitSha: 'a'.repeat(40),
    artifactSha256: canonicalAssets[1].sha256,
  });
  const evidencePath = path.join(root, 'physical-evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(physicalEvidence));
  return {
    candidate: {
      receipt: {
        version: '1.2.3',
        tag: 'v1.2.3',
        commitSha: 'a'.repeat(40),
        tagObjectSha: 'e'.repeat(40),
        tagSignerFingerprint: null,
        tagSignatureVerified: false,
        artifacts: {
          zip: {
            name: path.basename(canonicalAssetPaths[1]),
            sha256: canonicalAssets[1].sha256,
          },
          e2eEvidence: {
            name: path.basename(evidencePath),
            sha256: digest(fs.readFileSync(evidencePath)),
          },
        },
        verification: {
          physicalProductWizard: true,
          singleProductMission: true,
        },
      },
      evidencePath,
    },
    release: {
      canonicalAssetPaths,
      publicAssetPaths,
      canonicalAssets,
      publicAssets,
    },
  };
}

function releaseState(repo, tag, isDraft, assets) {
  return {
    kind: isDraft ? 'draft' : 'published',
    repo,
    tag,
    snapshot: {
      tagName: tag,
      isDraft,
      publishedAt: isDraft
        ? null
        : repo === CANONICAL_RELEASE_REPO
          ? '2026-07-23T00:00:00.000Z'
          : '2026-07-23T00:00:01.000Z',
      assets: assets.map((asset) => ({
        name: asset.name,
        size: asset.size,
        state: 'uploaded',
        digest: `sha256:${asset.sha256}`,
      })),
    },
  };
}

function fakeGitHub({ states, fixture, events }) {
  const get = (repo, tag) => {
    const state = states.get(repo);
    return state ?? { kind: 'missing', repo, tag };
  };
  return {
    async inspect(repo, tag) {
      return get(repo, tag);
    },
    async createDraft(repo, tag, { verifyTag }) {
      events.push(`create:${repo}:${verifyTag ? 'verify' : 'no-verify'}`);
      states.set(repo, releaseState(repo, tag, true, []));
    },
    async upload(repo, tag, paths) {
      const assets = repo === CANONICAL_RELEASE_REPO
        ? fixture.release.canonicalAssets
        : fixture.release.publicAssets;
      const labels = paths
        .map((entry) => path.basename(entry))
        .map((entry) => (
          entry === 'security' ? 'security' : entry
        ))
        .sort();
      events.push(`upload:${repo}:${labels.join(',')}`);
      states.set(repo, releaseState(repo, tag, true, assets));
    },
    async publish(repo, tag) {
      events.push(`publish:${repo}`);
      const current = get(repo, tag);
      if (current.kind !== 'draft') {
        throw new Error('test publisher expected a draft');
      }
      states.set(repo, {
        ...current,
        kind: 'published',
        snapshot: {
          ...current.snapshot,
          isDraft: false,
          publishedAt:
            repo === CANONICAL_RELEASE_REPO
              ? '2026-07-23T00:00:00.000Z'
              : '2026-07-23T00:00:01.000Z',
        },
      });
    },
  };
}

function createReusableCandidateFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-reuse-test-'));
  fs.mkdirSync(path.join(root, 'out', 'make', 'darwin', 'arm64'), {
    recursive: true,
  });
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
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3 }),
  );
  const dmgPath = path.join(
    root,
    'out',
    'make',
    'darwin',
    'arm64',
    'NexusIDE-arm64.dmg',
  );
  const zipPath = path.join(
    root,
    'out',
    'make',
    'darwin',
    'arm64',
    'NexusIDE-arm64.zip',
  );
  fs.writeFileSync(dmgPath, 'dmg');
  fs.writeFileSync(zipPath, 'zip');
  createCandidateSecurityFixture(root, {
    dmg: {
      name: path.basename(dmgPath),
      sha256: digest('dmg'),
    },
    zip: {
      name: path.basename(zipPath),
      sha256: digest('zip'),
    },
  });
  return root;
}

function createCandidateSecurityFixture(root, artifactOverrides = {}) {
  const securityDir = path.join(root, 'release-artifacts', 'security');
  fs.mkdirSync(securityDir, { recursive: true });
  if (!fs.existsSync(path.join(root, 'package-lock.json'))) {
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3 }),
    );
  }
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'nexus-ide',
        version: '1.2.3',
        packageManager: 'npm@12.0.0',
        nexusRelease: { node: '22.23.1' },
      }),
    );
  }
  const writeSecurityJson = (name, value) => {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(path.join(securityDir, name), content);
    return {
      name,
      bytes: Buffer.byteLength(content),
      sha256: digest(content),
    };
  };
  const files = [
    writeSecurityJson('audit-production.json', {
      metadata: { vulnerabilities: { total: 0 } },
    }),
    writeSecurityJson('nexus-1.2.3.cdx.json', {
      bomFormat: 'CycloneDX',
      components: [],
    }),
    writeSecurityJson('audit-build-toolchain.json', {
      metadata: { vulnerabilities: { total: 0 } },
    }),
    writeSecurityJson('nexus-1.2.3-toolchain.cdx.json', {
      bomFormat: 'CycloneDX',
      components: [],
    }),
  ];
  const dmgArtifact = artifactOverrides.dmg ?? {
    name: 'NexusIDE.dmg',
    sha256: 'b'.repeat(64),
  };
  const zipArtifact = artifactOverrides.zip ?? {
    name: 'NexusIDE.zip',
    sha256: 'c'.repeat(64),
  };
  const physicalEvidence = makeValidRealMissionEvidence({
    appVersion: '1.2.3',
    commitSha: 'a'.repeat(40),
    artifactSha256: zipArtifact.sha256,
  });
  const evidence = JSON.stringify(physicalEvidence);
  fs.writeFileSync(
    path.join(securityDir, 'real-mission-evidence.json'),
    evidence,
  );
  const claudeEvidence = JSON.stringify({
    ...physicalEvidence,
    panes: (physicalEvidence.panes ?? []).map((pane) =>
      pane?.role === 'orchestrator'
        ? { ...pane, adapterId: 'claude' }
        : pane,
    ),
  });
  fs.writeFileSync(
    path.join(securityDir, 'real-mission-evidence-claude-orchestrator.json'),
    claudeEvidence,
  );
  const receipt = {
    schemaVersion: 4,
    verifiedAt: '2026-07-23T00:00:00.000Z',
    version: '1.2.3',
    tag: 'v1.2.3',
    commitSha: 'a'.repeat(40),
    tagObjectSha: 'e'.repeat(40),
    tagSignerFingerprint: null,
    tagSignatureVerified: false,
    architecture: 'arm64',
    artifacts: {
      dmg: dmgArtifact,
      zip: zipArtifact,
      e2eEvidence: {
        name: 'real-mission-evidence.json',
        sha256: digest(evidence),
      },
      e2eEvidenceClaudeOrchestrator: {
        name: 'real-mission-evidence-claude-orchestrator.json',
        sha256: digest(claudeEvidence),
      },
    },
    verification: {
      signedNotarized: true,
      realMissionE2E: true,
      physicalProductWizard: true,
      physicalClaudeOrchestrator: true,
      singleProductMission: true,
      sameCommitAndArtifacts: true,
      tagSignatureVerified: false,
    },
  };
  const manifest = {
      schemaVersion: 3,
      commitSha: receipt.commitSha,
      tagObjectSha: receipt.tagObjectSha,
      tagSignerFingerprint: null,
      tagSignatureVerified: false,
      package: { name: 'nexus-ide', version: receipt.version },
      packageLockSha256: digest(
        fs.readFileSync(path.join(root, 'package-lock.json')),
      ),
      audit: {
        productionVulnerabilities: 0,
        buildToolchainVulnerabilities: 0,
      },
      generatedAt: '2026-07-23T00:00:00.000Z',
      runtime: { node: 'v22.23.1', npm: '12.0.0' },
      files,
      verification: {
        physicalProductWizard: true,
        physicalClaudeOrchestrator: true,
      },
      releaseArtifacts: {
        signingIdentity:
          'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
        dmg: receipt.artifacts.dmg,
        zip: receipt.artifacts.zip,
        e2eEvidence: {
          ...receipt.artifacts.e2eEvidence,
          bytes: Buffer.byteLength(evidence),
        },
        e2eEvidenceClaudeOrchestrator: {
          ...receipt.artifacts.e2eEvidenceClaudeOrchestrator,
          bytes: Buffer.byteLength(claudeEvidence),
        },
      },
    };
  fs.writeFileSync(
    path.join(securityDir, 'security-manifest.json'),
    JSON.stringify(manifest),
  );
  receipt.securityAssets = fs
    .readdirSync(securityDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => {
      const filePath = path.join(securityDir, entry.name);
      return {
        name: entry.name,
        bytes: fs.statSync(filePath).size,
        sha256: digest(fs.readFileSync(filePath)),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  fs.writeFileSync(
    path.join(securityDir, 'release-candidate-receipt.json'),
    JSON.stringify(receipt),
  );
  return { securityDir, receipt };
}
