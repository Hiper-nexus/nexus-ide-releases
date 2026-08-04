import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertAuthoritativeReleaseCandidate,
  runReleaseCandidateGate,
} from './release-candidate-gate.mjs';
import { assertRealMissionReleaseEvidence } from './e2e-real-mission.mjs';
import {
  assertReleaseRepositoryState,
  collectReleaseRepositoryState,
  readAndAssertReleaseAuthority,
} from './release-authority.mjs';
import { assertReleaseSecurityManifest } from './release-security-gate.mjs';

export const CANONICAL_RELEASE_REPO = 'cleofasvolarehost/nexus-ide';
export const PUBLIC_RELEASE_REPO = 'cleofasvolarehost/nexus-ide-releases';
const MANUAL_RELEASE_PRODUCTION_AUTHORITY = Symbol(
  'manual-release-production-authority',
);
const REUSABLE_RELEASE_CANDIDATES = new WeakMap();

export function githubRepositoryTarget(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo ?? '')) {
    throw new Error('GitHub release repository identity is invalid');
  }
  return `github.com/${repo}`;
}

export function buildGitHubReleaseDraftArgs({
  tag,
  repo,
  verifyTag = true,
}) {
  return [
    'release',
    'create',
    tag,
    '--repo',
    githubRepositoryTarget(repo),
    ...(verifyTag ? ['--verify-tag'] : []),
    '--draft',
    '--title',
    `NexusIDE ${tag}`,
    '--generate-notes',
  ];
}

export function buildGitHubReleaseUploadArgs({ tag, repo, assetPaths }) {
  return [
    'release',
    'upload',
    tag,
    '--repo',
    githubRepositoryTarget(repo),
    '--clobber',
    ...[...assetPaths].sort(),
  ];
}

export function buildGitHubReleasePublishArgs({ tag, repo }) {
  return [
    'release',
    'edit',
    tag,
    '--repo',
    githubRepositoryTarget(repo),
    '--draft=false',
  ];
}

export function buildGitHubReleaseViewArgs({ tag, repo }) {
  return [
    'release',
    'view',
    tag,
    '--repo',
    githubRepositoryTarget(repo),
    '--json',
    'tagName,isDraft,publishedAt,assets',
  ];
}

function run(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status ?? 1}`);
  }
}

function runCapture(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status ?? 1}`);
  }
  return result.stdout;
}

function tryRunCapture(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

function fileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function describeLocalReleaseAssets(assetPaths) {
  const seen = new Set();
  return [...assetPaths].sort().map((filePath) => {
    const name = path.basename(filePath);
    if (seen.has(name)) {
      throw new Error(`duplicate GitHub release asset name: ${name}`);
    }
    seen.add(name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`release asset is not a regular file: ${name}`);
    }
    return {
      name,
      size: stat.size,
      sha256: fileSha256(filePath),
    };
  });
}

function sameAssetInventory(left, right) {
  const normalize = (items) =>
    [...items].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function assertStagedReleaseAssets(release) {
  const canonical = describeLocalReleaseAssets(release.canonicalAssetPaths);
  const publicAssets = describeLocalReleaseAssets(release.publicAssetPaths);
  if (
    !sameAssetInventory(canonical, release.canonicalAssets) ||
    !sameAssetInventory(publicAssets, release.publicAssets)
  ) {
    throw new Error('staged release asset bytes changed after verification');
  }
  return release;
}

export function stageReleaseAssets(release) {
  const stagingRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-release-publish-'),
  );
  fs.chmodSync(stagingRoot, 0o700);
  try {
    const stagedByName = new Map();
    for (const source of release.canonicalAssetPaths) {
      const sourceStat = fs.lstatSync(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`release staging source is unsafe: ${source}`);
      }
      const name = path.basename(source);
      const destination = path.join(stagingRoot, name);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o400);
      stagedByName.set(name, destination);
    }
    const staged = {
      canonicalAssetPaths: release.canonicalAssetPaths.map((source) =>
        stagedByName.get(path.basename(source))),
      publicAssetPaths: release.publicAssetPaths.map((source) =>
        stagedByName.get(path.basename(source))),
      canonicalAssets: release.canonicalAssets,
      publicAssets: release.publicAssets,
    };
    if (
      staged.canonicalAssetPaths.some((value) => !value) ||
      staged.publicAssetPaths.some((value) => !value)
    ) {
      throw new Error('public release asset is absent from canonical staging');
    }
    assertStagedReleaseAssets(staged);
    return {
      release: staged,
      cleanup() {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * GitHub remains a draft until every locally verified asset is present.
 * Drafts always require exact name/size and verify sha256 when exposed by gh.
 * Published snapshots require GitHub's sha256 digest for every asset.
 */
export function verifyGitHubReleaseSnapshot(
  raw,
  { tag, expectedDraft, expectedAssets },
) {
  let release;
  try {
    release = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('GitHub release snapshot is not valid JSON');
  }
  if (
    !release ||
    release.tagName !== tag ||
    release.isDraft !== expectedDraft ||
    !Array.isArray(release.assets)
  ) {
    throw new Error('GitHub release identity or draft state is incoherent');
  }
  const remote = [...release.assets]
    .map((asset) => ({
      name: asset?.name,
      size: asset?.size,
      state: asset?.state,
      digest: asset?.digest,
    }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const expected = [...expectedAssets]
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    remote.length !== expected.length ||
    remote.some((asset, index) => {
      const wanted = expected[index];
      return (
        asset.name !== wanted.name ||
        asset.size !== wanted.size ||
        (expectedDraft === false
          ? asset.state !== 'uploaded'
          : asset.state !== undefined && asset.state !== 'uploaded') ||
        asset.digest !== `sha256:${wanted.sha256}`
      );
    })
  ) {
    throw new Error('GitHub release assets do not match the verified candidate');
  }
  return release;
}

/** Existing drafts are resumable, but only if every remote basename belongs
 * to the exact candidate. Allowed assets are replaced from verified local
 * bytes with --clobber before the final exact inventory check. */
export function verifyResumableGitHubDraft(
  raw,
  { tag, expectedAssets },
) {
  let release;
  try {
    release = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('existing GitHub draft snapshot is not valid JSON');
  }
  if (
    !release ||
    release.tagName !== tag ||
    release.isDraft !== true ||
    !Array.isArray(release.assets)
  ) {
    throw new Error('existing GitHub release is not the expected draft');
  }
  const allowed = new Set(expectedAssets.map((asset) => asset.name));
  const seen = new Set();
  for (const asset of release.assets) {
    if (
      typeof asset?.name !== 'string' ||
      !allowed.has(asset.name) ||
      seen.has(asset.name) ||
      (asset.state !== undefined && asset.state !== 'uploaded')
    ) {
      throw new Error('existing GitHub draft contains an unexpected asset');
    }
    seen.add(asset.name);
  }
  return release;
}

export function verifyRemoteMain(raw, expectedCommitSha) {
  const matches = String(raw)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1] === 'refs/heads/main');
  if (
    matches.length !== 1 ||
    matches[0][0] !== expectedCommitSha
  ) {
    throw new Error('origin/main does not match the verified release commit');
  }
  return expectedCommitSha;
}

export function verifyRemoteTag(
  raw,
  { tag, expectedCommitSha, expectedTagObjectSha },
) {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  const matches = String(raw)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1] === directRef || parts[1] === peeledRef);
  const direct = matches.filter((parts) => parts[1] === directRef);
  const peeled = matches.filter((parts) => parts[1] === peeledRef);
  if (
    direct.length !== 1 ||
    peeled.length !== 1 ||
    direct[0][0] !== expectedTagObjectSha ||
    peeled[0][0] !== expectedCommitSha
  ) {
    throw new Error('origin release tag does not match the verified release commit');
  }
  return expectedCommitSha;
}

