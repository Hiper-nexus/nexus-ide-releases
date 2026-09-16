import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import * as releasePublisher from './publish-release.mjs';

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
  loadMacosReleaseCandidate,
  loadReusableReleaseCandidate,
  materializeReusableReleaseCandidate,
  parseReleasePublishMode,
  publishMacosRelease,
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

import { readAndAssertReleaseAuthority } from './release-authority.mjs';

const publicationRoots = [];
afterAll(() => {
  for (const root of publicationRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('macOS-only publication (F-564)', () => {
  it('selects exclusive platform modes and rejects mixed/unknown arguments', () => {
    expect(parseReleasePublishMode([])).toBe('combined');
    expect(parseReleasePublishMode(['--macos'])).toBe('macos');
    expect(parseReleasePublishMode(['--windows'])).toBe('windows');
    for (const args of [['--windows', '--macos'], ['--macos', '--windows']]) {
      expect(() => parseReleasePublishMode(args)).toThrow(/same invocation/);
    }
    expect(() => parseReleasePublishMode(['--macoss'])).toThrow(/usage/);
  });

  it.each(['NEXUS_MAC_PUBLISH_RELEASE', 'APPLE_TEAM_ID', 'APPLE_KEYCHAIN_PROFILE'])(
    'requires %s before any production effect', async (key) => {
      const environment = publishEnvironment();
      delete environment[key];
      await expect(publishMacosRelease({ root: '/unused', environment })).rejects.toThrow(key);
    },
  );

  it('keeps the production macOS entrypoint sealed and independent of a Windows run', async () => {
    expect(() => publishMacosRelease({ github: {} })).toThrow(/dependency override/);
    expect(() => publishMacosRelease(Object.create({ macosOnly: true }))).toThrow(/dependency override/);
    // Authority metadata fails before Git; importantly, no Windows requirement.
    await expect(publishMacosRelease({ root: '/unused', environment: publishEnvironment() }))
      .rejects.toThrow(/release metadata/);
  });

  it('publishes the nine sealed macOS assets canonically and only DMG/ZIP in the mirror', async () => {
    const fixture = macosPublicationFixture();
    const commands = [];
    for (const method of ['createDraft', 'upload', 'publish']) {
      const original = fixture.github[method];
      fixture.github[method] = async (repo, tag, argument) => {
        commands.push(method === 'createDraft'
          ? buildGitHubReleaseDraftArgs({ repo, tag, ...argument })
          : method === 'upload'
            ? buildGitHubReleaseUploadArgs({ repo, tag, assetPaths: argument })
            : buildGitHubReleasePublishArgs({ repo, tag }));
        return original(repo, tag, argument);
      };
    }
    const result = await publishManualReleaseTestCore(fixture.options);
    expect(result.resumedFromLocalGreenCandidate).toBe(true);
    expect(fixture.release.canonicalAssets.map((a) => a.name).sort()).toEqual([
      'NexusIDE-arm64.dmg', 'NexusIDE-arm64.zip', 'audit-build-toolchain.json',
      'audit-production.json', 'nexus-1.2.3-toolchain.cdx.json', 'nexus-1.2.3.cdx.json',
      'packaged-smoke-report.json', 'release-candidate-receipt.json', 'security-manifest.json',
    ].sort());
    expect(fixture.release.publicAssets.map((a) => a.name)).toEqual(['NexusIDE-arm64.dmg', 'NexusIDE-arm64.zip']);
    expect(commands.filter((c) => c[1] === 'create')).toEqual([
      buildGitHubReleaseDraftArgs({ tag: 'v1.2.3', repo: CANONICAL_RELEASE_REPO }),
      buildGitHubReleaseDraftArgs({ tag: 'v1.2.3', repo: PUBLIC_RELEASE_REPO, verifyTag: false }),
    ]);
    const uploads = commands.filter((c) => c[1] === 'upload');
    expect(uploads.map((c) => c.slice(0, 6))).toEqual([
      ['release', 'upload', 'v1.2.3', '--repo', `github.com/${CANONICAL_RELEASE_REPO}`, '--clobber'],
      ['release', 'upload', 'v1.2.3', '--repo', `github.com/${PUBLIC_RELEASE_REPO}`, '--clobber'],
    ]);
    expect(uploads[0].slice(6).map((p) => path.basename(p)).sort()).toEqual(fixture.release.canonicalAssets.map((a) => a.name).sort());
    expect(uploads[1].slice(6).map((p) => path.basename(p))).toEqual(['NexusIDE-arm64.dmg', 'NexusIDE-arm64.zip']);
    expect(commands.filter((c) => c[1] === 'edit')).toEqual([
      buildGitHubReleasePublishArgs({ tag: 'v1.2.3', repo: CANONICAL_RELEASE_REPO }),
      buildGitHubReleasePublishArgs({ tag: 'v1.2.3', repo: PUBLIC_RELEASE_REPO }),
    ]);
    expect(fixture.events.indexOf(`publish:${CANONICAL_RELEASE_REPO}`)).toBeLessThan(fixture.events.indexOf(`publish:${PUBLIC_RELEASE_REPO}`));
  });

  it.each([
    ['gate receipt missing', 'release-artifacts/security/release-candidate-receipt.json', 'remove'],
    ['build receipt missing', 'release-artifacts/candidate-build.json', 'remove'],
    ['smoke missing', 'release-artifacts/security/packaged-smoke-report.json', 'remove'],
    ['ZIP hash differs', 'out/make/darwin/arm64/NexusIDE-arm64.zip', 'tamper'],
    ['audit hash differs', 'release-artifacts/security/audit-production.json', 'tamper'],
    ['build receipt differs', 'release-artifacts/candidate-build.json', 'tamper'],
  ])('refuses %s without rebuilding or uploading', async (_label, relative, action) => {
    const fixture = macosPublicationFixture();
    const file = path.join(fixture.root, relative);
    if (action === 'remove') fs.unlinkSync(file);
    else fs.appendFileSync(file, 'tampered');
    await expect(publishManualReleaseTestCore(fixture.options)).rejects.toThrow();
    expect(fixture.events).toEqual([]);
  });

  it('refuses HEAD different from the tag before upload', async () => {
    const fixture = macosPublicationFixture();
    fixture.repository.headSha = 'f'.repeat(40);
    await expect(publishManualReleaseTestCore(fixture.options)).rejects.toThrow(/HEAD|commit|tag/i);
    expect(fixture.events).toEqual([]);
  });

  it('refuses well-formed build evidence whose artifact hash differs', async () => {
    const fixture = macosPublicationFixture();
    const file = path.join(fixture.root, 'release-artifacts', 'candidate-build.json');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    receipt.artifacts[0].sha256 = 'f'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(receipt));
    await expect(publishManualReleaseTestCore(fixture.options)).rejects.toThrow(/diverges from build receipt/);
    expect(fixture.events).toEqual([]);
  });

  it.each([CANONICAL_RELEASE_REPO, PUBLIC_RELEASE_REPO])('rejects a published sha256 mismatch in %s', async (repo) => {
    const fixture = macosPublicationFixture();
    const original = fixture.github.publish;
    fixture.github.publish = async (...args) => {
      await original(...args);
      if (args[0] === repo) fixture.states.get(repo).snapshot.assets[0].digest = `sha256:${'f'.repeat(64)}`;
    };
    await expect(publishManualReleaseTestCore(fixture.options)).rejects.toThrow(/do not match/i);
    if (repo === CANONICAL_RELEASE_REPO) expect(fixture.events).not.toContain(`publish:${PUBLIC_RELEASE_REPO}`);
  });
});

function macosPublicationFixture() {
  const root = createReusableCandidateFixture();
  publicationRoots.push(root);
  const authority = readAndAssertReleaseAuthority(root);
  const repository = { statusPorcelain: '', headSha: 'a'.repeat(40), tagCommitSha: 'a'.repeat(40),
    tagObjectSha: 'e'.repeat(40), tagObjectType: 'tag', tagSignerFingerprint: null };
  const loaderOptions = { root, authority, repository, environment: publishEnvironment() };
  const candidate = loadReusableReleaseCandidate(loaderOptions);
  fs.writeFileSync(path.join(root, 'release-artifacts', 'candidate-build.json'), JSON.stringify({
    schemaVersion: 2, startedAt: '2026-07-22T00:00:00.000Z', version: authority.version,
    tag: authority.tag, architecture: 'arm64', commitSha: candidate.receipt.commitSha,
    tagObjectSha: candidate.receipt.tagObjectSha, tagSignerFingerprint: null, tagSignatureVerified: false,
    provenance: { mode: 'clean-git-worktree', npmCi: true, sourceCommitSha: candidate.receipt.commitSha,
      packageLockSha256: digest(fs.readFileSync(path.join(root, 'package-lock.json'))),
      nodeVersion: `v${authority.nodeVersion}`, npmVersion: authority.npmVersion, npmPackageIntegrity: authority.npmPackageIntegrity },
    artifacts: Object.values(candidate.artifacts).map((file) => ({ path: path.relative(root, file).replaceAll('\\', '/'),
      bytes: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs, sha256: digest(fs.readFileSync(file)) })),
  }));
  const release = materializeReusableReleaseCandidate(root, candidate);
  const events = [];
  const states = new Map();
  const github = fakeGitHub({ states, fixture: { release }, events });
  return { root, repository, release, events, states, github, options: {
    root, authority, environment: publishEnvironment(), nodeVersion: `v${authority.nodeVersion}`,
    macosOnly: true, github, stageReleaseAssets,
    repositoryPublisher: { async push() { events.push('push'); }, async verify() {} },
    loadReusableCandidate: () => loadMacosReleaseCandidate(loaderOptions),
    materializeCandidate: materializeReusableReleaseCandidate,
    runCandidateGate: () => { throw new Error('must not rebuild macOS candidate'); },
    loadWindowsCandidate: () => { throw new Error('must not load Windows candidate'); },
  } };
}

describe('manual GitHub release publication', () => {
  it('blocks ordinary publication before build or external mutations without a signed worker run', async () => {
    await expect(publishManualRelease({ root: '/unused', environment: publishEnvironment() })).rejects.toThrow(/NEXUS_WINDOWS_RELEASE_RUN_ID/);
  });

  it('stages Windows bytes in both exact drafts and keeps worker evidence private', async () => {
    const fixture = publicationFixture();
    const mac = fixture.release;
    const directory = path.dirname(mac.canonicalAssetPaths[0]);
    const assetPaths = ['NexusIDE-1.2.3-win32-x64-Setup.exe', 'nexus_ide-1.2.3-full.nupkg', 'RELEASES'].map(name => path.join(directory, name));
    const receiptPath = path.join(directory, 'windows-release-receipt.json');
    for (const filename of [...assetPaths, receiptPath]) fs.writeFileSync(filename, `verified ${path.basename(filename)}`);
    fixture.release = {
      canonicalAssetPaths: [...mac.canonicalAssetPaths, ...assetPaths, receiptPath],
      publicAssetPaths: [...mac.publicAssetPaths, ...assetPaths],
    };
    fixture.release.canonicalAssets = describeLocalReleaseAssets(fixture.release.canonicalAssetPaths);
    fixture.release.publicAssets = describeLocalReleaseAssets(fixture.release.publicAssetPaths);
    const windows = { assetPaths, receiptPath, assets: describeLocalReleaseAssets(assetPaths), receiptAsset: describeLocalReleaseAssets([receiptPath])[0] };
    const events = [];
    const github = fakeGitHub({ states: new Map(), fixture, events });
    const options = {
      root: '/unused', environment: publishEnvironment(), authority: releaseAuthority(), nodeVersion: releaseNodeVersion(),
      stageReleaseAssets, github,
      repositoryPublisher: { async push() { events.push('push'); }, async verify() {} },
      runCandidateGate: async () => fixture.candidate,
      loadReusableCandidate: async () => fixture.candidate,
      materializeCandidate: () => mac,
      loadWindowsCandidate: async () => windows,
    };
    await publishManualReleaseTestCore(options);
    const publicUpload = events.find(event => event.startsWith(`upload:${PUBLIC_RELEASE_REPO}:`));
    expect(publicUpload).toContain('RELEASES');
    expect(publicUpload).toContain('nexus_ide-1.2.3-full.nupkg');
    expect(publicUpload).not.toContain('windows-release-receipt.json');
    expect(events.find(event => event.startsWith(`upload:${CANONICAL_RELEASE_REPO}:`))).toContain('windows-release-receipt.json');
    events.length = 0;
    await expect(publishManualReleaseTestCore({ ...options, loadWindowsCandidate: async () => { throw new Error('unsigned worker'); } })).rejects.toThrow(/unsigned worker/);
    expect(events).toEqual([]);
    fs.appendFileSync(assetPaths[0], 'tampered after authenticated extraction');
    await expect(publishManualReleaseTestCore(options)).rejects.toThrow(/bytes changed/);
    expect(events).toEqual([]);
  });

  it.each([CANONICAL_RELEASE_REPO, PUBLIC_RELEASE_REPO])('blocks publication when %s advances while uploads are staged', async (advancedRepo) => {
    const fixture = publicationFixture();
    const events = [];
    const github = fakeGitHub({ states: new Map(), fixture, events });
    let staged = false;
    const upload = github.upload;
    github.upload = async (...args) => { await upload(...args); if (args[0] === PUBLIC_RELEASE_REPO) staged = true; };
    github.listStableReleases = async repo => staged && repo === advancedRepo ? [{ tag_name: 'v1.2.4', draft: false, prerelease: false }] : [];
    await expect(publishManualReleaseTestCore(publicationOptions(fixture, github))).rejects.toThrow(/newer stable/);
    expect(staged).toBe(true);
    expect(events.some(event => event.startsWith('publish:'))).toBe(false);
  });

  it('checks both repositories again before exposing the mirror', async () => {
    const fixture = publicationFixture();
    const events = [];
    const github = fakeGitHub({ states: new Map(), fixture, events });
    let canonicalPublished = false;
    const publish = github.publish;
    github.publish = async (...args) => { await publish(...args); canonicalPublished = true; };
    github.listStableReleases = async repo => canonicalPublished && repo === CANONICAL_RELEASE_REPO ? [{ tag_name: 'v1.2.4' }] : [];
    await expect(publishManualReleaseTestCore(publicationOptions(fixture, github))).rejects.toThrow(/newer stable/);
    expect(events).toContain(`publish:${CANONICAL_RELEASE_REPO}`);
    expect(events).not.toContain(`publish:${PUBLIC_RELEASE_REPO}`);
  });

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

  it('rejects a forged or unbound packaged smoke report at publish time', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-publish-smoke-'));
    publicationRoots.push(root);
    const smokeReportPath = path.join(root, 'packaged-smoke-report.json');
    const goodReport = {
      schemaVersion: 1,
      status: 'pass',
      smoke: 'packaged-app',
      appVersion: '1.2.3',
      commitSha: 'a'.repeat(40),
      artifact: {
        sha256: 'b'.repeat(64),
        identity:
          'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
      },
      finishedAt: '2026-07-23T00:00:00.000Z',
    };

    // Status != pass nunca publica, mesmo com booleans do receipt afirmando ok.
    fs.writeFileSync(
      smokeReportPath,
      JSON.stringify({ ...goodReport, status: 'fail' }),
    );
    expect(() =>
      assertPublishPhysicalCandidate({
        smokeReportPath,
        receipt: {
          version: '1.2.3',
          commitSha: 'a'.repeat(40),
          artifacts: {
            zip: { sha256: 'b'.repeat(64) },
            packagedSmoke: {
              sha256: digest(fs.readFileSync(smokeReportPath)),
            },
          },
          verification: {
            packagedSmoke: true,
          },
        },
      }),
    ).toThrow(/live authority|invalid or not a pass/i);

    // Relatório amarrado a OUTRO ZIP nunca publica.
    fs.writeFileSync(
      smokeReportPath,
      JSON.stringify({
        ...goodReport,
        artifact: { ...goodReport.artifact, sha256: 'f'.repeat(64) },
      }),
    );
    expect(() =>
      assertPublishPhysicalCandidate({
        smokeReportPath,
        receipt: {
          version: '1.2.3',
          commitSha: 'a'.repeat(40),
          artifacts: {
            zip: { sha256: 'b'.repeat(64) },
            packagedSmoke: {
              sha256: digest(fs.readFileSync(smokeReportPath)),
            },
          },
          verification: {
            packagedSmoke: true,
          },
        },
      }),
    ).toThrow(/live authority|does not match/i);
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
        'https://github.com/Hiper-nexus/nexus-ide.git\n',
        'git@github.com:Hiper-nexus/nexus-ide.git\n',
        CANONICAL_RELEASE_REPO,
      ),
    ).toBe(CANONICAL_RELEASE_REPO);
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
        // Windows exposes only its read-only bit through Node's POSIX mode
        // emulation. The publisher runs on macOS, where these private-mode
        // assertions are meaningful; every host still exercises the isolated
        // copy and immutable-hash contract below.
        if (process.platform !== 'win32') {
          expect(
            fs.statSync(path.dirname(staged.release.canonicalAssetPaths[0])).mode &
              0o777,
          ).toBe(0o700);
          expect(
            fs.statSync(staged.release.canonicalAssetPaths[0]).mode & 0o777,
          ).toBe(0o400);
        }
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
      )).toHaveLength(7);
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
      const materialized = materializeReusableReleaseCandidate(root, candidate);
      expect(materialized.publicAssets.map((asset) => asset.name)).toEqual([
        'NexusIDE-arm64.dmg',
        'NexusIDE-arm64.zip',
      ]);
      expect(() =>
        materializeReusableReleaseCandidate(root, {
          ...candidate,
        }),
      ).toThrow(/durable candidate authority/i);
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
      expect(() =>
        materializeReusableReleaseCandidate(root, candidate),
      ).toThrow(/durable candidate bytes changed/i);
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
    expect(result.resumedFromLocalGreenCandidate).toBe(false);
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
    expect(result.resumedFromLocalGreenCandidate).toBe(false);
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

  it('reuses a durable local green candidate without rerunning E2E on first publish', async () => {
    const fixture = publicationFixture();
    const events = [];
    const result = await publishManualReleaseTestCore({
      root: '/unused',
      environment: publishEnvironment(),
      version: '1.2.3',
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      stageReleaseAssets: passthroughStage,
      github: fakeGitHub({
        states: new Map(),
        fixture,
        events,
      }),
      repositoryPublisher: {
        async push({ commitSha, tag, tagObjectSha }) {
          events.push(`push:${commitSha}:${tag}:${tagObjectSha}`);
        },
        async verify() {
          events.push('verify-refs');
        },
      },
      async runCandidateGate() {
        throw new Error('local green reuse must not rerun packaged E2E');
      },
      async loadReusableCandidate() {
        events.push('load-local-green-candidate');
        return fixture.candidate;
      },
      materializeCandidate: () => fixture.release,
    });
    expect(result.resumedFromPublishedCanonical).toBe(false);
    expect(result.resumedFromLocalGreenCandidate).toBe(true);
    expect(events).toEqual([
      'load-local-green-candidate',
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
  });

  it('falls back to the candidate gate when local durable receipt is unavailable', async () => {
    const fixture = publicationFixture();
    const events = [];
    const result = await publishManualReleaseTestCore({
      root: '/unused',
      environment: publishEnvironment(),
      version: '1.2.3',
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      stageReleaseAssets: passthroughStage,
      github: fakeGitHub({
        states: new Map(),
        fixture,
        events,
      }),
      repositoryPublisher: {
        async push() {
          events.push('push');
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
        events.push('load-local-green-miss');
        throw new Error('receipt missing');
      },
      materializeCandidate: () => fixture.release,
    });
    expect(result.resumedFromPublishedCanonical).toBe(false);
    expect(result.resumedFromLocalGreenCandidate).toBe(false);
    expect(events[0]).toBe('load-local-green-miss');
    expect(events[1]).toBe('candidate-gate');
    expect(events).toContain('push');
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

describe('independent Windows GitHub release publication', () => {
  it('publishes a verified Windows candidate without invoking the macOS candidate gate', async () => {
    const fixture = windowsPublicationFixture();
    const independentPublisher = releasePublisher.publishWindowsReleaseTestCore
      ?? (async () => {
        throw new Error('independent Windows publisher is not implemented');
      });

    await expect(independentPublisher({
      root: fixture.root,
      environment: {
        NEXUS_WINDOWS_RELEASE_RUN_ID: '42',
        NEXUS_WINDOWS_UPGRADE_PROOF_WAIVER: fixture.waiver.reason,
      },
      authority: releaseAuthority(),
      nodeVersion: releaseNodeVersion(),
      repositoryState: {
        commitSha: 'a'.repeat(40),
        tag: 'v1.2.3',
        tagObjectSha: 'e'.repeat(40),
      },
      github: fixture.github,
      repositoryPublisher: {
        async push() {
          throw new Error('the signed release tag already exists and must not be recreated');
        },
        async verify() {
          fixture.events.push('verify-tag');
        },
      },
      stageReleaseAssets: passthroughStage,
      loadWindowsCandidate: async () => fixture.candidate,
      runCandidateGate: async () => {
        throw new Error('macOS candidate gate must not run for Windows publication');
      },
    })).resolves.toMatchObject({
      tag: 'v1.2.3',
      canonicalRepo: CANONICAL_RELEASE_REPO,
      publicRepo: PUBLIC_RELEASE_REPO,
    });

    const canonicalUpload = fixture.events.find((event) =>
      event.startsWith(`upload:${CANONICAL_RELEASE_REPO}:`),
    );
    const publicUpload = fixture.events.find((event) =>
      event.startsWith(`upload:${PUBLIC_RELEASE_REPO}:`),
    );
    expect(canonicalUpload).toContain('windows-release-receipt.json');
    expect(canonicalUpload).toContain('windows-upgrade-proof-waiver.json');
    expect(publicUpload).toContain('NexusIDE-1.2.3-win32-x64-Setup.exe');
    expect(publicUpload).toContain('nexus_ide-1.2.3-full.nupkg');
    expect(publicUpload).toContain('RELEASES');
    expect(publicUpload).not.toContain('windows-release-receipt.json');
    expect(publicUpload).not.toContain('windows-upgrade-proof-waiver.json');
    expect(fixture.events.indexOf(`publish:${CANONICAL_RELEASE_REPO}`))
      .toBeLessThan(fixture.events.indexOf(`publish:${PUBLIC_RELEASE_REPO}`));
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

function publicationOptions(fixture, github) {
  return {
    root: '/unused', environment: publishEnvironment(), authority: releaseAuthority(), nodeVersion: releaseNodeVersion(),
    stageReleaseAssets: passthroughStage, github,
    repositoryPublisher: { async push() {}, async verify() {} },
    runCandidateGate: async () => fixture.candidate,
    loadReusableCandidate: async () => fixture.candidate,
    materializeCandidate: () => fixture.release,
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
  const smokeReport = JSON.stringify({
    schemaVersion: 1,
    status: 'pass',
    smoke: 'packaged-app',
    appVersion: '1.2.3',
    commitSha: 'a'.repeat(40),
    artifact: {
      sha256: canonicalAssets[1].sha256,
      identity:
        'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
    },
    finishedAt: '2026-07-23T00:00:00.000Z',
  });
  const smokeReportPath = path.join(root, 'packaged-smoke-report.json');
  fs.writeFileSync(smokeReportPath, smokeReport);
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
          packagedSmoke: {
            name: path.basename(smokeReportPath),
            sha256: digest(smokeReport),
          },
        },
        verification: {
          packagedSmoke: true,
        },
      },
      smokeReportPath,
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
    async listStableReleases() { return []; },
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

function windowsPublicationFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-windows-publish-fixture-'));
  publicationRoots.push(root);
  const assetNames = [
    'NexusIDE-1.2.3-win32-x64-Setup.exe',
    'nexus_ide-1.2.3-full.nupkg',
    'RELEASES',
  ];
  for (const name of assetNames) {
    fs.writeFileSync(path.join(root, name), `verified ${name}`);
  }
  const assetPaths = assetNames.map((name) => path.join(root, name));
  const assets = describeLocalReleaseAssets(assetPaths);
  const receiptPath = path.join(root, 'windows-release-receipt.json');
  fs.writeFileSync(receiptPath, 'verified receipt');
  const waiverPath = path.join(root, 'windows-upgrade-proof-waiver.json');
  fs.writeFileSync(waiverPath, 'verified waiver');
  const receiptAsset = describeLocalReleaseAssets([receiptPath])[0];
  const waiverAsset = describeLocalReleaseAssets([waiverPath])[0];
  const events = [];
  const states = new Map();
  const get = (repo, tag) => states.get(`${repo}:${tag}`) ?? {
    kind: 'missing',
    repo,
    tag,
  };
  const put = (repo, tag, state) => states.set(`${repo}:${tag}`, state);
  const github = {
    async listStableReleases() {
      return [{
        tag_name: 'v1.2.4',
        draft: false,
        prerelease: false,
        assets: ['NexusIDE-1.2.4-arm64.dmg'],
      }];
    },
    async inspect(repo, tag) {
      return get(repo, tag);
    },
    async createDraft(repo, tag, { verifyTag }) {
      events.push(`create:${repo}:${verifyTag ? 'verify' : 'no-verify'}`);
      put(repo, tag, releaseState(repo, tag, true, []));
    },
    async upload(repo, tag, paths) {
      const uploaded = describeLocalReleaseAssets(paths);
      events.push(`upload:${repo}:${uploaded.map((asset) => asset.name).sort().join(',')}`);
      put(repo, tag, releaseState(repo, tag, true, uploaded));
    },
    async publish(repo, tag) {
      events.push(`publish:${repo}`);
      const state = get(repo, tag);
      if (state.kind !== 'draft') throw new Error('test publisher expected a draft');
      put(repo, tag, {
        ...state,
        kind: 'published',
        snapshot: {
          ...state.snapshot,
          isDraft: false,
          publishedAt: repo === CANONICAL_RELEASE_REPO
            ? '2026-07-23T00:00:00.000Z'
            : '2026-07-23T00:00:01.000Z',
        },
      });
    },
  };
  const waiver = {
    reason: 'upgrade Windows 1.2.2 para 1.2.3 autorizado pelo proprietário em 2026-09-16',
  };
  return {
    root,
    events,
    github,
    waiver,
    candidate: {
      assetPaths,
      assets,
      receiptPath,
      receiptAsset,
      waiverPath,
      waiverAsset,
      dispose() {},
    },
  };
}

function createReusableCandidateFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-reuse-test-'));
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
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
    path.join(root, 'server', 'package.json'),
    JSON.stringify({ name: '@nexus/server', version: '1.2.3' }),
  );
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      version: '1.2.3',
      lockfileVersion: 3,
      packages: {
        '': { version: '1.2.3' },
        server: { version: '1.2.3' },
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'src', 'shared', 'release-notes.ts'),
    "export const CURRENT_RELEASE = { version: '1.2.3' };\n",
  );
  fs.writeFileSync(
    path.join(root, 'CHANGELOG.md'),
    '# Changelog\n\n## 1.2.3 — Test release\n',
  );
  fs.writeFileSync(
    path.join(root, 'build', 'release-tag-signers.json'),
    JSON.stringify({ schemaVersion: 1, fingerprints: [] }),
  );
  fs.writeFileSync(
    path.join(root, 'build', 'release-npm-integrity.json'),
    JSON.stringify({
      schemaVersion: 1,
      packages: {
        '12.0.0':
          'sha512-qzvPQfNSY7louiM6rv7dL0hi5esBGLn1lLwxbdyL5XOIssWzoYMwn8xqvWhYcZL6onTkenYSxrtKxsFrFbUFyw==',
      },
    }),
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
  const smokeReport = JSON.stringify({
    schemaVersion: 1,
    status: 'pass',
    smoke: 'packaged-app',
    appVersion: '1.2.3',
    commitSha: 'a'.repeat(40),
    artifact: {
      sha256: zipArtifact.sha256,
      identity:
        'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
    },
    finishedAt: '2026-07-23T00:00:00.000Z',
  });
  fs.writeFileSync(
    path.join(securityDir, 'packaged-smoke-report.json'),
    smokeReport,
  );
  const receipt = {
    schemaVersion: 5,
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
      packagedSmoke: {
        name: 'packaged-smoke-report.json',
        sha256: digest(smokeReport),
      },
    },
    verification: {
      signedNotarized: true,
      packagedSmoke: true,
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
        packagedSmoke: true,
      },
      releaseArtifacts: {
        signingIdentity:
          'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
        dmg: receipt.artifacts.dmg,
        zip: receipt.artifacts.zip,
        packagedSmoke: {
          ...receipt.artifacts.packagedSmoke,
          bytes: Buffer.byteLength(smokeReport),
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
