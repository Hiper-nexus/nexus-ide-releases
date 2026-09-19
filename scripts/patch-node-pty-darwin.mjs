#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_PTY_DARWIN_VERSION = '1.2.0-beta.12';
export const SYSTEM_PERL_HELPER_PATH = '/usr/bin/perl';
export const UPSTREAM_UNIX_TERMINAL_SHA256 =
  'c3bb8dfceb9f99a5d7003041c0aff243eaa60f062538c88fc452c59ae516e74c';
export const SEALED_UNIX_TERMINAL_SHA256 =
  '4011657fba14f3dc7b6d745811cf183b88d713407ffe41a4ce38aaa9976d0bcc';
export const PATCHED_UNIX_TERMINAL_SHA256 =
  'f69e167fd8dbf5631c4dfb92ace4fbd9045d825d03ca660b47f6df9a14f0322f';

export const DARWIN_NODE_PTY_PACKAGES = Object.freeze([
  Object.freeze({
    name: '@lydell/node-pty-darwin-arm64',
    arch: 'arm64',
    upstreamSha256: UPSTREAM_UNIX_TERMINAL_SHA256,
    sealedSha256: SEALED_UNIX_TERMINAL_SHA256,
    patchedSha256: PATCHED_UNIX_TERMINAL_SHA256,
  }),
  Object.freeze({
    name: '@lydell/node-pty-darwin-x64',
    arch: 'x64',
    upstreamSha256: UPSTREAM_UNIX_TERMINAL_SHA256,
    sealedSha256: SEALED_UNIX_TERMINAL_SHA256,
    patchedSha256: PATCHED_UNIX_TERMINAL_SHA256,
  }),
]);

export const EAGAIN_PACING_COMMENT =
  '/**\n' +
  ' * Nexus: upstream retries EAGAIN with `setImmediate`, which re-attempts within\n' +
  ' * microseconds and pins a core on the PTY host thread when a reader stops\n' +
  ' * draining. 1ms keeps ~97% of that CPU saving; longer delays cost 2-3x delivery\n' +
  ' * time to a reader that drains in bursts (an agent). Re-measure both before\n' +
  ' * changing. (Orca #15319.)\n' +
  ' */\n' +
  'var EAGAIN_RETRY_DELAY_MS = 1;';

const EAGAIN_PACING_BEFORE = 'exports.UnixTerminal = UnixTerminal;\n/**';
const EAGAIN_PACING_AFTER = `exports.UnixTerminal = UnixTerminal;\n${EAGAIN_PACING_COMMENT}\n/**`;

const DISPOSE_BEFORE = [
  '    CustomWriteStream.prototype.dispose = function () {',
  '        clearImmediate(this._writeImmediate);',
  '        this._writeImmediate = undefined;',
  '    };',
].join('\n');
const DISPOSE_AFTER = [
  '    CustomWriteStream.prototype.dispose = function () {',
  '        clearTimeout(this._writeImmediate);',
  '        this._writeImmediate = undefined;',
  '        // Nexus (Orca #15319/#17914): retire this stream\'s copy of the master fd',
  '        // and drop what has not shipped, so nothing queued here reaches a reused',
  '        // descriptor and a pending paced retry cannot fire after dispose.',
  '        this._fd = -1;',
  '        this._writeQueue.length = 0;',
  '    };',
].join('\n');

const WRITE_GUARD_BEFORE = [
  '    CustomWriteStream.prototype.write = function (data) {',
  '        // Writes are put in a queue and processed asynchronously in order to handle',
].join('\n');
const WRITE_GUARD_AFTER = [
  '    CustomWriteStream.prototype.write = function (data) {',
  '        if (this._fd < 0) {',
  '            return;',
  '        }',
  '        // Writes are put in a queue and processed asynchronously in order to handle',
].join('\n');

const PROCESS_GUARD_BEFORE = [
  '        this._writeImmediate = undefined;',
  '        if (this._writeQueue.length === 0) {',
].join('\n');
const PROCESS_GUARD_AFTER = [
  '        this._writeImmediate = undefined;',
  '        // Nexus: an in-flight fs.write can re-enter here after dispose().',
  '        if (this._fd < 0 || this._writeQueue.length === 0) {',
].join('\n');

const EAGAIN_BRANCH_BEFORE = [
  "                    // `setImmediate` is used to yield to the event loop and re-attempt",
  '                    // the write later.',
  '                    _this._writeImmediate = setImmediate(function () { return _this._processWriteQueue(); });',
].join('\n');
const EAGAIN_BRANCH_AFTER = [
  '                    // Nexus: paced, not `setImmediate` (Orca #15319) — a stalled',
  '                    // reader keeps this branch EAGAIN-ing, and an immediate',
  '                    // re-attempt turns the retry into a busy-loop on the PTY host',
  '                    // thread (measured 121k EAGAIN/s at ~100% CPU vs 805/s at ~4%',
  '                    // with 1ms pacing).',
  '                    _this._writeImmediate = setTimeout(function () { return _this._processWriteQueue(); }, EAGAIN_RETRY_DELAY_MS);',
].join('\n');

export const EAGAIN_PACING_MARKERS = Object.freeze([
  'var EAGAIN_RETRY_DELAY_MS = 1;',
  'clearTimeout(this._writeImmediate);',
  'this._fd = -1;',
]);

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`node-pty ${label} source shape is not the pinned upstream shape`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

/** Port of Orca #15319 (+ dispose fd retire from #17914): pace the EAGAIN write
 *  retry at 1ms and retire the master fd on dispose. Throws closed on shape drift. */
export function applyEagainPacing(source) {
  let out = replaceExactlyOnce(source, EAGAIN_PACING_BEFORE, EAGAIN_PACING_AFTER, 'write-loop pacing');
  out = replaceExactlyOnce(out, DISPOSE_BEFORE, DISPOSE_AFTER, 'write-loop dispose');
  out = replaceExactlyOnce(out, WRITE_GUARD_BEFORE, WRITE_GUARD_AFTER, 'write-loop write guard');
  out = replaceExactlyOnce(out, PROCESS_GUARD_BEFORE, PROCESS_GUARD_AFTER, 'write-loop process guard');
  out = replaceExactlyOnce(out, EAGAIN_BRANCH_BEFORE, EAGAIN_BRANCH_AFTER, 'write-loop EAGAIN branch');
  return out;
}

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
  const sealedSha256 = packageSpec.sealedSha256 ?? SEALED_UNIX_TERMINAL_SHA256;
  let patched = false;
  let working = null;

  if (observedHash === packageSpec.upstreamSha256) {
    working = replaceExactlyOnce(
      source.toString('utf8'),
      upstreamHelperSource,
      systemHelperSource,
      'helper seal',
    );
  } else if (observedHash === sealedSha256) {
    working = source.toString('utf8');
  } else if (observedHash !== packageSpec.patchedSha256) {
    throw new Error(
      `${packageSpec.name} unixTerminal.js hash is outside the pinned patch set`,
    );
  }

  if (working !== null) {
    const replacement = applyEagainPacing(working);
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
  }

  const patchedSource = fs.readFileSync(unixTerminalPath, 'utf8');
  if (
    sha256(patchedSource) !== packageSpec.patchedSha256 ||
    !patchedSource.includes(systemHelperSource) ||
    patchedSource.includes('/spawn-helper') ||
    !EAGAIN_PACING_MARKERS.every((marker) => patchedSource.includes(marker))
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
      ? `[node-pty-darwin] sealed ${installed.map((item) => item.packageName).join(', ')} to ${SYSTEM_PERL_HELPER_PATH} + EAGAIN pacing; bundled spawn-helper count=0\n`
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