export function verifyCanonicalOrigin(
  fetchUrlsRaw,
  pushUrlsRaw,
  expectedRepo = CANONICAL_RELEASE_REPO,
) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expectedRepo ?? '')) {
    throw new Error('canonical origin repository identity is invalid');
  }
  const allowed = new Set([
    `https://github.com/${expectedRepo}`,
    `https://github.com/${expectedRepo}.git`,
    `git@github.com:${expectedRepo}`,
    `git@github.com:${expectedRepo}.git`,
    `ssh://git@github.com/${expectedRepo}`,
    `ssh://git@github.com/${expectedRepo}.git`,
  ]);
  const parseOne = (raw, kind) => {
    const urls = String(raw)
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (urls.length !== 1 || !allowed.has(urls[0])) {
      throw new Error(
        `canonical origin mismatch: ${kind} URL is not ${expectedRepo}`,
      );
    }
    return urls[0];
  };
  parseOne(fetchUrlsRaw, 'fetch');
  parseOne(pushUrlsRaw, 'push');
  return expectedRepo;
}

export function buildAtomicReleasePushArgs({
  commitSha,
  tag,
  tagObjectSha,
}) {
  if (
    !/^[a-f0-9]{40}$/u.test(commitSha ?? '') ||
    !/^[a-f0-9]{40}$/u.test(tagObjectSha ?? '') ||
    !/^v\d+\.\d+\.\d+$/u.test(tag ?? '')
  ) {
    throw new Error('atomic release push requires exact commit/tag object IDs');
  }
  return [
    'push',
    '--atomic',
    'origin',
    `${commitSha}:refs/heads/main`,
    `${tagObjectSha}:refs/tags/${tag}`,
  ];
}

function hasExactClaudeOrchestratorSkip(skippedOrchestrators) {
  return (
    Array.isArray(skippedOrchestrators) &&
    skippedOrchestrators.length === 1 &&
    skippedOrchestrators[0] === 'claude'
  );
}

