import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendWindowsAssets,
  assertWindowsCandidate,
  assertWindowsRun,
  fileHash,
  parseUpgradeProofWaiver,
  requireWindowsRunId,
} from './windows-release-candidate.mjs';

export const CANONICAL_REPO = 'Hiper-nexus/nexus-ide';
export const MIRROR_REPO = 'Hiper-nexus/nexus-ide-releases';
export const RECEIPT_ARTIFACT = 'windows-x64-signed-receipt';
export const RECEIPT = 'windows-release-receipt.json';
export const PENDING = 'windows-pending.json';
export const WAIVER = 'windows-upgrade-proof-waiver.json';

const API_TIMEOUT_MS = 10 * 60_000;
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const SHA1 = /^[a-f\d]{40}$/u;
const SHA256 = /^[a-f\d]{64}$/u;
const STABLE = /^\d+\.\d+\.\d+$/u;

const fail = (message) => {
  throw new Error(message);
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function githubRepositoryTarget(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo ?? '')) {
    fail('GitHub repository identity is invalid');
  }
  return `github.com/${repo}`;
}

export function windowsAssetNames(version) {
  return [
    `NexusIDE-${version}-win32-x64-Setup.exe`,
    `nexus_ide-${version}-full.nupkg`,
    'RELEASES',
  ];
}

export function markerAsset(version, commitSha) {
  const bytes = Buffer.from(
    `${JSON.stringify({ kind: 'windows-pending', version, commitSha })}\n`,
  );
  return { name: PENDING, size: bytes.length, sha256: sha256(bytes) };
}

