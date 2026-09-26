import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertReleaseRepositoryState,
  collectReleaseRepositoryState,
  readAndAssertReleaseAuthority,
} from './release-authority.mjs';

const TEAM_ID = '35P5XL3JN6';
const NOTARY_PROFILE = 'nexus-notary';
const SIGNING_IDENTITY =
  `Developer ID Application: Cleofas Pereira rocha (${TEAM_ID})`;

export function assertReleaseBuildPreconditions({
  environment,
  repository,
  version,
  allowedTagSignerFingerprints = [],
}) {
  if (environment.NEXUS_MAC_PUBLISH_RELEASE !== '1') {
    throw new Error('NEXUS_MAC_PUBLISH_RELEASE must be exactly "1"');
  }
  if (environment.APPLE_TEAM_ID !== TEAM_ID) {
    throw new Error(`APPLE_TEAM_ID must be exactly ${TEAM_ID}`);
  }
  if (environment.APPLE_KEYCHAIN_PROFILE !== NOTARY_PROFILE) {
    throw new Error(
      `APPLE_KEYCHAIN_PROFILE must be exactly "${NOTARY_PROFILE}"`,
    );
  }
  if (environment.APPLE_ID || environment.APPLE_APP_SPECIFIC_PASSWORD) {
    throw new Error('Apple credentials must stay in the local keychain profile');
  }
  return assertReleaseRepositoryState({
    ...repository,
    version,
    allowedTagSignerFingerprints,
    allowedUntrackedPrefixes: ['release-artifacts'],
  });
}

export function assertNotaryProfileHistory(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error(
      `Apple notary profile "${NOTARY_PROFILE}" returned invalid JSON`,
    );
  }
  if (!parsed || !Array.isArray(parsed.history)) {
    throw new Error(
      `Apple notary profile "${NOTARY_PROFILE}" did not return submission history`,
    );
  }
  return Object.freeze({
    profile: NOTARY_PROFILE,
    submissions: parsed.history.length,
  });
}

export function assertDeveloperIdIdentity(raw) {
  const text = String(raw ?? '');
  if (!text.includes(`"${SIGNING_IDENTITY}"`)) {
    throw new Error(
      `usable code-signing identity "${SIGNING_IDENTITY}" is unavailable`,
    );
  }
  return SIGNING_IDENTITY;
}

/**
 * Fail before the disposable npm install/build when the local Apple authority
 * is unavailable. `notarytool history` authenticates the exact Keychain
 * profile without exposing its password; `security find-identity` proves that
 * the certificate and private key are usable for Developer ID signing.
 */