export function resolveSecurityAssets(securityDir, receipt) {
  const manifestPath = path.join(securityDir, 'security-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const receiptSkips = receipt?.verification?.skippedOrchestrators;
  const manifestSkips = manifest?.verification?.skippedOrchestrators;
  const isClaudeSkipped = hasExactClaudeOrchestratorSkip(receiptSkips);
  if (
    manifest?.schemaVersion !== 3 ||
    manifest?.commitSha !== receipt.commitSha ||
    manifest?.package?.version !== receipt.version ||
    manifest?.releaseArtifacts?.dmg?.name !== receipt.artifacts.dmg.name ||
    manifest?.releaseArtifacts?.dmg?.sha256 !== receipt.artifacts.dmg.sha256 ||
    manifest?.releaseArtifacts?.zip?.name !== receipt.artifacts.zip.name ||
    manifest?.releaseArtifacts?.zip?.sha256 !== receipt.artifacts.zip.sha256 ||
    manifest?.releaseArtifacts?.e2eEvidence?.name !==
      receipt.artifacts.e2eEvidence.name ||
    manifest?.releaseArtifacts?.e2eEvidence?.sha256 !==
      receipt.artifacts.e2eEvidence.sha256 ||
    manifest?.releaseArtifacts?.e2eEvidenceClaudeOrchestrator?.name !==
      receipt.artifacts.e2eEvidenceClaudeOrchestrator?.name ||
    manifest?.releaseArtifacts?.e2eEvidenceClaudeOrchestrator?.sha256 !==
      receipt.artifacts.e2eEvidenceClaudeOrchestrator?.sha256 ||
    (receiptSkips !== undefined && !isClaudeSkipped) ||
    JSON.stringify(receiptSkips) !== JSON.stringify(manifestSkips) ||
    (isClaudeSkipped &&
      (receipt?.verification?.claudeOrchestratorE2E !== undefined ||
        receipt?.verification?.physicalClaudeOrchestrator !== undefined ||
        manifest?.verification?.physicalClaudeOrchestrator !== undefined ||
        receipt?.artifacts?.e2eEvidenceClaudeOrchestrator !== undefined ||
        manifest?.releaseArtifacts?.e2eEvidenceClaudeOrchestrator !==
          undefined)) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('security manifest and candidate receipt are not coherent');
  }
  assertReleaseSecurityManifest({
    root: path.resolve(securityDir, '..', '..'),
    securityDir,
    manifest,
    commitSha: receipt.commitSha,
    version: receipt.version,
    tagObjectSha: receipt.tagObjectSha,
    tagSignerFingerprint: receipt.tagSignerFingerprint,
    tagSignatureVerified: receipt.tagSignatureVerified,
  });
  const manifestNames = manifest.files.map((entry) => entry?.name);
  if (
    new Set(manifestNames).size !== manifestNames.length ||
    manifest.files.some(
      (entry) =>
        !entry ||
        typeof entry.name !== 'string' ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? ''),
    )
  ) {
    throw new Error('security manifest file inventory is incoherent');
  }
  const claudeEvidenceName =
    receipt.artifacts.e2eEvidenceClaudeOrchestrator?.name;
  if (!isClaudeSkipped && (
    typeof claudeEvidenceName !== 'string' ||
      path.basename(claudeEvidenceName) !== claudeEvidenceName ||
      claudeEvidenceName === receipt.artifacts.e2eEvidence.name
  )) {
    throw new Error(
      'candidate receipt is missing the sealed Claude orchestrator evidence asset',
    );
  }
  const expectedSealedNames = [
    ...manifestNames,
    'security-manifest.json',
    receipt.artifacts.e2eEvidence.name,
    ...(!isClaudeSkipped ? [claudeEvidenceName] : []),
  ];
  if (new Set(expectedSealedNames).size !== expectedSealedNames.length) {
    throw new Error('security manifest contains duplicate reserved assets');
  }
  const allowedSealed = [...expectedSealedNames].sort();
  if (
    allowedSealed.some(
      (name) =>
        typeof name !== 'string' ||
        path.basename(name) !== name ||
        name === '.' ||
        name === '..',
    )
  ) {
    throw new Error('security manifest contains an unsafe asset path');
  }
  const sealed = Array.isArray(receipt.securityAssets)
    ? [...receipt.securityAssets].sort((left, right) =>
        String(left?.name).localeCompare(String(right?.name)))
    : [];
  if (
    sealed.length !== allowedSealed.length ||
    sealed.some(
      (entry, index) =>
        !entry ||
        entry.name !== allowedSealed[index] ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? ''),
    ) ||
    new Set(sealed.map((entry) => entry.name)).size !== sealed.length
  ) {
    throw new Error('candidate receipt security asset seal is incomplete');
  }
  const sealedEvidence = sealed.find(
    (entry) => entry.name === receipt.artifacts.e2eEvidence.name,
  );
  if (
    sealedEvidence?.sha256 !== receipt.artifacts.e2eEvidence.sha256
  ) {
    throw new Error('candidate receipt E2E evidence seal is incoherent');
  }
  if (!isClaudeSkipped) {
    const sealedClaudeEvidence = sealed.find(
      (entry) => entry.name === claudeEvidenceName,
    );
    if (
      sealedClaudeEvidence?.sha256 !==
      receipt.artifacts.e2eEvidenceClaudeOrchestrator.sha256
    ) {
      throw new Error(
        'candidate receipt Claude orchestrator E2E evidence seal is incoherent',
      );
    }
  }
  const actual = fs
    .readdirSync(securityDir, { withFileTypes: true });
  const unsafeEntry = actual.find(
    (entry) => !entry.isFile() || entry.isSymbolicLink(),
  );
  if (unsafeEntry) {
    throw new Error(`security asset directory contains unsafe entry: ${unsafeEntry.name}`);
  }
  const actualNames = actual.map((entry) => entry.name).sort();
  const allowed = [...allowedSealed, 'release-candidate-receipt.json'].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(allowed)) {
    throw new Error('security asset directory contains undeclared files');
  }
  const onDiskReceipt = JSON.parse(
    fs.readFileSync(
      path.join(securityDir, 'release-candidate-receipt.json'),
      'utf8',
    ),
  );
  if (JSON.stringify(onDiskReceipt) !== JSON.stringify(receipt)) {
    throw new Error('candidate receipt changed before publication');
  }
  for (const entry of sealed) {
    const filePath = path.join(securityDir, entry.name);
    if (
      fileSha256(filePath) !== entry.sha256 ||
      fs.statSync(filePath).size !== entry.bytes
    ) {
      throw new Error(`sealed security asset digest mismatch: ${entry.name}`);
    }
  }
  for (const entry of manifest.files) {
    const filePath = path.join(securityDir, entry.name);
    if (
      fileSha256(filePath) !== entry.sha256 ||
      fs.statSync(filePath).size !== entry.bytes
    ) {
      throw new Error(`security asset digest mismatch: ${entry.name}`);
    }
  }
  const evidencePath = path.join(
    securityDir,
    receipt.artifacts.e2eEvidence.name,
  );
  if (
    fileSha256(evidencePath) !== receipt.artifacts.e2eEvidence.sha256
  ) {
    throw new Error('E2E evidence digest mismatch before publication');
  }
  let physicalEvidence;
  try {
    physicalEvidence = assertRealMissionReleaseEvidence(
      JSON.parse(fs.readFileSync(evidencePath, 'utf8')),
    );
  } catch (error) {
    throw new Error(
      `published candidate lacks valid physical product-wizard evidence: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    receipt?.verification?.physicalProductWizard !== true ||
    receipt?.verification?.singleProductMission !==
      physicalEvidence.missionInventory?.exactSingleProductMission ||
    physicalEvidence.missionInventory?.exactSingleProductMission !== true ||
    physicalEvidence.release?.commitSha !== receipt.commitSha ||
    physicalEvidence.release?.appVersion !== receipt.version ||
    physicalEvidence.release?.artifact?.sha256 !==
      receipt.artifacts.zip.sha256 ||
    physicalEvidence.release?.artifact?.identity !==
      manifest?.releaseArtifacts?.signingIdentity
  ) {
    throw new Error(
      'physical product-wizard evidence and candidate receipt are not coherent',
    );
  }
  return allowed.map((name) => path.join(securityDir, name));
}

export function assertManualPublishEnvironment(environment) {
  if (environment.NEXUS_MAC_PUBLISH_RELEASE !== '1') {
    throw new Error('NEXUS_MAC_PUBLISH_RELEASE must be exactly "1"');
  }
  if (environment.APPLE_TEAM_ID !== '35P5XL3JN6') {
    throw new Error('APPLE_TEAM_ID must be exactly 35P5XL3JN6');
  }
  if (environment.APPLE_KEYCHAIN_PROFILE !== 'nexus-notary') {
    throw new Error(
      'APPLE_KEYCHAIN_PROFILE must be exactly "nexus-notary"',
    );
  }
  if (environment.APPLE_ID || environment.APPLE_APP_SPECIFIC_PASSWORD) {
    throw new Error(
      'Apple secrets must not be exported; use the keychain profile',
    );
  }
}

function readReleaseVersion(root) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  if (!/^\d+\.\d+\.\d+$/u.test(packageJson?.version ?? '')) {
    throw new Error('release package version must be exact semver');
  }
  return packageJson.version;
}

function findReleaseArtifact(root, name) {
  if (
    typeof name !== 'string' ||
    path.basename(name) !== name ||
    name === '.' ||
    name === '..'
  ) {
    throw new Error('candidate receipt contains an unsafe artifact name');
  }
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile() && entry.name === name) {
        matches.push(candidate);
      }
    }
  };
  if (!fs.existsSync(root)) {
    throw new Error('release artifact directory does not exist');
  }
  visit(root);
  if (matches.length !== 1) {
    throw new Error(
      `verified release artifact ${name} must exist exactly once`,
    );
  }
  return matches[0];
}

function assertCandidateReceiptShape(
  receipt,
  {
    version,
    commitSha,
    tagObjectSha,
    tagSignerFingerprint,
    tagSignatureVerified,
  },
) {
  const skippedOrchestrators =
    receipt?.verification?.skippedOrchestrators;
  const isClaudeSkipped = hasExactClaudeOrchestratorSkip(
    skippedOrchestrators,
  );
  const artifactNames = [
    receipt?.artifacts?.dmg?.name,
    receipt?.artifacts?.zip?.name,
    receipt?.artifacts?.e2eEvidence?.name,
  ];
  if (
    receipt?.schemaVersion !== 4 ||
    receipt?.version !== version ||
    receipt?.tag !== `v${version}` ||
    receipt?.commitSha !== commitSha ||
    (tagObjectSha !== undefined &&
      receipt?.tagObjectSha !== tagObjectSha) ||
    (tagSignerFingerprint !== undefined &&
      receipt?.tagSignerFingerprint !== tagSignerFingerprint) ||
    (tagSignatureVerified !== undefined &&
      receipt?.tagSignatureVerified !== tagSignatureVerified) ||
    !/^[a-f0-9]{40}$/u.test(receipt?.tagObjectSha ?? '') ||
    typeof receipt?.tagSignatureVerified !== 'boolean' ||
    (receipt.tagSignatureVerified
      ? typeof receipt?.tagSignerFingerprint !== 'string' ||
        receipt.tagSignerFingerprint.length < 12
      : receipt?.tagSignerFingerprint !== null) ||
    !/^[a-f0-9]{40}$/u.test(receipt?.commitSha ?? '') ||
    artifactNames.some(
      (name) =>
        typeof name !== 'string' ||
        path.basename(name) !== name ||
        name === '.' ||
        name === '..',
    ) ||
    new Set(artifactNames).size !== artifactNames.length ||
    !Number.isFinite(Date.parse(receipt?.verifiedAt ?? '')) ||
    receipt?.verification?.signedNotarized !== true ||
    receipt?.verification?.realMissionE2E !== true ||
    receipt?.verification?.physicalProductWizard !== true ||
    receipt?.verification?.singleProductMission !== true ||
    receipt?.verification?.sameCommitAndArtifacts !== true ||
    receipt?.verification?.tagSignatureVerified !==
      receipt?.tagSignatureVerified ||
    (skippedOrchestrators !== undefined && !isClaudeSkipped) ||
    (isClaudeSkipped &&
      (receipt?.verification?.claudeOrchestratorE2E !== undefined ||
        receipt?.verification?.physicalClaudeOrchestrator !== undefined ||
        receipt?.artifacts?.e2eEvidenceClaudeOrchestrator !== undefined)) ||
    (!isClaudeSkipped &&
      (typeof receipt?.artifacts?.e2eEvidenceClaudeOrchestrator?.name !==
        'string' ||
        path.basename(
          receipt.artifacts.e2eEvidenceClaudeOrchestrator.name,
        ) !== receipt.artifacts.e2eEvidenceClaudeOrchestrator.name ||
        !/^[a-f0-9]{64}$/u.test(
          receipt?.artifacts?.e2eEvidenceClaudeOrchestrator?.sha256 ?? '',
        ))) ||
    !/^[a-f0-9]{64}$/u.test(receipt?.artifacts?.dmg?.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/u.test(receipt?.artifacts?.zip?.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/u.test(
      receipt?.artifacts?.e2eEvidence?.sha256 ?? '',
    ) ||
    !Array.isArray(receipt?.securityAssets) ||
    receipt.securityAssets.length < 3 ||
    new Set(receipt.securityAssets.map((entry) => entry?.name)).size !==
      receipt.securityAssets.length ||
    receipt.securityAssets.some(
      (entry) =>
        !entry ||
        typeof entry.name !== 'string' ||
        path.basename(entry.name) !== entry.name ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? ''),
    )
  ) {
    throw new Error(
      'reusable release candidate receipt is incomplete or incoherent',
    );
  }
}

function assertPublishPhysicalCandidateCore(
  candidate,
  requireLiveAuthority,
) {
  if (requireLiveAuthority) {
    assertAuthoritativeReleaseCandidate(candidate);
  }
  const receipt = candidate?.receipt;
  const evidencePath = candidate?.evidencePath;
  if (
    receipt?.verification?.physicalProductWizard !== true ||
    typeof evidencePath !== 'string'
  ) {
    throw new Error(
      'release publication requires an authoritative physical product-wizard receipt',
    );
  }
  const stat = fs.lstatSync(evidencePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('physical product-wizard evidence is not a regular file');
  }
  if (
    fileSha256(evidencePath) !== receipt?.artifacts?.e2eEvidence?.sha256
  ) {
    throw new Error('physical product-wizard evidence digest is stale');
  }
  let evidence;
  try {
    evidence = assertRealMissionReleaseEvidence(
      JSON.parse(fs.readFileSync(evidencePath, 'utf8')),
    );
  } catch (error) {
    throw new Error(
      `release publication rejected physical product-wizard evidence: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    receipt?.verification?.singleProductMission !==
      evidence.missionInventory?.exactSingleProductMission ||
    evidence.missionInventory?.exactSingleProductMission !== true ||
    evidence.release?.commitSha !== receipt.commitSha ||
    evidence.release?.appVersion !== receipt.version ||
    evidence.release?.artifact?.sha256 !== receipt.artifacts.zip.sha256
  ) {
    throw new Error(
      'physical product-wizard evidence does not match release candidate',
    );
  }
  return evidence;
}

