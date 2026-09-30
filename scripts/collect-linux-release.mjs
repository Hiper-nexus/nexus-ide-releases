import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs only on the ubuntu-22.04 GitHub runner, after Forge make, the packaged
 * smoke and the deb install proof. Collects the two Linux payloads into the
 * upload directory and writes the release receipt the publisher verifies.
 */
export const RECEIPT_SCHEMA = 'nexus.linux-release/v1';
export const RECEIPT_FILE = 'linux-release-receipt.json';
export const LINUX_RUNNER = 'ubuntu-22.04';
export const LINUX_ARCH = 'x64';

const STABLE = /^\d+\.\d+\.\d+$/u;
const SHA1 = /^[a-f\d]{40}$/u;
const RUN_ID = /^[1-9]\d*$/u;

const fail = (message) => {
  throw new Error(`Linux release collect: ${message}`);
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

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args[0] ?? ''} failed`);
  return String(result.stdout).trim();
}

export function parseCollectArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--app', '--version', '--out'].includes(key) || !value) {
      fail(
        'usage: collect-linux-release.mjs --app <dir> --version <v> --out <dir>',
      );
    }
    options[key.slice(2)] = value;
  }
  if (!options.app || !options.version || !options.out) {
    fail('usage: collect-linux-release.mjs --app <dir> --version <v> --out <dir>');
  }
  return options;
}

/** The exact basenames electron-forge produces for this version on x64. */
export function linuxPackageBasenames(version) {
  if (!STABLE.test(version)) fail(`invalid stable version: ${version}`);
  return {
    deb: `nexus-ide_${version}_amd64.deb`,
    rpm: `nexus-ide-${version}-1.x86_64.rpm`,
  };
}

function oneFile(directory, extension) {
  let entries;
  try {
    entries = fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(extension));
  } catch {
    fail(`missing Forge output directory: ${directory}`);
  }
  if (entries.length !== 1) {
    fail(`expected exactly one ${extension} in ${directory}; found ${entries.length}`);
  }
  return path.join(directory, entries[0]);
}

export function collectLinuxRelease({
  app,
  version,
  out,
  environment = process.env,
  git = (args) => runCapture('git', args, app),
  npmVersion = () => runCapture('npm', ['--version'], app),
}) {
  const appDir = path.resolve(app);
  if (!STABLE.test(version)) fail(`invalid stable version: ${version}`);
  const runId = environment.GITHUB_RUN_ID ?? '';
  const runAttempt = environment.GITHUB_RUN_ATTEMPT ?? '';
  const dispatchSha = environment.GITHUB_SHA ?? '';
  if (!RUN_ID.test(runId) || !RUN_ID.test(runAttempt) || !SHA1.test(dispatchSha)) {
    fail('GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and GITHUB_SHA are required');
  }

  const tag = `refs/tags/v${version}`;
  if (git(['cat-file', '-t', tag]) !== 'tag') {
    fail(`release tag v${version} must be an annotated tag object`);
  }
  const commit = git(['rev-parse', `${tag}^{}`]);
  const tagObject = git(['rev-parse', tag]);
  if (!SHA1.test(commit) || !SHA1.test(tagObject)) {
    fail('release tag does not dereference to a commit');
  }

  const expected = linuxPackageBasenames(version);
  const deb = oneFile(path.join(appDir, 'out', 'make', 'deb', LINUX_ARCH), '.deb');
  const rpm = oneFile(path.join(appDir, 'out', 'make', 'rpm', LINUX_ARCH), '.rpm');
  if (path.basename(deb) !== expected.deb) {
    fail(`unexpected deb name ${path.basename(deb)}; expected ${expected.deb}`);
  }
  if (path.basename(rpm) !== expected.rpm) {
    fail(`unexpected rpm name ${path.basename(rpm)}; expected ${expected.rpm}`);
  }

  const outDir = path.resolve(out);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const files = [deb, rpm].map((source) => {
    const target = path.join(outDir, path.basename(source));
    fs.copyFileSync(source, target);
    return {
      name: path.basename(target),
      bytes: fs.statSync(target).size,
      sha256: sha256File(target),
    };
  });

  const receipt = {
    schema: RECEIPT_SCHEMA,
    version,
    commit,
    tagObject,
    dispatchSha,
    runId,
    runAttempt,
    node: process.versions.node,
    npm: npmVersion(),
    runner: LINUX_RUNNER,
    arch: LINUX_ARCH,
    smoke: { packaged: true, debInstalled: true },
    files,
  };
  const receiptPath = path.join(outDir, RECEIPT_FILE);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(
    `[collect-linux] ${files.map((file) => file.name).join(' + ')} + ${RECEIPT_FILE}\n`,
  );
  return { receipt, outDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseCollectArgs(process.argv.slice(2));
    collectLinuxRelease(args);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[collect-linux] FAIL: ${reason}\n`);
    process.exitCode = 1;
  }
}
