import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withPublicationLock } from './release-publication-lock.mjs';

/**
 * Publishes the unsigned Linux x64 channel: the `linux-release.yml` workflow
 * builds .deb/.rpm on ubuntu-22.04 from the annotated tag; this script binds
 * the artifact to the tag object, verifies every byte, and attaches the two
 * packages plus SHA256SUMS-linux-x64.txt to the existing release on the
 * canonical repository first and the public mirror second. Idempotent: an
 * existing asset with the same digest is skipped; a different one fails.
 * Linux has no auto-update — users install the new package manually.
 */
export const CANONICAL_REPO = 'Hiper-nexus/nexus-ide';
export const MIRROR_REPO = 'Hiper-nexus/nexus-ide-releases';
export const LINUX_WORKFLOW_NAME = 'Linux x64 release';
export const ASSETS_ARTIFACT = 'linux-x64-release';
export const RECEIPT_ARTIFACT = 'linux-x64-receipt';
export const RECEIPT_FILE = 'linux-release-receipt.json';
export const SHA256SUMS_FILE = 'SHA256SUMS-linux-x64.txt';
export const RECEIPT_SCHEMA = 'nexus.linux-release/v1';

const STABLE = /^\d+\.\d+\.\d+$/u;
const SHA1 = /^[a-f\d]{40}$/u;
const SHA256 = /^[a-f\d]{64}$/u;
const RUN_ID = /^[1-9]\d*$/u;
const SAFE_ASSET_NAME = /^[A-Za-z0-9_.-]+$/u;

const fail = (message) => {
  throw new Error(`Linux release publish: ${message}`);
};

function sha256File(file) {
  const fd = fs.openSync(file, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, size));
    }
    return digest.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export function githubRepositoryTarget(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo ?? '')) {
    fail('GitHub repository identity is invalid');
  }
  return `github.com/${repo}`;
}

/** The exact basenames the linux x64 maker chain produces for a version. */
export function linuxAssetNames(version) {
  return [
    `nexus-ide_${version}_amd64.deb`,
    `nexus-ide-${version}-1.x86_64.rpm`,
  ];
}

export function sha256SumsContent(files) {
  return [...files]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((file) => `${file.sha256}  ${file.name}`)
    .join('\n') + '\n';
}

export function assertLinuxRun(run, runId) {
  if (
    !run ||
    String(run.databaseId) !== String(runId) ||
    run.workflowName !== LINUX_WORKFLOW_NAME ||
    run.event !== 'workflow_dispatch' ||
    run.headBranch !== 'main' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !SHA1.test(run.headSha ?? '')
  ) {
    fail(
      'worker must be the successful Linux x64 release workflow dispatched on main',
    );
  }
}

export function assertLinuxReceipt(receipt, expected) {
  if (
    !receipt ||
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.version !== expected.version ||
    receipt.commit !== expected.commitSha ||
    receipt.tagObject !== expected.tagObjectSha ||
    String(receipt.runId) !== String(expected.runId) ||
    String(receipt.runAttempt) !== String(expected.runAttempt) ||
    receipt.dispatchSha !== expected.dispatchSha ||
    receipt.runner !== 'ubuntu-22.04' ||
    receipt.arch !== 'x64' ||
    receipt.smoke?.packaged !== true ||
    receipt.smoke?.debInstalled !== true ||
    !Array.isArray(receipt.files)
  ) {
    fail('release receipt does not match this tag and worker run');
  }
}

/** Inventory: exactly the .deb and .rpm the makers produce, nothing else. */
export function assertLinuxInventory(files, version) {
  const expected = linuxAssetNames(version);
  const names = files.map((file) => file.name);
  if (
    names.length !== 2 ||
    new Set(names).size !== 2 ||
    names.some((name) => !expected.includes(name))
  ) {
    fail(`receipt inventory must be exactly ${expected.join(' + ')}`);
  }
}

