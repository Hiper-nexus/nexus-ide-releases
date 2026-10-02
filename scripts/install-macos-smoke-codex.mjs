import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// An external, credential-free CI prerequisite. Nothing is bundled in Nexus.
export const MACOS_SMOKE_CODEX = Object.freeze({
  version: '0.145.0',
  packageVersion: '0.145.0-darwin-arm64',
  url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.145.0-darwin-arm64.tgz',
  integrity: 'sha512-h6aQ0UxnaP8mIM/9/qPAH9MNkRliJo88toq1T36IxNM2L5JSU0TFamu+MZn7YkFgDsrp0RfiI+97Tm8AVVxqtA==',
  archiveBytes: 124209892,
  binarySha256: '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590',
  binaryRelativePath: 'vendor/aarch64-apple-darwin/bin/codex',
  tarPaths: Object.freeze([
    'package/vendor/aarch64-apple-darwin/bin/codex',
    'package/vendor/aarch64-apple-darwin/bin/codex-code-mode-host',
    'package/vendor/aarch64-apple-darwin/codex-path/rg',
    'package/vendor/aarch64-apple-darwin/codex-resources/zsh/bin/zsh',
    'package/vendor/aarch64-apple-darwin/codex-package.json',
    'package/package.json',
    'package/README.md',
  ]),
});
const MAX_TAR_BYTES = 323000000;
function fail(code) { throw new Error(code); }

export function validateMacosCodexMetadata(metadata) {
  if (metadata?.name !== '@openai/codex' || metadata.version !== MACOS_SMOKE_CODEX.packageVersion ||
      JSON.stringify(metadata.os) !== '["darwin"]' || JSON.stringify(metadata.cpu) !== '["arm64"]' ||
      (metadata.scripts !== undefined && Object.keys(metadata.scripts).length !== 0)) {
    fail('MACOS_CODEX_PACKAGE_IDENTITY');
  }
}
function tarString(header, start, length) {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString('utf8');
}
function tarNumber(header, start, length) {
  const text = tarString(header, start, length).trim();
  if (!/^[0-7]+$/u.test(text)) fail('MACOS_CODEX_TAR_ENTRY');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail('MACOS_CODEX_TAR_ENTRY');
  return value;
}

// Validate the verified archive before handing it to the host's tar command.
// The immutable upstream package has seven regular files and no tar extensions.
export function inspectMacosCodexTar(tar) {
  if (!Buffer.isBuffer(tar) || tar.length > MAX_TAR_BYTES || tar.length % 512 !== 0) fail('MACOS_CODEX_TAR_ENTRY');
  const seen = new Set(); const entries = [];
  let offset = 0; let metadata; let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset).every((b) => b === 0)) fail('MACOS_CODEX_TAR_ENTRY');
      ended = true; break;
    }
    const checksum = tarNumber(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== checksum) fail('MACOS_CODEX_TAR_CHECKSUM');
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const type = header[156];
    const mode = tarNumber(header, 100, 8);
    const size = tarNumber(header, 124, 12);
    if ((type !== 0 && type !== 48) || tarString(header, 157, 100) !== '' || (mode & 0o7000) !== 0 ||
        !MACOS_SMOKE_CODEX.tarPaths.includes(entryPath) || seen.has(entryPath) ||
        path.posix.normalize(entryPath) !== entryPath || entryPath.includes('\\') ||
        size > MAX_TAR_BYTES || offset + 512 + size > tar.length) fail('MACOS_CODEX_TAR_ENTRY');
    seen.add(entryPath); entries.push({ path: entryPath, bytes: size });
    if (entryPath === 'package/package.json') {
      if (size > 65536) fail('MACOS_CODEX_PACKAGE_IDENTITY');
      try { metadata = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8')); }
      catch { fail('MACOS_CODEX_PACKAGE_IDENTITY'); }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || seen.size !== MACOS_SMOKE_CODEX.tarPaths.length) fail('MACOS_CODEX_TAR_ENTRY');
  validateMacosCodexMetadata(metadata);
  return { entries, metadata };
}

export async function verifyMacosCodexArchive(archive) {
  const stat = fs.lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== MACOS_SMOKE_CODEX.archiveBytes) fail('MACOS_CODEX_ARCHIVE_INTEGRITY');
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  if (`sha512-${hash.digest('base64')}` !== MACOS_SMOKE_CODEX.integrity) fail('MACOS_CODEX_ARCHIVE_INTEGRITY');
  const tar = gunzipSync(fs.readFileSync(archive), { maxOutputLength: MAX_TAR_BYTES });
  return inspectMacosCodexTar(tar);
}

