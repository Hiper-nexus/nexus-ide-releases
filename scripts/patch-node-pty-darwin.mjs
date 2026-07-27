#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_PTY_DARWIN_VERSION = '1.2.0-beta.12';
export const SYSTEM_PERL_HELPER_PATH = '/usr/bin/perl';
export const UPSTREAM_UNIX_TERMINAL_SHA256 =
  'c3bb8dfceb9f99a5d7003041c0aff243eaa60f062538c88fc452c59ae516e74c';
export const PATCHED_UNIX_TERMINAL_SHA256 =
  '4011657fba14f3dc7b6d745811cf183b88d713407ffe41a4ce38aaa9976d0bcc';

export const DARWIN_NODE_PTY_PACKAGES = Object.freeze([
  Object.freeze({
    name: '@lydell/node-pty-darwin-arm64',
    arch: 'arm64',
    upstreamSha256: UPSTREAM_UNIX_TERMINAL_SHA256,
    patchedSha256: PATCHED_UNIX_TERMINAL_SHA256,
  }),
  Object.freeze({
    name: '@lydell/node-pty-darwin-x64',
    arch: 'x64',
    upstreamSha256: UPSTREAM_UNIX_TERMINAL_SHA256,
    patchedSha256: PATCHED_UNIX_TERMINAL_SHA256,
  }),
]);

export const UPSTREAM_HELPER_SOURCE = [
  "var helperPath = native.dir + '/spawn-helper';",
  'helperPath = path.resolve(__dirname, helperPath);',
  "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
  "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
].join('\n');

export const SYSTEM_PERL_HELPER_SOURCE =
  `var helperPath = '${SYSTEM_PERL_HELPER_PATH}';`;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function packagePath(root, packageName) {
  return path.join(root, 'node_modules', ...packageName.split('/'));
}

function assertRegularNonSymlink(filePath, label) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be one regular non-symlink file: ${filePath}`);
  }
  return stats;
}

function collectEntriesNamed(root, name) {
  const found = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.name === name) found.push(candidate);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(candidate);
    }
  }
  visit(root);
  return found;
}

function replaceExactlyOnce(source, before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error('node-pty helper source shape is not the pinned upstream shape');
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

export function patchNodePtyDarwinPackage(
  root,
  packageSpec,
  {
    expectedVersion = NODE_PTY_DARWIN_VERSION,
    upstreamHelperSource = UPSTREAM_HELPER_SOURCE,
    systemHelperSource = SYSTEM_PERL_HELPER_SOURCE,
  } = {},
) {
  const packageRoot = packagePath(root, packageSpec.name);
  if (!fs.existsSync(packageRoot)) {
    return { packageName: packageSpec.name, installed: false, patched: false };
  }

  const packageJsonPath = path.join(packageRoot, 'package.json');
  assertRegularNonSymlink(packageJsonPath, 'node-pty package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (
    packageJson?.name !== packageSpec.name ||
    packageJson?.version !== expectedVersion
  ) {
    throw new Error(
      `refusing to patch unexpected ${packageSpec.name} identity/version`,
    );
  }

  const unixTerminalPath = path.join(packageRoot, 'lib', 'unixTerminal.js');
  const sourceStats = assertRegularNonSymlink(
    unixTerminalPath,
    'node-pty unixTerminal.js',
  );
  const source = fs.readFileSync(unixTerminalPath);
  const observedHash = sha256(source);
  let patched = false;

  if (observedHash === packageSpec.upstreamSha256) {
    const replacement = replaceExactlyOnce(
      source.toString('utf8'),
      upstreamHelperSource,
      systemHelperSource,
    );
    if (sha256(replacement) !== packageSpec.patchedSha256) {
      throw new Error(
        `patched ${packageSpec.name} source does not match the pinned hash`,
      );
    }
    const temporary = `${unixTerminalPath}.nexus-${process.pid}`;
    fs.writeFileSync(temporary, replacement, {
      mode: sourceStats.mode & 0o777,
      flag: 'wx',
    });
    fs.renameSync(temporary, unixTerminalPath);
    patched = true;
  } else if (observedHash !== packageSpec.patchedSha256) {
    throw new Error(
      `${packageSpec.name} unixTerminal.js hash is outside the pinned patch set`,
    );
  }

  const patchedSource = fs.readFileSync(unixTerminalPath, 'utf8');
  if (
    sha256(patchedSource) !== packageSpec.patchedSha256 ||
    !patchedSource.includes(systemHelperSource) ||
    patchedSource.includes('/spawn-helper')
  ) {
    throw new Error(`${packageSpec.name} did not seal /usr/bin/perl as helper`);
  }

  const expectedSpawnHelper = path.join(
    packageRoot,
    'prebuilds',
    `darwin-${packageSpec.arch}`,
    'spawn-helper',
  );
  const spawnHelpers = collectEntriesNamed(packageRoot, 'spawn-helper');
  for (const candidate of spawnHelpers) {
    if (path.resolve(candidate) !== path.resolve(expectedSpawnHelper)) {
      throw new Error(
        `unexpected bundled node-pty spawn-helper path: ${candidate}`,
      );
    }
    const stats = fs.lstatSync(candidate);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      throw new Error(`refusing to remove spawn-helper directory: ${candidate}`);
    }
    fs.unlinkSync(candidate);
  }
  const remaining = collectEntriesNamed(packageRoot, 'spawn-helper');
  if (remaining.length !== 0) {
    throw new Error(
      `${packageSpec.name} still contains a mutable spawn-helper executable`,
    );
  }

  return { packageName: packageSpec.name, installed: true, patched };
}

export function patchNodePtyDarwin({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  packages = DARWIN_NODE_PTY_PACKAGES,
  expectedVersion = NODE_PTY_DARWIN_VERSION,
  upstreamHelperSource = UPSTREAM_HELPER_SOURCE,
  systemHelperSource = SYSTEM_PERL_HELPER_SOURCE,
} = {}) {
  const results = packages.map((packageSpec) =>
    patchNodePtyDarwinPackage(root, packageSpec, {
      expectedVersion,
      upstreamHelperSource,
      systemHelperSource,
    }),
  );
  const installed = results.filter((result) => result.installed);
  process.stdout.write(
    installed.length > 0
      ? `[node-pty-darwin] sealed ${installed.map((item) => item.packageName).join(', ')} to ${SYSTEM_PERL_HELPER_PATH}; bundled spawn-helper count=0\n`
      : '[node-pty-darwin] no Darwin platform package installed; skipped\n',
  );
  return results;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  patchNodePtyDarwin();
}