export function verifyMacReleaseCredentials({
  execute,
  environment,
  root,
}) {
  try {
    execute('/usr/bin/xcrun', ['--find', 'notarytool'], {
      cwd: root,
      env: environment,
      timeout: 30_000,
    });
    execute('/usr/bin/xcrun', ['--find', 'stapler'], {
      cwd: root,
      env: environment,
      timeout: 30_000,
    });
    const history = execute(
      '/usr/bin/xcrun',
      [
        'notarytool',
        'history',
        '--keychain-profile',
        NOTARY_PROFILE,
        '--output-format',
        'json',
      ],
      {
        cwd: root,
        env: environment,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    assertNotaryProfileHistory(history.stdout);
  } catch (error) {
    throw new Error(
      `Apple notary profile "${NOTARY_PROFILE}" is unavailable or invalid`,
      { cause: error },
    );
  }

  try {
    const identities = execute(
      '/usr/bin/security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { cwd: root, env: environment, timeout: 30_000 },
    );
    assertDeveloperIdIdentity(
      `${identities.stdout}\n${identities.stderr}`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('usable code-signing identity')
    ) {
      throw error;
    }
    throw new Error(
      `Developer ID signing identity for Team ${TEAM_ID} is unavailable`,
      { cause: error },
    );
  }
}

export function cleanReleaseMakeOutput(root) {
  const resolvedRoot = path.resolve(root);
  const makeDir = path.join(resolvedRoot, 'out', 'make');
  const expectedParent = path.join(resolvedRoot, 'out');
  if (
    path.dirname(makeDir) !== expectedParent ||
    path.basename(makeDir) !== 'make'
  ) {
    throw new Error('refusing to clean an unexpected release output path');
  }
  fs.rmSync(makeDir, { recursive: true, force: true });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    shell: false,
    timeout: options.timeout ?? 30 * 60_000,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args[0]} failed`);
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function collectReleaseArtifacts(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(candidate);
      else if (
        entry.isFile() &&
        (candidate.toLowerCase().endsWith('.dmg') ||
          candidate.toLowerCase().endsWith('.zip'))
      ) {
        files.push(candidate);
      }
    }
  }
  visit(path.join(root, 'out', 'make'));
  if (
    files.filter((file) => file.toLowerCase().endsWith('.dmg')).length !== 1 ||
    files.filter((file) => file.toLowerCase().endsWith('.zip')).length !== 1
  ) {
    throw new Error('release build must freshly produce exactly one DMG and ZIP');
  }
  return files.sort().map((filePath) => {
    const bytes = fs.readFileSync(filePath);
    const stat = fs.statSync(filePath);
    return {
      path: path.relative(root, filePath).replaceAll('\\', '/'),
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

function releaseBuildEnvironment(environment) {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TERM',
    'CI',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'NEXUS_MAC_PUBLISH_RELEASE',
    // Autoridade de carimbo alternativa do codesign (F-652, build/mac-signing.ts).
    'NEXUS_MAC_TIMESTAMP_URL',
    'APPLE_TEAM_ID',
    'APPLE_KEYCHAIN_PROFILE',
  ]);
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      typeof value === 'string' &&
      (allowed.has(key) || key.startsWith('LC_'))
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function sha512Integrity(filePath) {
  return `sha512-${createHash('sha512')
    .update(fs.readFileSync(filePath))
    .digest('base64')}`;
}

export function bootstrapPinnedNpm({
  buildBase,
  version,
  expectedIntegrity,
  execute,
  environment,
  platform = process.platform,
}) {
  const downloadDir = path.join(buildBase, 'npm-download');
  const installDir = path.join(buildBase, 'npm-bootstrap');
  const cacheDir = path.join(buildBase, 'npm-cache');
  const userConfig = path.join(buildBase, 'empty-npmrc');
  for (const directory of [downloadDir, installDir, cacheDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(userConfig, '', { mode: 0o600 });
  const npmEnvironment = {
    ...environment,
    NPM_CONFIG_CACHE: cacheDir,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  };
  execute(
    platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'pack',
      `npm@${version}`,
      '--pack-destination',
      downloadDir,
      '--ignore-scripts',
      '--json',
      '--registry=https://registry.npmjs.org/',
      `--cache=${cacheDir}`,
    ],
    { cwd: buildBase, env: npmEnvironment },
  );
  const archives = fs.readdirSync(downloadDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => path.join(downloadDir, entry.name));
  if (archives.length !== 1 || !archives[0].endsWith('.tgz')) {
    throw new Error('pinned npm bootstrap did not produce exactly one archive');
  }
  const actualIntegrity = sha512Integrity(archives[0]);
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error(
      `npm ${version} package integrity does not match repository authority`,
    );
  }
  execute(platform === 'win32' ? 'tar' : '/usr/bin/tar', ['-xzf', archives[0], '-C', installDir], {
    cwd: buildBase,
    env: npmEnvironment,
  });
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(installDir, 'package', 'package.json'),
    'utf8',
  ));
  const npmCli = path.join(installDir, 'package', 'bin', 'npm-cli.js');
  const npmCliStat = fs.lstatSync(npmCli);
  if (
    packageJson?.name !== 'npm' ||
    packageJson?.version !== version ||
    !npmCliStat.isFile() ||
    npmCliStat.isSymbolicLink()
  ) {
    throw new Error('pinned npm bootstrap package identity is invalid');
  }
  const resolvedVersion = execute(process.execPath, [npmCli, '--version'], {
    cwd: buildBase,
    env: npmEnvironment,
  }).stdout.trim();
  if (resolvedVersion !== version) {
    throw new Error(
      `release build requires npm ${version}; resolved ${resolvedVersion}`,
    );
  }
  return {
    npmCli,
    npmEnvironment,
    packageIntegrity: actualIntegrity,
  };
}

function copyCleanBuildOutput(sourceRoot, destinationRoot) {
  cleanReleaseMakeOutput(destinationRoot);
  const source = path.join(sourceRoot, 'out', 'make');
  const destination = path.join(destinationRoot, 'out', 'make');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

export function runCleanReleaseBuild(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new Error('publishable macOS release must be built on macOS');
  }
  const nodeVersion = options.nodeVersion ?? process.version;
  const root = path.resolve(options.root ?? process.cwd());
  const environment = options.environment ?? process.env;
  const authority =
    options.authority ?? readAndAssertReleaseAuthority(root);
  if (nodeVersion !== `v${authority.nodeVersion}`) {
    throw new Error(
      `release build requires Node ${authority.nodeVersion}; found ${nodeVersion}`,
    );
  }
  const version = authority.version;
  const execute = options.runCommand ?? runCommand;
  const repository =
    options.repository ??
    collectReleaseRepositoryState({
      version,
      allowedTagSignerFingerprints:
        authority.allowedTagSignerFingerprints,
      gitCapture: (args) =>
        execute('git', args, {
          cwd: root,
          env: environment,
        }),
    });
  const state = assertReleaseBuildPreconditions({
    environment,
    repository,
    version,
    allowedTagSignerFingerprints:
      authority.allowedTagSignerFingerprints,
  });
  const verifyCredentials =
    options.verifyReleaseCredentials ?? verifyMacReleaseCredentials;
  verifyCredentials({
    execute,
    environment,
    root,
  });
  const buildBase = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-release-build-'),
  );
  fs.chmodSync(buildBase, 0o700);
  const workspace = path.join(buildBase, 'source');
  const startedAt = new Date().toISOString();
  const buildEnv = releaseBuildEnvironment(environment);
  let worktreeAdded = false;
  let buildPackageLockSha256;
  try {
    execute(
      'git',
      ['worktree', 'add', '--detach', workspace, state.commitSha],
      { cwd: root, env: buildEnv, inherit: true },
    );
    worktreeAdded = true;
    const cleanHead = execute('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
      env: buildEnv,
    }).stdout.trim();
    const cleanStatus = execute(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: workspace, env: buildEnv },
    ).stdout.trim();
    if (cleanHead !== state.commitSha || cleanStatus !== '') {
      throw new Error('disposable release checkout is not the verified clean commit');
    }
    buildPackageLockSha256 = createHash('sha256')
      .update(fs.readFileSync(path.join(workspace, 'package-lock.json')))
      .digest('hex');
    const pinnedNpm = (
      options.bootstrapPinnedNpm ?? bootstrapPinnedNpm
    )({
      buildBase,
      version: authority.npmVersion,
      expectedIntegrity: authority.npmPackageIntegrity,
      execute,
      environment: buildEnv,
      platform,
    });
    execute(process.execPath, [pinnedNpm.npmCli, 'ci'], {
      cwd: workspace,
      env: pinnedNpm.npmEnvironment,
      inherit: true,
      timeout: 60 * 60_000,
    });
    execute(process.execPath, [pinnedNpm.npmCli, 'run', 'premake'], {
      cwd: workspace,
      env: pinnedNpm.npmEnvironment,
      inherit: true,
      timeout: 60 * 60_000,
    });
    const forgeCli = path.join(
      workspace,
      'node_modules',
      '@electron-forge',
      'cli',
      'dist',
      'electron-forge.js',
    );
    execute(process.execPath, [forgeCli, 'make'], {
      cwd: workspace,
      env: buildEnv,
      inherit: true,
      timeout: 2 * 60 * 60_000,
    });
    copyCleanBuildOutput(workspace, root);
  } finally {
    if (worktreeAdded) {
      try {
        execute('git', ['worktree', 'remove', '--force', workspace], {
          cwd: root,
          env: buildEnv,
        });
      } catch {
        // The scoped temporary directory is still removed below. A stale Git
        // worktree registration is harmless and `git worktree prune` can clear it.
      }
    }
    fs.rmSync(buildBase, { recursive: true, force: true });
  }
  const artifacts = collectReleaseArtifacts(root);
  const rootPackageLockSha256 = createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'package-lock.json')))
    .digest('hex');
  if (
    !buildPackageLockSha256 ||
    buildPackageLockSha256 !== rootPackageLockSha256
  ) {
    throw new Error('release package-lock changed during the disposable build');
  }
  const startedAtMs = Date.parse(startedAt);
  if (artifacts.some((artifact) => artifact.mtimeMs < startedAtMs)) {
    throw new Error('Forge returned a stale release artifact');
  }
  const receiptPath = path.join(
    root,
    'release-artifacts',
    'candidate-build.json',
  );
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o755 });
  fs.writeFileSync(
    receiptPath,
    `${JSON.stringify({
      schemaVersion: 2,
      startedAt,
      finishedAt: new Date().toISOString(),
      version,
      tag: state.tag,
      commitSha: state.commitSha,
      tagObjectSha: state.tagObjectSha,
      tagSignerFingerprint: state.tagSignerFingerprint,
      tagSignatureVerified: state.tagSignatureVerified,
      architecture: process.arch === 'x64' ? 'x86_64' : process.arch,
      provenance: {
        mode: 'clean-git-worktree',
        npmCi: true,
        sourceCommitSha: state.commitSha,
        packageLockSha256: buildPackageLockSha256,
        nodeVersion,
        npmVersion: authority.npmVersion,
        npmPackageIntegrity: authority.npmPackageIntegrity,
      },
      artifacts,
    }, null, 2)}\n`,
    { mode: 0o644 },
  );
  return { receiptPath, state, artifacts };
}

function main() {
  runCleanReleaseBuild();
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `[make-release] FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
