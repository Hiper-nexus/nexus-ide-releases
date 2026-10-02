import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Same real provider version as the Windows packaged smoke prerequisite.
// This installs a CI prerequisite outside the app; it does not bundle a CLI,
// install credentials, execute inference, or relax mission readiness checks.
export const LINUX_SMOKE_CODEX = Object.freeze({
  version: '0.145.0',
  packageVersion: '0.145.0-linux-x64',
  url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.145.0-linux-x64.tgz',
  integrity: 'sha512-u8w8LLv3DvsfrDCoswLIemZ0SoNEXyi511WsfFsSiYUazk9qMsB/NtU8N9vhAfN7mZAxLFoMex4v66JjHuZWwA==',
  archiveBytes: 135637111,
  binarySha256: 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
  binaryRelativePath: 'vendor/x86_64-unknown-linux-musl/bin/codex',
});

function fail(code) {
  throw new Error(code);
}

export async function verifyLinuxCodexArchive(archive) {
  const stat = fs.lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== LINUX_SMOKE_CODEX.archiveBytes) {
    fail('LINUX_CODEX_ARCHIVE_INTEGRITY');
  }
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  if (`sha512-${hash.digest('base64')}` !== LINUX_SMOKE_CODEX.integrity) {
    fail('LINUX_CODEX_ARCHIVE_INTEGRITY');
  }
}

export function validateLinuxCodexPackage(packageRoot) {
  const root = path.resolve(packageRoot);
  const metadataFile = path.join(root, 'package.json');
  const metadataStat = fs.lstatSync(metadataFile);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) fail('LINUX_CODEX_PACKAGE_IDENTITY');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  if (metadata.name !== '@openai/codex' || metadata.version !== LINUX_SMOKE_CODEX.packageVersion ||
      JSON.stringify(metadata.os) !== '["linux"]' || JSON.stringify(metadata.cpu) !== '["x64"]') {
    fail('LINUX_CODEX_PACKAGE_IDENTITY');
  }
  const binary = path.join(root, LINUX_SMOKE_CODEX.binaryRelativePath);
  const binaryStat = fs.lstatSync(binary);
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || (binaryStat.mode & 0o111) === 0 ||
      fs.realpathSync(binary) !== binary) fail('LINUX_CODEX_EXECUTABLE');
  const fd = fs.openSync(binary, 'r');
  const header = Buffer.alloc(20);
  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
        header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 ||
        header[5] !== 1 || header.readUInt16LE(18) !== 62) fail('LINUX_CODEX_ELF_X64');
  } finally {
    fs.closeSync(fd);
  }
  const binarySha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (binarySha256 !== LINUX_SMOKE_CODEX.binarySha256) fail('LINUX_CODEX_BINARY_INTEGRITY');
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-codex-version-'));
  let probe;
  try {
    probe = spawnSync(binary, ['--version'], {
      encoding: 'utf8', timeout: 20000, maxBuffer: 4096, shell: false,
      env: { HOME: probeHome, CODEX_HOME: path.join(probeHome, '.codex'), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
  } finally {
    fs.rmSync(probeHome, { recursive: true, force: true });
  }
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== `codex-cli ${LINUX_SMOKE_CODEX.version}`) {
    fail('LINUX_CODEX_VERSION');
  }
  return { packageRoot: root, binary, binarySha256 };
}

async function downloadArchive(target) {
  const response = await fetch(LINUX_SMOKE_CODEX.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) fail('LINUX_CODEX_DOWNLOAD');
  let bytes = 0;
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > LINUX_SMOKE_CODEX.archiveBytes) callback(new Error('LINUX_CODEX_ARCHIVE_INTEGRITY'));
      else callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), bounded, fs.createWriteStream(target, { flags: 'wx' }));
}

export async function installLinuxSmokeCodex({
  archivePath,
  prefix = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'nexus-linux-smoke-codex'),
  receiptPath = path.resolve('release-artifacts/linux-codex-prerequisite.json'),
  githubPath = process.env.GITHUB_PATH,
  githubEnv = process.env.GITHUB_ENV,
} = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('LINUX_CODEX_HOST');
  let downloadRoot;
  try {
    let archive = archivePath;
    if (!archive) {
      downloadRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'nexus-codex-download-'));
      archive = path.join(downloadRoot, 'codex.tgz');
      await downloadArchive(archive);
    }
    await verifyLinuxCodexArchive(archive);
    // Hash verification precedes extraction; this immutable upstream archive
    // has only regular files under package/, with no scripts or links.
    fs.mkdirSync(prefix, { mode: 0o755 });
    const extract = spawnSync('tar', ['-xzf', path.resolve(archive), '-C', path.resolve(prefix), '--no-same-owner', '--no-same-permissions'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 4096, shell: false,
    });
    if (extract.error || extract.status !== 0) fail('LINUX_CODEX_EXTRACT');
    const installed = validateLinuxCodexPackage(path.join(prefix, 'package'));
    const binDirectory = path.dirname(installed.binary);
    if (/[\r\n]/u.test(installed.packageRoot)) fail('LINUX_CODEX_ENV_PATH');
    const receipt = {
      schema: 'nexus.linux-codex-smoke-prerequisite/v1',
      version: LINUX_SMOKE_CODEX.version,
      packageVersion: LINUX_SMOKE_CODEX.packageVersion,
      source: LINUX_SMOKE_CODEX.url,
      archiveIntegrity: LINUX_SMOKE_CODEX.integrity,
      binarySha256: installed.binarySha256,
      platform: 'linux', arch: 'x64', nativeVersionVerified: true,
      credentialsInstalled: false, inferenceExecuted: false,
    };
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    if (githubPath) fs.appendFileSync(githubPath, `${binDirectory}\n`);
    if (githubEnv) fs.appendFileSync(githubEnv,
      `NEXUS_SMOKE_CODEX_ROOT=${installed.packageRoot}\nNEXUS_SMOKE_CODEX_VERSION=${LINUX_SMOKE_CODEX.version}\nNEXUS_SMOKE_CODEX_SHA256=${installed.binarySha256}\n`);
    return { ...installed, receipt, receiptPath };
  } finally {
    if (downloadRoot) fs.rmSync(downloadRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = {};
  const flags = { '--archive': 'archivePath', '--prefix': 'prefix', '--output': 'receiptPath' };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!flags[args[i]] || !args[i + 1]) fail('LINUX_CODEX_ARGUMENTS');
    options[flags[args[i]]] = args[i + 1];
  }
  const installed = await installLinuxSmokeCodex(options);
  console.log(`[linux-codex-smoke] native codex-cli ${installed.receipt.version}; ELF x64 and integrity verified`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
