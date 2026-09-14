import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import extractZip from '@electron-internal/extract-zip';

const REPO = 'Hiper-nexus/nexus-ide';
const MIRROR = 'Hiper-nexus/nexus-ide-releases';
const WORKFLOW = '.github/workflows/windows-release.yml';
const ARTIFACT = 'windows-x64-signed-release';
const RECEIPT = 'windows-release-receipt.json';
const STABLE = /^\d+\.\d+\.\d+$/u;
const THUMBPRINT = /^[a-f\d]{40}$/iu;
const SHA256 = /^[a-f\d]{64}$/u;
const fail = message => { throw new Error(`Windows release: ${message}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function fileHash(filename, algorithm = 'sha256') {
  const fd = fs.openSync(filename, 'r');
  const digest = createHash(algorithm);
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size));
    return digest.digest('hex');
  } finally { fs.closeSync(fd); }
}

export function requireWindowsRunId(environment) {
  const id = environment.NEXUS_WINDOWS_RELEASE_RUN_ID;
  if (!/^[1-9]\d*$/u.test(id ?? '')) fail('NEXUS_WINDOWS_RELEASE_RUN_ID must identify a successful signed Windows worker run; provision the protected CKA worker first. Mac-only publication is disabled.');
  return id;
}

export function assertWindowsRun({ run, workflow, branch, commitSha, runId }) {
  if (String(run?.id) !== runId || run?.head_sha !== commitSha || !/^[a-f\d]{40}$/u.test(commitSha) ||
    run?.path !== WORKFLOW || run?.workflow_id !== workflow?.id || workflow?.path !== WORKFLOW || workflow?.state !== 'active' ||
    run?.event !== 'workflow_dispatch' || run?.head_branch !== 'main' || run?.status !== 'completed' || run?.conclusion !== 'success' ||
    !Number.isSafeInteger(workflow?.id) || workflow.id < 1 || !Number.isSafeInteger(run?.repository?.id) || run.repository.id < 1 ||
    run?.repository?.full_name !== REPO || run?.repository?.private !== true || branch?.protected !== true) {
    fail('worker must be the successful known workflow on protected main at the exact release commit');
  }
}

export function assertWindowsArchiveEntries(entries, version) {
  if (entries.length !== 4 || new Set(entries).size !== 4 || entries.some(name => !/^[A-Za-z0-9_.-]+$/u.test(name)) ||
    !entries.includes(RECEIPT) || !entries.includes('RELEASES') || !entries.includes(`NexusIDE-${version}-win32-x64-Setup.exe`) ||
    !entries.includes(`nexus_ide-${version}-full.nupkg`)) fail('archive must contain exactly four flat candidate files');
}

export async function extractWindowsArchive(zip, destination, version) {
  // Publication is a macOS operation. The native extractor does not support onEntry.
  const listing = spawnSync('/usr/bin/unzip', ['-Z', '-1', zip], {
    encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 8192,
  });
  if (listing.error || listing.status !== 0) fail('cannot inspect artifact archive');
  assertWindowsArchiveEntries(listing.stdout.trim().split(/\r?\n/u), version);
  // Pinned Electron extractor rejects Zip Slip and symlink escapes. Candidate
  // validation subsequently rejects even in-directory symlinks/non-regular files.
  await extractZip(zip, { dir: destination });
}

export function assertWindowsArtifact(artifact, archive, run) {
  const digest = Buffer.isBuffer(archive) ? hash(archive) : archive;
  if (artifact?.name !== ARTIFACT || artifact?.expired !== false || !SHA256.test(digest ?? '') || artifact?.digest !== `sha256:${digest}` ||
    artifact?.workflow_run?.id !== run.id || artifact?.workflow_run?.head_sha !== run.head_sha ||
    artifact?.workflow_run?.repository_id !== run.repository.id || artifact?.workflow_run?.head_repository_id !== run.repository.id) {
    fail('artifact run identity, expiry or authenticated archive digest is invalid');
  }
}

function assertSignature(signature) {
  if (signature?.status !== 'Valid' || !THUMBPRINT.test(signature?.thumbprint ?? '') || !THUMBPRINT.test(signature?.timestampThumbprint ?? '') ||
    !/(?:^|,\s*)CN="?HIPERSEND TECNOLOGIA INTERNET & SOFTWARES LTDA"?(?:,|$)/u.test(signature?.subject ?? '')) fail('signature publisher or timestamp is invalid');
}

function assertReceipt(receipt, expected) {
  if (receipt?.schemaVersion !== 1 || !STABLE.test(expected.version) || receipt?.version !== expected.version ||
    receipt?.commitSha !== expected.commitSha || receipt?.runId !== expected.runId || receipt?.platform !== 'win32' || receipt?.arch !== 'x64' ||
    receipt?.smoke?.status !== 'pass' || !Array.isArray(receipt?.assets) || receipt.assets.length !== 3) fail('candidate receipt does not match the release or smoke failed');
  for (const kind of ['setup', 'app', 'updater', 'stub']) assertSignature(receipt.signatures?.[kind]);
  const publisher = receipt.signatures.setup.thumbprint.toUpperCase();
  if (['app', 'updater', 'stub'].some(kind => receipt.signatures[kind].thumbprint.toUpperCase() !== publisher)) fail('candidate executables have different publishers');
}

function assertInstalledUpgradeProof(receipt, expected) {
  const proof = receipt.installedUpgradeProof;
  const from = String(proof?.fromVersion ?? '');
  const isOlder = STABLE.test(from) && from.split('.').map(Number)
    .map((part, index) => part - Number(expected.version.split('.')[index]))
    .find(value => value !== 0) < 0;
  if (receipt.smoke.installedUpgradeVerified !== true || proof?.schemaVersion !== 1 || proof?.status !== 'pass' || !isOlder ||
    proof.toVersion !== expected.version || proof.commitSha !== expected.commitSha || proof.runId !== expected.runId ||
    !proof.assetSha256 || Object.keys(proof.assetSha256).length !== 3 ||
    receipt.assets.some(asset => proof.assetSha256[asset.name] !== asset.sha256) ||
    ['signedBaselineInstalled', 'squirrelUpgradeApplied', 'targetRestarted', 'userDataPreserved'].some(check => proof.checks?.[check] !== true)) {
    fail('installed N-to-N+1 upgrade proof is missing, failed or not bound to this candidate. Run a real signed installed-upgrade harness in the trusted worker and record target version, commit, run and all asset hashes; signed NUPKG smoke alone cannot authorize public publication.');
  }
}

function assertAsset(root, asset) {
  if (typeof asset?.name !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(asset.name) || !SHA256.test(asset.sha256 ?? '') ||
    !Number.isSafeInteger(asset.size) || asset.size < 1) fail('invalid asset metadata');
  const filename = path.join(root, asset.name);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.size || fileHash(filename) !== asset.sha256) fail(`asset bytes changed: ${asset.name}`);
  return filename;
}

export function assertWindowsCandidate(root, expected) {
  const receiptPath = path.join(root, RECEIPT);
  if (!fs.lstatSync(receiptPath).isFile() || fs.lstatSync(receiptPath).isSymbolicLink()) fail('unsafe receipt');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assertReceipt(receipt, expected);
  const names = receipt.assets.map(a => a.name);
  const setupName = `NexusIDE-${expected.version}-win32-x64-Setup.exe`;
  const packages = names.filter(name => name === `nexus_ide-${expected.version}-full.nupkg`);
  if (new Set(names).size !== 3 || !names.includes(setupName) || !names.includes('RELEASES') || packages.length !== 1 ||
    fs.readdirSync(root).sort().join('\n') !== [...names, RECEIPT].sort().join('\n')) fail('candidate asset inventory must be exact');
  const assetPaths = receipt.assets.map(asset => assertAsset(root, asset));
  const packagePath = path.join(root, packages[0]);
  const releases = fs.readFileSync(path.join(root, 'RELEASES'), 'utf8').trim();
  const expectedEntry = `${fileHash(packagePath, 'sha1')} ${packages[0]} ${fs.statSync(packagePath).size}`;
  if (releases.toLowerCase() !== expectedEntry.toLowerCase() || releases.split(/\r?\n/u).length !== 1) fail('RELEASES must contain one exact full package hash, original name and size');
  assertInstalledUpgradeProof(receipt, expected);
  return { assetPaths, receiptPath, assets: receipt.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    receiptAsset: { name: RECEIPT, size: fs.statSync(receiptPath).size, sha256: fileHash(receiptPath) } };
}

export function appendWindowsAssets(mac, windows) {
  if (!windows || windows.assetPaths?.length !== 3 || windows.assets?.length !== 3 || !windows.receiptPath || !windows.receiptAsset) fail('verified Windows candidate is required');
  return { ...mac,
    canonicalAssetPaths: [...mac.canonicalAssetPaths, ...windows.assetPaths, windows.receiptPath],
    publicAssetPaths: [...mac.publicAssetPaths, ...windows.assetPaths],
    canonicalAssets: [...mac.canonicalAssets, ...windows.assets, windows.receiptAsset],
    publicAssets: [...mac.publicAssets, ...windows.assets],
  };
}

export function assertMonotonicWindowsRelease(releases, version) {
  const current = version.split('.').map(Number);
  for (const release of releases) {
    const other = String(release.tag_name ?? '').replace(/^v/u, '');
    if (release.draft || release.prerelease || !STABLE.test(other)) continue;
    const parts = other.split('.').map(Number);
    const difference = parts.map((part, index) => part - current[index]).find(value => value !== 0);
    if (difference > 0) fail(`newer stable ${release.tag_name} already exists; refusing non-monotonic publication`);
  }
}

function github(args, root, outputFd) {
  const result = spawnSync('gh', ['api', '--hostname', 'github.com', ...args], {
    cwd: root, shell: false, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8', stdio: ['ignore', outputFd ?? 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) fail('authenticated GitHub worker lookup/download failed; verify the run ID and repository access');
  return outputFd === undefined ? JSON.parse(result.stdout) : undefined;
}

/** Production authority is exclusively authenticated GitHub metadata + bytes, never a caller-supplied local receipt. */
export async function loadSignedWindowsCandidate({ root, environment, version, commitSha }) {
  const runId = requireWindowsRunId(environment);
  const run = github([`repos/${REPO}/actions/runs/${runId}`], root);
  const workflow = github([`repos/${REPO}/actions/workflows/windows-release.yml`], root);
  const branch = github([`repos/${REPO}/branches/main`], root);
  assertWindowsRun({ run, workflow, branch, commitSha, runId });
  const comparison = github([`repos/${REPO}/compare/${commitSha}...main`], root);
  if (!['ahead', 'identical'].includes(comparison.status) || comparison.merge_base_commit?.sha !== commitSha) fail('worker commit is not on protected main');
  const pages = github(['--paginate', '--slurp', `repos/${MIRROR}/releases?per_page=100`], root);
  assertMonotonicWindowsRelease(pages.flat(), version);
  const artifacts = github(['--paginate', '--slurp', `repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`], root).flatMap(page => page.artifacts);
  const matches = artifacts.filter(artifact => artifact.name === ARTIFACT);
  if (matches.length !== 1) fail('signed worker artifact missing or ambiguous; unsigned previews cannot authorize publication');
  const artifact = matches[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired !== false || !/^sha256:[a-f\d]{64}$/u.test(artifact.digest ?? '')) fail('artifact metadata lacks a usable immutable digest');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-signed-windows-'));
  const dispose = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const zip = path.join(directory, 'worker.zip');
    const fd = fs.openSync(zip, 'wx', 0o600);
    try { github([`repos/${REPO}/actions/artifacts/${artifact.id}/zip`], root, fd); } finally { fs.closeSync(fd); }
    assertWindowsArtifact(artifact, fileHash(zip), run);
    const extracted = path.join(directory, 'candidate');
    await extractWindowsArchive(zip, extracted, version);
    const candidate = assertWindowsCandidate(extracted, { version, commitSha, runId });
    return { ...candidate, dispose };
  } catch (error) { dispose(); throw error; }
}