export function assertPublishPhysicalCandidate(candidate) {
  return assertPublishPhysicalCandidateCore(candidate, true);
}

/**
 * Load a durable local release candidate receipt and re-bind it to the current
 * HEAD/tag, DMG/ZIP digests, security assets and E2E evidence files.
 *
 * Used in two cases:
 * 1. Canonical release already published — resume mirror without re-running E2E
 * 2. Fresh / draft publication — reuse a green local candidate so publish does
 *    not re-run the expensive packaged real-mission gate
 *
 * Neither path is trust-on-first-use: every declared byte is re-hashed first.
 */
export function loadReusableReleaseCandidate(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const environment = options.environment ?? process.env;
  assertManualPublishEnvironment(environment);
  const authority =
    options.authority ?? readAndAssertReleaseAuthority(root);
  const version = authority.version;
  const repository =
    options.repository ??
    collectReleaseRepositoryState({
      version,
      allowedTagSignerFingerprints:
        authority.allowedTagSignerFingerprints,
      gitCapture: (args) => ({
        stdout: runCapture('git', args, root),
        stderr: '',
      }),
    });
  const state = assertReleaseRepositoryState({
    ...repository,
    version,
    allowedTagSignerFingerprints:
      authority.allowedTagSignerFingerprints,
    allowedUntrackedPrefixes: ['out', 'release-artifacts'],
  });
  const securityDir = path.join(root, 'release-artifacts', 'security');
  const receiptPath = path.join(
    securityDir,
    'release-candidate-receipt.json',
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assertCandidateReceiptShape(receipt, {
    version,
    commitSha: state.commitSha,
    tagObjectSha: state.tagObjectSha,
    tagSignerFingerprint: state.tagSignerFingerprint,
    tagSignatureVerified: state.tagSignatureVerified,
  });
  const artifactsRoot = path.join(root, 'out', 'make');
  const artifacts = {
    dmg: findReleaseArtifact(artifactsRoot, receipt.artifacts.dmg.name),
    zip: findReleaseArtifact(artifactsRoot, receipt.artifacts.zip.name),
  };
  if (
    fileSha256(artifacts.dmg) !== receipt.artifacts.dmg.sha256 ||
    fileSha256(artifacts.zip) !== receipt.artifacts.zip.sha256
  ) {
    throw new Error('reusable release artifact digest does not match receipt');
  }
  resolveSecurityAssets(securityDir, receipt);
  const candidate = {
    receipt,
    receiptPath,
    artifacts,
    evidencePath: path.join(
      securityDir,
      receipt.artifacts.e2eEvidence.name,
    ),
  };
  REUSABLE_RELEASE_CANDIDATES.set(candidate, Object.freeze({
    root,
    receiptSha256: createHash('sha256')
      .update(JSON.stringify(receipt))
      .digest('hex'),
    receiptPath,
    evidencePath: candidate.evidencePath,
    artifacts: Object.freeze({
      dmg: Object.freeze({
        path: artifacts.dmg,
        sha256: receipt.artifacts.dmg.sha256,
      }),
      zip: Object.freeze({
        path: artifacts.zip,
        sha256: receipt.artifacts.zip.sha256,
      }),
    }),
  }));
  return candidate;
}

function assertReusableReleaseCandidate(root, candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('reusable release requires durable candidate authority');
  }
  const seal = REUSABLE_RELEASE_CANDIDATES.get(candidate);
  const resolvedRoot = path.resolve(root);
  if (
    !seal ||
    seal.root !== resolvedRoot ||
    seal.receiptPath !== candidate.receiptPath ||
    seal.evidencePath !== candidate.evidencePath ||
    seal.artifacts.dmg.path !== candidate.artifacts?.dmg ||
    seal.artifacts.zip.path !== candidate.artifacts?.zip ||
    seal.receiptSha256 !== createHash('sha256')
      .update(JSON.stringify(candidate.receipt))
      .digest('hex')
  ) {
    throw new Error('reusable release requires durable candidate authority');
  }
  for (const [kind, expected] of Object.entries(seal.artifacts)) {
    const stat = fs.lstatSync(expected.path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fileSha256(expected.path) !== expected.sha256 ||
      candidate.receipt?.artifacts?.[kind]?.sha256 !== expected.sha256
    ) {
      throw new Error('reusable durable candidate bytes changed');
    }
  }
  const securityDir = path.join(resolvedRoot, 'release-artifacts', 'security');
  resolveSecurityAssets(securityDir, candidate.receipt);
  return candidate;
}

