import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runPackagedRealMission } from './e2e-real-mission.mjs';
import {
  assertReleaseSecurityManifest,
  buildReleaseSecurityArtifactsWithPinnedNpm,
  finalizeReleaseSecurityArtifacts,
} from './release-security-gate.mjs';
import {
  assertReleaseRepositoryState,
  collectReleaseRepositoryState,
  readAndAssertReleaseAuthority,
} from './release-authority.mjs';

export { assertReleaseRepositoryState } from './release-authority.mjs';

const EXPECTED_TEAM_ID = '35P5XL3JN6';
const EXPECTED_PROFILE = 'nexus-notary';
const EXPECTED_IDENTITY =
  'Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)';

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function captureCandidateArtifactSeal(artifacts) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(artifacts).map(([kind, filePath]) => {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`candidate ${kind} is not a regular file`);
        }
        return [
          kind,
          Object.freeze({
            path: filePath,
            bytes: stat.size,
            sha256: sha256File(filePath),
          }),
        ];
      }),
    ),
  );
}

export function assertCandidateArtifactSeal(seal) {
  for (const [kind, expected] of Object.entries(seal)) {
    const stat = fs.lstatSync(expected.path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== expected.bytes ||
      sha256File(expected.path) !== expected.sha256
    ) {
      throw new Error(
        `candidate ${kind} bytes changed after signed verification`,
      );
    }
  }
  return seal;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o644,
  });
}