export function compareReceiptBytes(localBytes, artifactBytes) {
  const localSha256 = sha256(localBytes);
  const artifactSha256 = sha256(artifactBytes);
  return {
    equal: Buffer.compare(Buffer.from(localBytes), Buffer.from(artifactBytes)) === 0,
    localSha256,
    artifactSha256,
  };
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

export function buildGitHubReleaseDeletePendingArgs({ tag, repo }) {
  return [
    'release',
    'delete-asset',
    tag,
    PENDING,
    '--repo',
    githubRepositoryTarget(repo),
    '--yes',
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

function assetsByName(release) {
  const byName = new Map();
  for (const asset of release.assets) {
    if (typeof asset?.name !== 'string' || byName.has(asset.name)) {
      fail('GitHub release asset inventory contains an invalid or duplicate name');
    }
    byName.set(asset.name, asset);
  }
  return byName;
}

function assertPublishedSnapshot(release, tag, label) {
  if (
    !release ||
    release.tagName !== tag ||
    release.isDraft !== false ||
    typeof release.publishedAt !== 'string' ||
    release.publishedAt.length < 1 ||
    !Array.isArray(release.assets)
  ) {
    fail(`${label} release ${tag} must already be public`);
  }
}

function assetMatches(asset, expected) {
  return (
    asset?.name === expected.name &&
    asset?.size === expected.size &&
    asset?.state === 'uploaded' &&
    asset?.digest === `sha256:${expected.sha256}`
  );
}

function assertAssetMatches(asset, expected) {
  if (!assetMatches(asset, expected)) {
    fail(`GitHub release asset mismatch: ${expected.name}`);
  }
}

function unexpectedManagedAssets(byName, allowed, version) {
  const managed = new Set([...windowsAssetNames(version), RECEIPT, WAIVER, PENDING]);
  return [...byName.keys()].filter((name) => managed.has(name) && !allowed.has(name));
}

function hasEveryExpected(byName, expectedAssets) {
  return expectedAssets.every((asset) => assetMatches(byName.get(asset.name), asset));
}

function hasAnyExpected(byName, expectedAssets) {
  return expectedAssets.some((asset) => byName.has(asset.name));
}

export function classifyWindowsReleaseSnapshots({
  canonical,
  mirror,
  tag,
  version,
  commitSha,
  canonicalAssets,
  mirrorAssets,
}) {
  assertPublishedSnapshot(canonical, tag, 'canonical');
  assertPublishedSnapshot(mirror, tag, 'mirror');
  const canonicalByName = assetsByName(canonical);
  const mirrorByName = assetsByName(mirror);
  const pending = markerAsset(version, commitSha);
  const canonicalAllowedFinal = new Set(canonicalAssets.map((asset) => asset.name));
  const mirrorAllowedFinal = new Set(mirrorAssets.map((asset) => asset.name));
  const canonicalUnexpected = unexpectedManagedAssets(
    canonicalByName,
    canonicalAllowedFinal,
    version,
  ).filter((name) => name !== PENDING);
  const mirrorUnexpected = unexpectedManagedAssets(mirrorByName, mirrorAllowedFinal, version);
  if (canonicalUnexpected.length > 0 || mirrorUnexpected.length > 0) {
    fail('GitHub release already contains unexpected Windows assets');
  }
  const hasPending = canonicalByName.has(PENDING);
  const pendingMatches = assetMatches(canonicalByName.get(PENDING), pending);
  const canonicalFinal = hasEveryExpected(canonicalByName, canonicalAssets);
  const mirrorFinal = hasEveryExpected(mirrorByName, mirrorAssets);
  if (!hasPending && canonicalFinal && mirrorFinal) {
    return { kind: 'already-attached' };
  }
  const canonicalHasAnyFinal = hasAnyExpected(canonicalByName, canonicalAssets);
  const mirrorHasAnyFinal = hasAnyExpected(mirrorByName, mirrorAssets);
  if (hasPending && pendingMatches && !canonicalHasAnyFinal && !mirrorHasAnyFinal) {
    return { kind: 'pending' };
  }
  fail('GitHub release Windows attachment state is partial, stale or unsafe');
}

export function assertFinalWindowsReleaseSnapshots(options) {
  const state = classifyWindowsReleaseSnapshots(options);
  if (state.kind !== 'already-attached') {
    fail('GitHub release Windows assets were not fully attached');
  }
  for (const asset of options.canonicalAssets) {
    assertAssetMatches(assetsByName(options.canonical).get(asset.name), asset);
  }
  for (const asset of options.mirrorAssets) {
    assertAssetMatches(assetsByName(options.mirror).get(asset.name), asset);
  }
  return state;
}

function run(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} failed with exit ${result.status ?? 1}`);
}

function runCapture(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} failed with exit ${result.status ?? 1}`);
  return result.stdout;
}

function ghApiJson(args, root) {
  const result = spawnSync('gh', ['api', '--hostname', 'github.com', ...args], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: API_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail('authenticated GitHub lookup failed; verify gh auth, run ID and repository access');
  }
  return JSON.parse(result.stdout);
}

function ghApiDownload(args, outputFile, root) {
  const fd = fs.openSync(outputFile, 'wx', 0o600);
  try {
    const result = spawnSync('gh', ['api', '--hostname', 'github.com', ...args], {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ['ignore', fd, 'pipe'],
      timeout: ARTIFACT_DOWNLOAD_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) {
      fail('authenticated GitHub receipt artifact download failed');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readVersion(root) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = packageJson.version;
  if (!STABLE.test(version ?? '')) fail('package.json version must be a stable release');
  return version;
}

function resolveTagCommitSha(root, tag) {
  let object = ghApiJson([`repos/${CANONICAL_REPO}/git/ref/tags/${tag}`], root).object;
  for (let depth = 0; depth < 5; depth += 1) {
    if (object?.type === 'commit' && SHA1.test(object.sha ?? '')) return object.sha;
    if (object?.type !== 'tag' || !SHA1.test(object.sha ?? '')) break;
    object = ghApiJson([`repos/${CANONICAL_REPO}/git/tags/${object.sha}`], root).object;
  }
  fail(`release tag ${tag} does not dereference to a commit`);
}

function loadReceiptArtifact(root, runId, run) {
  const pages = ghApiJson(
    ['--paginate', '--slurp', `repos/${CANONICAL_REPO}/actions/runs/${runId}/artifacts?per_page=100`],
    root,
  );
  const artifacts = pages.flatMap((page) => page.artifacts ?? []);
  const matches = artifacts.filter((artifact) => artifact.name === RECEIPT_ARTIFACT);
  if (matches.length !== 1) fail('signed worker receipt artifact missing or ambiguous');
  const artifact = matches[0];
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    artifact.expired !== false ||
    !/^sha256:[a-f\d]{64}$/u.test(artifact.digest ?? '')
  ) {
    fail('receipt artifact metadata lacks a usable immutable digest');
  }
  if (
    artifact.workflow_run &&
    (artifact.workflow_run.id !== run.id ||
      artifact.workflow_run.head_sha !== run.head_sha ||
      artifact.workflow_run.repository_id !== run.repository.id ||
      artifact.workflow_run.head_repository_id !== run.repository.id)
  ) {
    fail('receipt artifact is not bound to the verified worker run');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-windows-receipt-'));
  try {
    const zip = path.join(directory, 'receipt.zip');
    ghApiDownload([`repos/${CANONICAL_REPO}/actions/artifacts/${artifact.id}/zip`], zip, root);
    if (artifact.digest !== `sha256:${fileHash(zip)}`) {
      fail('receipt artifact archive digest does not match GitHub metadata');
    }
    return {
      bytes: extractReceiptFromZip(zip, directory),
      cleanup() {
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function extractReceiptFromZip(zip, directory) {
  if (process.platform !== 'win32') {
    const command = process.platform === 'darwin' ? '/usr/bin/unzip' : 'unzip';
    const result = spawnSync(command, ['-p', zip, RECEIPT], {
      encoding: null,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0 || result.stdout.length < 1) {
      fail('cannot extract receipt from signed worker artifact');
    }
    return result.stdout;
  }
  const destination = path.join(directory, 'expanded');
  fs.mkdirSync(destination, { mode: 0o700 });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Expand-Archive -LiteralPath $env:NEXUS_RECEIPT_ZIP -DestinationPath $env:NEXUS_RECEIPT_DIR -Force",
  ].join('; ');
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    env: { ...process.env, NEXUS_RECEIPT_ZIP: zip, NEXUS_RECEIPT_DIR: destination },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) fail('cannot extract receipt artifact on Windows');
  const receiptPath = path.join(destination, RECEIPT);
  if (!fs.lstatSync(receiptPath).isFile()) fail('receipt artifact does not contain the expected file');
  return fs.readFileSync(receiptPath);
}

function inspectRelease(root, repo, tag) {
  return JSON.parse(runCapture('gh', buildGitHubReleaseViewArgs({ tag, repo }), root));
}

function assertLocalReceiptEqualsArtifact(candidateDir, artifactReceiptBytes) {
  const localPath = path.join(candidateDir, RECEIPT);
  const stat = fs.lstatSync(localPath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('local Windows receipt is unsafe');
  const comparison = compareReceiptBytes(fs.readFileSync(localPath), artifactReceiptBytes);
  if (!comparison.equal) {
    fail(
      `local Windows receipt does not match worker receipt artifact ` +
        `(${comparison.localSha256} != ${comparison.artifactSha256})`,
    );
  }
}

async function publishWindowsRelease({ root = process.cwd(), environment = process.env } = {}) {
  const version = readVersion(root);
  const tag = `v${version}`;
  const runId = requireWindowsRunId(environment);
  const candidateDir = path.resolve(
    root,
    environment.NEXUS_WINDOWS_CANDIDATE_DIR || 'windows-release-assets',
  );
  const upgradeProofWaiver = parseUpgradeProofWaiver(environment);
  const commitSha = resolveTagCommitSha(root, tag);
  const runRecord = ghApiJson([`repos/${CANONICAL_REPO}/actions/runs/${runId}`], root);
  const workflow = ghApiJson([`repos/${CANONICAL_REPO}/actions/workflows/windows-release.yml`], root);
  const branch = ghApiJson([`repos/${CANONICAL_REPO}/branches/main`], root);
  assertWindowsRun({ run: runRecord, workflow, branch, commitSha, runId });
  const receiptArtifact = loadReceiptArtifact(root, runId, runRecord);
  try {
    assertLocalReceiptEqualsArtifact(candidateDir, receiptArtifact.bytes);
  } finally {
    receiptArtifact.cleanup();
  }
  const candidate = assertWindowsCandidate(
    candidateDir,
    { version, commitSha, runId },
    { upgradeProofWaiver },
  );
  const materialized = appendWindowsAssets(
    {
      canonicalAssetPaths: [],
      publicAssetPaths: [],
      canonicalAssets: [],
      publicAssets: [],
    },
    candidate,
  );
  let canonical = inspectRelease(root, CANONICAL_REPO, tag);
  let mirror = inspectRelease(root, MIRROR_REPO, tag);
  const state = classifyWindowsReleaseSnapshots({
    canonical,
    mirror,
    tag,
    version,
    commitSha,
    canonicalAssets: materialized.canonicalAssets,
    mirrorAssets: materialized.publicAssets,
  });
  if (state.kind === 'already-attached') {
    process.stdout.write(
      `[release-publish-windows] PASS ${tag} ${commitSha} run=${runId} já anexado\n`,
    );
    return;
  }
  run('gh', buildGitHubReleaseUploadArgs({
    tag,
    repo: CANONICAL_REPO,
    assetPaths: materialized.canonicalAssetPaths,
  }), root);
  run('gh', buildGitHubReleaseUploadArgs({
    tag,
    repo: MIRROR_REPO,
    assetPaths: materialized.publicAssetPaths,
  }), root);
  run('gh', buildGitHubReleaseDeletePendingArgs({ tag, repo: CANONICAL_REPO }), root);
  canonical = inspectRelease(root, CANONICAL_REPO, tag);
  mirror = inspectRelease(root, MIRROR_REPO, tag);
  assertFinalWindowsReleaseSnapshots({
    canonical,
    mirror,
    tag,
    version,
    commitSha,
    canonicalAssets: materialized.canonicalAssets,
    mirrorAssets: materialized.publicAssets,
  });
  process.stdout.write(`[release-publish-windows] PASS ${tag} ${commitSha} run=${runId}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  publishWindowsRelease().catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[release-publish-windows] FAIL: ${reason}\n`);
    process.exitCode = 1;
  });
}