function materializeCandidateAssets(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const securityDir = path.join(
    resolvedRoot,
    'release-artifacts',
    'security',
  );
  const authority = readAndAssertReleaseAuthority(root);
  assertCandidateReceiptShape(candidate?.receipt, {
    version: authority.version,
    commitSha: candidate?.receipt?.commitSha,
  });
  const securityAssets = resolveSecurityAssets(
    securityDir,
    candidate.receipt,
  );
  if (
    fileSha256(candidate.artifacts.dmg) !==
      candidate.receipt.artifacts.dmg.sha256 ||
    fileSha256(candidate.artifacts.zip) !==
      candidate.receipt.artifacts.zip.sha256 ||
    path.basename(candidate.artifacts.dmg) !==
      candidate.receipt.artifacts.dmg.name ||
    path.basename(candidate.artifacts.zip) !==
      candidate.receipt.artifacts.zip.name
  ) {
    throw new Error('release artifact changed before publication');
  }
  const canonicalAssetPaths = [
    candidate.artifacts.dmg,
    candidate.artifacts.zip,
    ...securityAssets,
  ];
  const publicAssetPaths = [
    candidate.artifacts.dmg,
    candidate.artifacts.zip,
  ];
  return {
    canonicalAssetPaths,
    publicAssetPaths,
    canonicalAssets: describeLocalReleaseAssets(canonicalAssetPaths),
    publicAssets: describeLocalReleaseAssets(publicAssetPaths),
  };
}