function readFileAsset(root, entry) {
  if (
    !SAFE_ASSET_NAME.test(entry?.name ?? '') ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 1 ||
    !SHA256.test(entry.sha256 ?? '')
  ) {
    fail('release receipt file metadata is invalid');
  }
  const file = path.join(root, entry.name);
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== entry.bytes ||
    sha256File(file) !== entry.sha256
  ) {
    fail(`payload bytes do not match the receipt: ${entry.name}`);
  }
  return file;
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

function runInherited(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} failed with exit ${result.status ?? 1}`);
}

/** Injectable seams: `ghJson` returns parsed stdout, `ghRun` inherits stdio. */
function productionSeams(root) {
  return {
    ghJson: (args) => JSON.parse(runCapture('gh', args, root)),
    ghRun: (args) => runInherited('gh', args, root),
    git: (args) => runCapture('git', args, root).trim(),
    tempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-linux-release-')),
  };
}

function parsePublishArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--version', '--run'].includes(key) || !value) {
      fail('usage: publish-linux-release.mjs --version <v> --run <id>');
    }
    options[key.slice(2)] = value;
  }
  if (!options.run) fail('--run <id> is required');
  return options;
}

export function planLinuxAssetUploads(releaseAssets, expected) {
  const byName = new Map();
  for (const asset of releaseAssets ?? []) {
    if (typeof asset?.name === 'string' && !byName.has(asset.name)) {
      byName.set(asset.name, asset);
    }
  }
  const upload = [];
  const skipped = [];
  for (const file of expected) {
    const existing = byName.get(file.name);
    if (!existing) {
      upload.push(file);
      continue;
    }
    if (existing.digest === `sha256:${file.sha256}`) {
      skipped.push(file.name);
      continue;
    }
    // Never overwrite: a same-name asset with another (or no) digest is a
    // mismatch that must be resolved by hand.
    fail(`existing release asset has a different payload: ${file.name}`);
  }
  return { upload, skipped };
}

function inspectReleaseOrFail(seams, repo, tag) {
  try {
    return seams.ghJson([
      'release',
      'view',
      tag,
      '--repo',
      githubRepositoryTarget(repo),
      '--json',
      'tagName,isDraft,assets',
    ]);
  } catch {
    fail(`release ${tag} on ${repo} must exist and be published`);
  }
}

function publishToRepo({ seams, repo, tag, expected, results }) {
  const release = inspectReleaseOrFail(seams, repo, tag);
  if (!release || release.tagName !== tag || release.isDraft !== false) {
    fail(`release ${tag} on ${repo} must exist and be published`);
  }
  const plan = planLinuxAssetUploads(release.assets, expected);
  for (const file of plan.upload) {
    seams.ghRun([
      'release',
      'upload',
      tag,
      '--repo',
      githubRepositoryTarget(repo),
      file.path,
    ]);
  }
  const after = seams.ghJson([
    'release',
    'view',
    tag,
    '--repo',
    githubRepositoryTarget(repo),
    '--json',
    'assets',
  ]);
  const byName = new Map(
    (after?.assets ?? []).map((asset) => [asset?.name, asset]),
  );
  for (const file of expected) {
    const asset = byName.get(file.name);
    if (asset?.digest !== `sha256:${file.sha256}`) {
      fail(`uploaded asset ${file.name} on ${repo} lacks the expected digest`);
    }
  }
  results.push({ repo, uploaded: plan.upload.map((f) => f.name), skipped: plan.skipped });
}

function readVersion(root) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  return packageJson.version;
}

export async function publishLinuxReleaseCore(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const argv = options.argv ?? parsePublishArgs(process.argv.slice(2));
  const seams = options.seams ?? productionSeams(root);
  const version = argv.version ?? options.version ?? readVersion(root);
  const runId = argv.run ?? options.runId;
  if (!STABLE.test(version ?? '')) fail(`invalid stable version: ${version}`);
  if (!RUN_ID.test(String(runId ?? ''))) fail('--run must be a numeric run id');
  const tag = `v${version}`;

  const run = seams.ghJson([
    'run',
    'view',
    String(runId),
    '--repo',
    githubRepositoryTarget(CANONICAL_REPO),
    '--json',
    'databaseId,workflowName,event,headBranch,headSha,status,conclusion,attempt',
  ]);
  assertLinuxRun(run, runId);

  const directory = seams.tempDir();
  try {
    const assetsDir = path.join(directory, 'assets');
    const receiptDir = path.join(directory, 'receipt');
    seams.ghRun([
      'run',
      'download',
      String(runId),
      '--repo',
      githubRepositoryTarget(CANONICAL_REPO),
      '--name',
      ASSETS_ARTIFACT,
      '--dir',
      assetsDir,
    ]);
    seams.ghRun([
      'run',
      'download',
      String(runId),
      '--repo',
      githubRepositoryTarget(CANONICAL_REPO),
      '--name',
      RECEIPT_ARTIFACT,
      '--dir',
      receiptDir,
    ]);

    // The tag is the authority: fetch it, then bind the receipt's commit and
    // tagObject to the local annotated tag object.
    seams.git(['fetch', 'origin', 'tag', tag]);
    if (seams.git(['cat-file', '-t', tag]) !== 'tag') {
      fail(`release tag ${tag} must be an annotated tag`);
    }
    const commitSha = seams.git(['rev-parse', `${tag}^{}`]);
    const tagObjectSha = seams.git(['rev-parse', tag]);
    if (!SHA1.test(commitSha) || !SHA1.test(tagObjectSha)) {
      fail(`release tag ${tag} does not dereference to a commit`);
    }

    const receiptPath = path.join(receiptDir, RECEIPT_FILE);
    const receiptStat = fs.existsSync(receiptPath) ? fs.lstatSync(receiptPath) : null;
    if (!receiptStat?.isFile() || receiptStat.isSymbolicLink()) {
      fail('worker receipt artifact is missing');
    }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assertLinuxReceipt(receipt, {
      version,
      commitSha,
      tagObjectSha,
      runId,
      runAttempt: run.attempt,
      dispatchSha: run.headSha,
    });
    assertLinuxInventory(receipt.files, version);

    const payloadPaths = receipt.files.map((entry) => readFileAsset(assetsDir, entry));
    const listing = fs.readdirSync(assetsDir).sort();
    const expectedListing = [...receipt.files.map((f) => f.name), RECEIPT_FILE].sort();
    if (listing.join('\n') !== expectedListing.join('\n')) {
      fail('asset artifact must contain exactly the two packages and the receipt');
    }

    const sumsPath = path.join(directory, SHA256SUMS_FILE);
    fs.writeFileSync(sumsPath, sha256SumsContent(receipt.files));
    const payload = [
      ...receipt.files.map((file, index) => ({
        ...file,
        path: payloadPaths[index],
      })),
      {
        name: SHA256SUMS_FILE,
        bytes: fs.statSync(sumsPath).size,
        sha256: sha256File(sumsPath),
        path: sumsPath,
      },
    ];

    const results = [];
    // Canonical first, then the public mirror — never clobber, never delete.
    publishToRepo({ seams, repo: CANONICAL_REPO, tag, expected: payload, results });
    publishToRepo({ seams, repo: MIRROR_REPO, tag, expected: payload, results });

    const summary = {
      status: 'pass',
      version,
      tag,
      commit: commitSha,
      runId,
      assets: payload.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
      repositories: results,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function publishLinuxRelease(options = {}) {
  return withPublicationLock(() => publishLinuxReleaseCore(options), {
    lockPath: path.join(os.tmpdir(), 'nexus-ide-linux-release-publication.lock'),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  publishLinuxRelease().catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[release-publish-linux] FAIL: ${reason}\n`);
    process.exitCode = 1;
  });
}