function describeSecurityAssets(securityDir) {
  return fs
    .readdirSync(securityDir, { withFileTypes: true })
    .map((entry) => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.name === 'release-candidate-receipt.json'
      ) {
        throw new Error(
          `security output contains an unsafe or reserved entry: ${entry.name}`,
        );
      }
      const filePath = path.join(securityDir, entry.name);
      const stat = fs.lstatSync(filePath);
      return {
        name: entry.name,
        bytes: stat.size,
        sha256: sha256File(filePath),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function defaultRunChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout ?? 30 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed with exit ${result.status ?? 1}`,
    );
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assertPublishEnvironment(environment) {
  if (environment.NEXUS_MAC_PUBLISH_RELEASE !== '1') {
    throw new Error('NEXUS_MAC_PUBLISH_RELEASE must be exactly "1"');
  }
  if (environment.APPLE_TEAM_ID !== EXPECTED_TEAM_ID) {
    throw new Error(`APPLE_TEAM_ID must be exactly ${EXPECTED_TEAM_ID}`);
  }
  if (environment.APPLE_KEYCHAIN_PROFILE !== EXPECTED_PROFILE) {
    throw new Error(
      `APPLE_KEYCHAIN_PROFILE must be exactly "${EXPECTED_PROFILE}"`,
    );
  }
  if (environment.APPLE_ID || environment.APPLE_APP_SPECIFIC_PASSWORD) {
    throw new Error('Apple secrets must not be exported; use the keychain profile');
  }
}

function exactlyOne(paths, extension) {
  const found = paths.filter((candidate) =>
    candidate.toLowerCase().endsWith(extension),
  );
  if (found.length !== 1) {
    throw new Error(
      `candidate requires exactly one ${extension}; found ${found.length}`,
    );
  }
  return found[0];
}

export function assertFreshCandidateArtifacts({
  paths,
  generatedAfterMs,
  expectedArch,
}) {
  const dmg = exactlyOne(paths, '.dmg');
  const zip = exactlyOne(paths, '.zip');
  for (const candidate of [dmg, zip]) {
    const stat = fs.statSync(candidate);
    if (!stat.isFile() || stat.size <= 0 || stat.mtimeMs < generatedAfterMs) {
      throw new Error(`release artifact is not freshly generated: ${candidate}`);
    }
    if (!candidate.replaceAll('\\', '/').includes(`/${expectedArch}/`) &&
        !path.basename(candidate).includes(expectedArch)) {
      throw new Error(
        `release artifact does not identify host architecture ${expectedArch}: ${candidate}`,
      );
    }
  }
  return { dmg, zip };
}

async function collectRegularFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  await visit(root);
  return files;
}

async function findSinglePackagedApp(root) {
  const apps = [];
  async function visit(directory, depth) {
    if (depth > 4) return;
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.name === 'NexusIDE.app') apps.push(candidate);
      else await visit(candidate, depth + 1);
    }
  }
  await visit(root, 0);
  if (apps.length !== 1) {
    throw new Error(
      `verified ZIP must contain exactly one NexusIDE.app; found ${apps.length}`,
    );
  }
  return apps[0];
}

async function withExtractedZipApp(zipPath, callback, runChecked) {
  const temporaryRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'nexus-release-e2e-'),
  );
  try {
    runChecked(
      '/usr/bin/ditto',
      ['-x', '-k', zipPath, temporaryRoot],
      { timeout: 5 * 60_000 },
    );
    return await callback(await findSinglePackagedApp(temporaryRoot));
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function defaultRepository(
  root,
  version,
  allowedTagSignerFingerprints,
  runChecked,
) {
  return collectReleaseRepositoryState({
    version,
    allowedTagSignerFingerprints,
    gitCapture: (args) =>
      runChecked('git', args, { cwd: root, env: process.env }),
  });
}

export function assertCandidateBuildReceipt({
  root,
  receipt,
  commitSha,
  version,
  tagObjectSha,
  tagSignerFingerprint,
  tagSignatureVerified,
  packageLockSha256,
  npmVersion,
  npmPackageIntegrity,
  nodeVersion,
  expectedArch,
  artifacts,
}) {
  const generatedAfterMs = Date.parse(receipt?.startedAt ?? '');
  if (
    receipt?.schemaVersion !== 2 ||
    receipt?.commitSha !== commitSha ||
    receipt?.tag !== `v${version}` ||
    receipt?.version !== version ||
    receipt?.architecture !== expectedArch ||
    receipt?.tagObjectSha !== tagObjectSha ||
    receipt?.tagSignerFingerprint !== tagSignerFingerprint ||
    receipt?.tagSignatureVerified !== tagSignatureVerified ||
    receipt?.provenance?.mode !== 'clean-git-worktree' ||
    receipt?.provenance?.npmCi !== true ||
    receipt?.provenance?.sourceCommitSha !== commitSha ||
    receipt?.provenance?.packageLockSha256 !== packageLockSha256 ||
    receipt?.provenance?.nodeVersion !== `v${nodeVersion}` ||
    receipt?.provenance?.npmVersion !== npmVersion ||
    receipt?.provenance?.npmPackageIntegrity !== npmPackageIntegrity ||
    !Number.isFinite(generatedAfterMs) ||
    !Array.isArray(receipt?.artifacts) ||
    receipt.artifacts.length !== 2
  ) {
    throw new Error(
      'candidate build receipt provenance is stale or belongs to another commit',
    );
  }
  for (const artifact of [artifacts.dmg, artifacts.zip]) {
    const relative = path.relative(root, artifact).replaceAll('\\', '/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('candidate artifact escaped the release root');
    }
    const declared = receipt.artifacts.find((entry) => entry?.path === relative);
    const stat = fs.statSync(artifact);
    if (
      !declared ||
      declared.bytes !== stat.size ||
      declared.sha256 !== sha256File(artifact) ||
      declared.mtimeMs !== stat.mtimeMs
    ) {
      throw new Error(`candidate artifact diverges from build receipt: ${relative}`);
    }
  }
  return generatedAfterMs;
}

function readBuildReceipt(root) {
  const receiptPath = path.join(
    root,
    'release-artifacts',
    'candidate-build.json',
  );
  return JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
}

export async function runReleaseCandidateGate(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const environment = options.environment ?? process.env;
  const runChecked = options.runChecked ?? defaultRunChecked;
  const runE2E = options.runE2E ?? runPackagedRealMission;
  const extractE2EApp =
    options.extractE2EApp ??
    ((zipPath, callback) =>
      withExtractedZipApp(zipPath, callback, runChecked));
  const now = options.now ?? (() => new Date());
  assertPublishEnvironment(environment);
  const authority =
    options.authority ?? readAndAssertReleaseAuthority(root);
  const version = authority.version;
  const repository =
    options.repository ??
    defaultRepository(
      root,
      version,
      authority.allowedTagSignerFingerprints,
      runChecked,
    );
  const state = assertReleaseRepositoryState({
    ...repository,
    version,
    allowedTagSignerFingerprints:
      authority.allowedTagSignerFingerprints,
    allowedUntrackedPrefixes: [
      'out',
      'release-artifacts',
    ],
  });
  const artifactsRoot = path.join(root, 'out', 'make');
  const expectedArch = process.arch === 'x64' ? 'x86_64' : process.arch;
  const buildReceipt = options.generatedAfterMs === undefined
    ? readBuildReceipt(root)
    : null;
  const receiptStartedAt = buildReceipt
    ? Date.parse(buildReceipt.startedAt ?? '')
    : options.generatedAfterMs;
  const artifacts = assertFreshCandidateArtifacts({
    paths: await collectRegularFiles(artifactsRoot),
    generatedAfterMs: receiptStartedAt,
    expectedArch,
  });
  if (buildReceipt) {
    assertCandidateBuildReceipt({
      root,
      receipt: buildReceipt,
      commitSha: state.commitSha,
      version,
      tagObjectSha: state.tagObjectSha,
      tagSignerFingerprint: state.tagSignerFingerprint,
      tagSignatureVerified: state.tagSignatureVerified,
      packageLockSha256: sha256File(path.join(root, 'package-lock.json')),
      npmVersion: authority.npmVersion,
      npmPackageIntegrity: authority.npmPackageIntegrity,
      nodeVersion: authority.nodeVersion,
      expectedArch,
      artifacts,
    });
  }
  const artifactSeal = captureCandidateArtifactSeal(artifacts);
  const securityDir = path.join(root, 'release-artifacts', 'security');
  fs.rmSync(securityDir, { recursive: true, force: true });
  fs.mkdirSync(securityDir, { recursive: true, mode: 0o700 });
  const buildSecurity =
    options.buildSecurityArtifacts ??
    buildReleaseSecurityArtifactsWithPinnedNpm;
  const security = buildSecurity({
    root,
    outDir: securityDir,
    commitSha: state.commitSha,
    tagObjectSha: state.tagObjectSha,
    tagSignerFingerprint: state.tagSignerFingerprint,
    tagSignatureVerified: state.tagSignatureVerified,
    npmVersion: authority.npmVersion,
    npmPackageIntegrity: authority.npmPackageIntegrity,
    expectedNodeVersion: authority.nodeVersion,
    environment,
    now,
  });
  assertReleaseSecurityManifest({
    root,
    securityDir,
    manifest: security.manifest,
    commitSha: state.commitSha,
    version,
    tagObjectSha: state.tagObjectSha,
    tagSignerFingerprint: state.tagSignerFingerprint,
    tagSignatureVerified: state.tagSignatureVerified,
  });
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  runChecked(process.execPath, [
    path.join(scriptDir, 'verify-macos-release.mjs'),
    '--artifacts',
    artifactsRoot,
    '--version',
    version,
    '--bundle-id',
    'com.nexuside.app',
    '--team-id',
    EXPECTED_TEAM_ID,
    '--identity',
    'Developer ID Application: Cleofas Pereira rocha',
    '--arch',
    expectedArch,
  ], { cwd: root, env: environment, timeout: 60 * 60_000 });
  assertCandidateArtifactSeal(artifactSeal);

  const evidencePath = path.join(
    root,
    'release-artifacts',
    'security',
    'real-mission-evidence.json',
  );
  const e2eArtifactSha256 = artifactSeal.zip.sha256;
  await extractE2EApp(artifacts.zip, async (appPath) => {
    await runE2E(appPath, {
      evidencePath,
      environment,
      releaseBinding: {
        appVersion: version,
        commitSha: state.commitSha,
        artifact: {
          sha256: e2eArtifactSha256,
          identity: EXPECTED_IDENTITY,
        },
      },
    });
  });
  assertCandidateArtifactSeal(artifactSeal);

  finalizeReleaseSecurityArtifacts({
    root,
    securityDir,
    dmgPath: artifacts.dmg,
    zipPath: artifacts.zip,
    evidencePath,
    commitSha: state.commitSha,
    version,
    tagObjectSha: state.tagObjectSha,
    tagSignerFingerprint: state.tagSignerFingerprint,
    tagSignatureVerified: state.tagSignatureVerified,
    expectedE2EArtifactSha256: e2eArtifactSha256,
    expectedSigningIdentity: EXPECTED_IDENTITY,
    now,
  });
  assertCandidateArtifactSeal(artifactSeal);
  const securityAssets = describeSecurityAssets(securityDir);
  const receipt = {
    schemaVersion: 3,
    verifiedAt: now().toISOString(),
    version,
    tag: state.tag,
    commitSha: state.commitSha,
    tagObjectSha: state.tagObjectSha,
    tagSignerFingerprint: state.tagSignerFingerprint,
    tagSignatureVerified: state.tagSignatureVerified,
    architecture: expectedArch,
    artifacts: {
      dmg: {
        name: path.basename(artifacts.dmg),
        sha256: artifactSeal.dmg.sha256,
      },
      zip: {
        name: path.basename(artifacts.zip),
        sha256: artifactSeal.zip.sha256,
      },
      e2eEvidence: {
        name: path.basename(evidencePath),
        sha256: sha256File(evidencePath),
      },
    },
    securityAssets,
    verification: {
      signedNotarized: true,
      realMissionE2E: true,
      sameCommitAndArtifacts: true,
      tagSignatureVerified: state.tagSignatureVerified,
    },
  };
  const receiptPath = path.join(securityDir, 'release-candidate-receipt.json');
  writeJson(receiptPath, receipt);
  return { receipt, receiptPath, artifacts, evidencePath };
}

async function main() {
  const result = await runReleaseCandidateGate();
  process.stdout.write(
    `[release-candidate] PASS ${result.receipt.tag} ` +
      `${result.receipt.commitSha} (${result.receipt.architecture})\n`,
  );
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(
      `[release-candidate] FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