export function materializeReleaseCandidate(root, candidate) {
  assertAuthoritativeReleaseCandidate(candidate);
  return materializeCandidateAssets(root, candidate);
}

export function materializeReusableReleaseCandidate(root, candidate) {
  assertReusableReleaseCandidate(root, candidate);
  return materializeCandidateAssets(root, candidate);
}

export function classifyGitHubReleaseResult(result, { repo, tag }) {
  if (!result.ok) {
    if (
      result.status === 1 &&
      /(?:release not found|HTTP 404|404 Not Found)/iu.test(
        `${result.stderr}\n${result.stdout}`,
      )
    ) {
      return { kind: 'missing', repo, tag };
    }
    throw new Error(
      `cannot inspect GitHub release ${repo}@${tag}: ` +
        `gh exited ${result.status}`,
    );
  }
  let snapshot;
  try {
    snapshot = JSON.parse(result.stdout);
  } catch {
    throw new Error(`GitHub release ${repo}@${tag} returned invalid JSON`);
  }
  if (
    snapshot?.tagName !== tag ||
    typeof snapshot?.isDraft !== 'boolean' ||
    !Array.isArray(snapshot?.assets) ||
    (snapshot.isDraft === false &&
      !Number.isFinite(Date.parse(snapshot.publishedAt ?? '')))
  ) {
    throw new Error(`GitHub release ${repo}@${tag} has incoherent identity`);
  }
  return {
    kind: snapshot.isDraft ? 'draft' : 'published',
    repo,
    tag,
    snapshot,
  };
}

function createGitHubClient(root) {
  return {
    inspect(repo, tag) {
      return classifyGitHubReleaseResult(
        tryRunCapture(
          'gh',
          buildGitHubReleaseViewArgs({ tag, repo }),
          root,
        ),
        { repo, tag },
      );
    },
    createDraft(repo, tag, { verifyTag }) {
      run(
        'gh',
        buildGitHubReleaseDraftArgs({ tag, repo, verifyTag }),
        root,
      );
    },
    upload(repo, tag, assetPaths) {
      run(
        'gh',
        buildGitHubReleaseUploadArgs({ tag, repo, assetPaths }),
        root,
      );
    },
    publish(repo, tag) {
      run('gh', buildGitHubReleasePublishArgs({ tag, repo }), root);
    },
  };
}

function createRepositoryPublisher(root, canonicalRepo) {
  const verifyOrigin = () =>
    verifyCanonicalOrigin(
      runCapture(
        'git',
        ['remote', 'get-url', '--all', 'origin'],
        root,
      ),
      runCapture(
        'git',
        ['remote', 'get-url', '--push', '--all', 'origin'],
        root,
      ),
      canonicalRepo,
    );
  return {
    push({ commitSha, tag, tagObjectSha }) {
      verifyOrigin();
      run('git', buildAtomicReleasePushArgs({
        commitSha,
        tag,
        tagObjectSha,
      }), root);
    },
    verify({ commitSha, tag, tagObjectSha }) {
      verifyOrigin();
      verifyRemoteMain(
        runCapture(
          'git',
          ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'],
          root,
        ),
        commitSha,
      );
      verifyRemoteTag(
        runCapture(
          'git',
          [
            'ls-remote',
            '--exit-code',
            'origin',
            `refs/tags/${tag}`,
            `refs/tags/${tag}^{}`,
          ],
          root,
        ),
        {
          tag,
          expectedCommitSha: commitSha,
          expectedTagObjectSha: tagObjectSha,
        },
      );
    },
  };
}

function verifyPublished(state, { tag, expectedAssets }) {
  if (state.kind !== 'published') {
    throw new Error(`GitHub release ${state.repo}@${tag} is not published`);
  }
  verifyGitHubReleaseSnapshot(state.snapshot, {
    tag,
    expectedDraft: false,
    expectedAssets,
  });
}