export function assertMacosCodexHeader(header) {
  if (header.length < 32 || header.readUInt32LE(0) !== 0xfeedfacf ||
      header.readUInt32LE(4) !== 0x0100000c || header.readUInt32LE(12) !== 2) fail('MACOS_CODEX_MACHO_ARM64');
}
export function validateMacosCodexPackage(packageRoot) {
  const root = path.resolve(packageRoot); const metadataPath = path.join(root, 'package.json');
  const stat = fs.lstatSync(metadataPath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('MACOS_CODEX_PACKAGE_IDENTITY');
  validateMacosCodexMetadata(JSON.parse(fs.readFileSync(metadataPath, 'utf8')));
  const binary = path.join(root, MACOS_SMOKE_CODEX.binaryRelativePath); const binaryStat = fs.lstatSync(binary);
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || (binaryStat.mode & 0o111) === 0 || fs.realpathSync(binary) !== binary) fail('MACOS_CODEX_EXECUTABLE');
  const fd = fs.openSync(binary, 'r'); const header = Buffer.alloc(32);
  try { if (fs.readSync(fd, header, 0, 32, 0) !== 32) fail('MACOS_CODEX_MACHO_ARM64'); }
  finally { fs.closeSync(fd); }
  assertMacosCodexHeader(header);
  const binarySha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (binarySha256 !== MACOS_SMOKE_CODEX.binarySha256) fail('MACOS_CODEX_BINARY_INTEGRITY');
  return { packageRoot: root, binary, binarySha256 };
}

async function downloadArchive(target) {
  const response = await fetch(MACOS_SMOKE_CODEX.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) fail('MACOS_CODEX_DOWNLOAD');
  let bytes = 0;
  const bound = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > MACOS_SMOKE_CODEX.archiveBytes) callback(new Error('MACOS_CODEX_ARCHIVE_INTEGRITY'));
    else callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), bound, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
}

export async function installMacosSmokeCodex({
  archivePath, prefix = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'nexus-macos-smoke-codex'),
  receiptPath = path.resolve('release-artifacts/macos-codex-prerequisite.json'), githubPath = process.env.GITHUB_PATH,
} = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('MACOS_CODEX_HOST');
  let downloadRoot;
  try {
    let archive = archivePath;
    if (!archive) {
      downloadRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'nexus-mac-codex-download-'));
      fs.chmodSync(downloadRoot, 0o700); archive = path.join(downloadRoot, 'codex.tgz'); await downloadArchive(archive);
    }
    await verifyMacosCodexArchive(archive);
    fs.mkdirSync(prefix, { mode: 0o700 });
    const installPrefix = fs.realpathSync(prefix);
    const extracted = spawnSync('tar', ['-xzf', path.resolve(archive), '-C', installPrefix], { encoding: 'utf8', timeout: 30000, maxBuffer: 4096, shell: false });
    if (extracted.error || extracted.status !== 0) fail('MACOS_CODEX_EXTRACT');
    const installed = validateMacosCodexPackage(path.join(installPrefix, 'package'));
    const probeHome = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'nexus-mac-codex-version-'));
    fs.chmodSync(probeHome, 0o700);
    let probe;
    try { probe = spawnSync(installed.binary, ['--version'], { encoding: 'utf8', timeout: 20000, maxBuffer: 4096, shell: false,
      env: { HOME: probeHome, CODEX_HOME: path.join(probeHome, '.codex'), PATH: '/usr/bin:/bin', LANG: 'C' }, }); }
    finally { fs.rmSync(probeHome, { recursive: true, force: true }); }
    if (probe.error || probe.status !== 0 || probe.stdout.trim() !== `codex-cli ${MACOS_SMOKE_CODEX.version}`) fail('MACOS_CODEX_VERSION');
    const binDirectory = path.dirname(installed.binary);
    if (/[\r\n]/u.test(binDirectory)) fail('MACOS_CODEX_ENV_PATH');
    const receipt = { schema: 'nexus.macos-codex-smoke-prerequisite/v1', version: MACOS_SMOKE_CODEX.version,
      packageVersion: MACOS_SMOKE_CODEX.packageVersion, source: MACOS_SMOKE_CODEX.url,
      archiveIntegrity: MACOS_SMOKE_CODEX.integrity, binarySha256: installed.binarySha256,
      platform: 'darwin', arch: 'arm64', nativeVersionVerified: true, archiveEntriesVerified: true,
      credentialsInstalled: false, inferenceExecuted: false, };
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    if (githubPath) fs.appendFileSync(githubPath, `${binDirectory}\n`);
    return { ...installed, receipt, receiptPath };
  } finally { if (downloadRoot) fs.rmSync(downloadRoot, { recursive: true, force: true }); }
}

async function main() {
  const options = {}; const flags = { '--archive': 'archivePath', '--prefix': 'prefix', '--output': 'receiptPath' }; const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) { if (!flags[args[i]] || !args[i + 1]) fail('MACOS_CODEX_ARGUMENTS'); options[flags[args[i]]] = args[i + 1]; }
  const installed = await installMacosSmokeCodex(options);
  console.log(`[macos-codex-smoke] native codex-cli ${installed.receipt.version}; ARM64 Mach-O and integrity verified`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