function assertCanonicalPublicationOrder(canonical, mirror) {
  if (mirror.kind !== 'published') return;
  if (canonical.kind !== 'published') {
    throw new Error(
      'public mirror is published before the canonical release; refusing split-brain publication',
    );
  }
  const canonicalPublishedAt = Date.parse(
    canonical.snapshot?.publishedAt ?? '',
  );
  const mirrorPublishedAt = Date.parse(mirror.snapshot?.publishedAt ?? '');
  if (
    !Number.isFinite(canonicalPublishedAt) ||
    !Number.isFinite(mirrorPublishedAt) ||
    mirrorPublishedAt < canonicalPublishedAt
  ) {
    throw new Error(
      'public mirror publication timestamp precedes the canonical release',
    );
  }
}

async function prepareDraft({
  github,
  state,
  repo,
  tag,
  assetPaths,
  expectedAssets,
  verifyTag,
  assertLocalAssets,
}) {
  if (state.kind === 'published') return state;
  if (state.kind === 'draft') {
    verifyResumableGitHubDraft(state.snapshot, { tag, expectedAssets });
  } else {
    await github.createDraft(repo, tag, { verifyTag });
    state = await github.inspect(repo, tag);
    if (state.kind !== 'draft') {
      throw new Error(
        `GitHub did not create the expected draft in ${repo}`,
      );
    }
    verifyResumableGitHubDraft(state.snapshot, { tag, expectedAssets });
  }
  assertLocalAssets();
  await github.upload(repo, tag, assetPaths);
  const uploaded = await github.inspect(repo, tag);
  if (uploaded.kind !== 'draft') {
    throw new Error(
      `GitHub draft in ${repo} changed state before verification`,
    );
  }
  verifyGitHubReleaseSnapshot(uploaded.snapshot, {
    tag,
    expectedDraft: true,
    expectedAssets,
  });
  return uploaded;
}

/**
 * Manual, two-repository publication. No Actions are invoked. Both drafts
 * must contain an exact candidate snapshot before the canonical release is
 * made public. Only after the canonical published receipt is re-read does the
 * asset-only public mirror transition from draft to published.
 */
async function publishManualReleaseCore(
  options = {},
  productionAuthority = null,
) {
  const authoritative =
    productionAuthority === MANUAL_RELEASE_PRODUCTION_AUTHORITY;
  const root = path.resolve(options.root ?? process.cwd());
  const environment = options.environment ?? process.env;
  assertManualPublishEnvironment(environment);
  const authority = authoritative
    ? readAndAssertReleaseAuthority(root)
    : options.authority;
  if (!authority) {
    throw new Error(
      'manual release test core requires explicit release authority',
    );
  }
  const version = authority.version;
  const nodeVersion = authoritative
    ? process.version
    : (options.nodeVersion ?? process.version);
  if (nodeVersion !== `v${authority.nodeVersion}`) {
    throw new Error(
      `release publication requires Node ${authority.nodeVersion}; ` +
        `found ${nodeVersion}`,
    );
  }
  if (options.version !== undefined && options.version !== version) {
    throw new Error('explicit release version diverges from metadata authority');
  }
  const tag = `v${version}`;
  const canonicalRepo = authoritative
    ? CANONICAL_RELEASE_REPO
    : (options.canonicalRepo ?? CANONICAL_RELEASE_REPO);
  const publicRepo = authoritative
    ? PUBLIC_RELEASE_REPO
    : (options.publicRepo ?? PUBLIC_RELEASE_REPO);
  const github = authoritative ? createGitHubClient(root) : options.github;
  const gate = authoritative
    ? runReleaseCandidateGate
    : options.runCandidateGate;
  const reusableLoader = authoritative
    ? loadReusableReleaseCandidate
    : options.loadReusableCandidate;
  const materializeFresh = authoritative
    ? materializeReleaseCandidate
    : options.materializeCandidate;
  const materializeReusable = authoritative
    ? materializeReusableReleaseCandidate
    : options.materializeCandidate;
  const repositoryPublisher = authoritative
    ? createRepositoryPublisher(root, canonicalRepo)
    : options.repositoryPublisher;
  const stage = authoritative
    ? stageReleaseAssets
    : options.stageReleaseAssets;
  if (
    !github ||
    typeof gate !== 'function' ||
    typeof reusableLoader !== 'function' ||
    typeof materializeFresh !== 'function' ||
    typeof materializeReusable !== 'function' ||
    !repositoryPublisher ||
    typeof stage !== 'function'
  ) {
    throw new Error(
      'manual release test core requires explicit non-production dependencies',
    );
  }

  let canonical = await github.inspect(canonicalRepo, tag);
  let mirror = await github.inspect(publicRepo, tag);
  assertCanonicalPublicationOrder(canonical, mirror);

  const reusePublishedCandidate = canonical.kind === 'published';
  let reuseLocalGreenCandidate = false;
  let candidate;
  if (reusePublishedCandidate) {
    candidate = await reusableLoader({ root, environment });
  } else {
    // Prefer a durable green local receipt bound to HEAD + packages over a
    // second packaged real-mission run. Fall back to the full gate when the
    // receipt is missing, stale, or fails revalidation.
    try {
      candidate = await reusableLoader({ root, environment });
      reuseLocalGreenCandidate = true;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[release-publish] durable local candidate unavailable ` +
          `(${reason}); running full candidate gate\n`,
      );
      candidate = await gate({ root, environment });
    }
  }
  const reuseDurableCandidate =
    reusePublishedCandidate || reuseLocalGreenCandidate;
  if (
    candidate?.receipt?.version !== version ||
    candidate?.receipt?.tag !== tag
  ) {
    throw new Error('release candidate does not match the requested version');
  }
  if (authoritative && !reuseDurableCandidate) {
    assertPublishPhysicalCandidate(candidate);
  } else if (authoritative) {
    assertReusableReleaseCandidate(root, candidate);
    assertPublishPhysicalCandidateCore(candidate, false);
  } else {
    assertPublishPhysicalCandidateCore(candidate, false);
  }
  const materialized = await (
    reuseDurableCandidate
      ? materializeReusable
      : materializeFresh
  )(root, candidate);
  const stagedCandidate = await stage(materialized);
  const release = stagedCandidate.release;
  try {
  if (reusePublishedCandidate) {
    verifyPublished(canonical, {
      tag,
      expectedAssets: release.canonicalAssets,
    });
  }

  // Local green reuse still needs the annotated tag on the remotes; only a
  // published canonical already implies refs were pushed.
  if (!reusePublishedCandidate) {
    await repositoryPublisher.push({
      commitSha: candidate.receipt.commitSha,
      tag,
      tagObjectSha: candidate.receipt.tagObjectSha,
    });
  }
  const verifiedRefBinding = {
    commitSha: candidate.receipt.commitSha,
    tag,
    tagObjectSha: candidate.receipt.tagObjectSha,
  };
  await repositoryPublisher.verify(verifiedRefBinding);

  // Re-read after the ref transition: another publisher must never be able to
  // move the public mirror ahead of the canonical source of truth.
  canonical = await github.inspect(canonicalRepo, tag);
  mirror = await github.inspect(publicRepo, tag);
  assertCanonicalPublicationOrder(canonical, mirror);
  if (canonical.kind === 'published') {
    verifyPublished(canonical, {
      tag,
      expectedAssets: release.canonicalAssets,
    });
  }
  if (mirror.kind === 'published') {
    if (canonical.kind !== 'published') {
      throw new Error('public mirror has no published canonical release');
    }
    verifyPublished(mirror, {
      tag,
      expectedAssets: release.publicAssets,
    });
  }

  // On a fresh publication, both repositories reach an exact draft snapshot
  // before either becomes public. On a post-canonical retry only the remaining
  // public draft is prepared; the canonical published digest is already exact.
  canonical = await prepareDraft({
    github,
    state: canonical,
    repo: canonicalRepo,
    tag,
    assetPaths: release.canonicalAssetPaths,
    expectedAssets: release.canonicalAssets,
    verifyTag: true,
    assertLocalAssets: () => assertStagedReleaseAssets(release),
  });
  mirror = await prepareDraft({
    github,
    state: mirror,
    repo: publicRepo,
    tag,
    assetPaths: release.publicAssetPaths,
    expectedAssets: release.publicAssets,
    verifyTag: false,
    assertLocalAssets: () => assertStagedReleaseAssets(release),
  });

  await repositoryPublisher.verify(verifiedRefBinding);
  if (canonical.kind !== 'published') {
    canonical = await github.inspect(canonicalRepo, tag);
    if (canonical.kind !== 'draft') {
      throw new Error('canonical draft changed state before publication');
    }
    verifyGitHubReleaseSnapshot(canonical.snapshot, {
      tag,
      expectedDraft: true,
      expectedAssets: release.canonicalAssets,
    });
    assertStagedReleaseAssets(release);
    await github.publish(canonicalRepo, tag);
    canonical = await github.inspect(canonicalRepo, tag);
    verifyPublished(canonical, {
      tag,
      expectedAssets: release.canonicalAssets,
    });
  } else {
    verifyPublished(canonical, {
      tag,
      expectedAssets: release.canonicalAssets,
    });
  }

  // Canonical is checked once more immediately before exposing the mirror.
  canonical = await github.inspect(canonicalRepo, tag);
  await repositoryPublisher.verify(verifiedRefBinding);
  verifyPublished(canonical, {
    tag,
    expectedAssets: release.canonicalAssets,
  });
  mirror = await github.inspect(publicRepo, tag);
  if (mirror.kind === 'draft') {
    verifyGitHubReleaseSnapshot(mirror.snapshot, {
      tag,
      expectedDraft: true,
      expectedAssets: release.publicAssets,
    });
    assertStagedReleaseAssets(release);
    await github.publish(publicRepo, tag);
    mirror = await github.inspect(publicRepo, tag);
  }
  verifyPublished(mirror, {
    tag,
    expectedAssets: release.publicAssets,
  });
  await repositoryPublisher.verify(verifiedRefBinding);
  assertCanonicalPublicationOrder(canonical, mirror);
  return {
    tag,
    commitSha: candidate.receipt.commitSha,
    canonicalRepo,
    publicRepo,
    resumedFromPublishedCanonical: reusePublishedCandidate,
    resumedFromLocalGreenCandidate: reuseLocalGreenCandidate,
  };
  } finally {
    stagedCandidate.cleanup();
  }
}

/**
 * Sealed production entrypoint. Callers may select only root/environment; all
 * build, GitHub, repository and staging authorities are module-owned.
 */
export function publishManualRelease(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new Error(
      'sealed manual release rejects dependency override: prototype',
    );
  }
  const allowed = new Set(['root', 'environment']);
  const prototype = Object.getPrototypeOf(options);
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  const unexpected = keys.find(
    (key) =>
      typeof key !== 'string' ||
      !allowed.has(key) ||
      descriptors[key]?.get !== undefined ||
      descriptors[key]?.set !== undefined,
  );
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    unexpected !== undefined
  ) {
    throw new Error(
      `sealed manual release rejects dependency override: ${String(unexpected ?? 'prototype')}`,
    );
  }
  return publishManualReleaseCore(
    {
      ...(descriptors.root ? { root: descriptors.root.value } : {}),
      ...(descriptors.environment
        ? { environment: descriptors.environment.value }
        : {}),
    },
    MANUAL_RELEASE_PRODUCTION_AUTHORITY,
  );
}

/**
 * Dependency-injected controller for unit tests. It has no fallback to any
 * production GitHub, git, candidate-gate, materialization or staging effect.
 */
export function publishManualReleaseTestCore(options = {}) {
  return publishManualReleaseCore(options, null);
}

async function main() {
  const result = await publishManualRelease();
  process.stdout.write(
    `[release-publish] PASS ${result.tag} ${result.commitSha} ` +
      `(${result.canonicalRepo} -> ${result.publicRepo})\n`,
  );
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(
      `[release-publish] FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
