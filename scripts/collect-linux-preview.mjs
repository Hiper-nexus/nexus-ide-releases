import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linuxPackageBasenames } from './collect-linux-release.mjs';

export const PREVIEW_SCHEMA = 'nexus.linux-preview/v1';
export const PREVIEW_RECEIPT = 'linux-preview-receipt.json';
export const PREVIEW_CHECKSUMS = 'SHA256SUMS-linux-x64-preview.txt';
const SHA1 = /^[a-f\d]{40}$/;
const RUN_ID = /^[1-9]\d*$/;
const fail = (message) => { throw new Error(`Linux preview collect: ${message}`); };
function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} failed`);
  return result.stdout.trim();
}
function sha256File(file) {
  const fd = fs.openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

export function collectLinuxPreview({ app, out, environment = process.env, git = (args) => capture('git', args, app), npmVersion = () => capture('npm', ['--version'], app) }) {
  const appDir = path.resolve(app);
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const version = pkg.version;
  const names = linuxPackageBasenames(version);
  const commit = git(['rev-parse', 'HEAD']);
  if (!SHA1.test(commit) || commit !== environment.GITHUB_SHA) fail('checkout commit must match the event source SHA');
  if (!['push', 'pull_request'].includes(environment.GITHUB_EVENT_NAME)) fail('preview accepts only push or pull_request');
  if (!RUN_ID.test(environment.GITHUB_RUN_ID ?? '') || !RUN_ID.test(environment.GITHUB_RUN_ATTEMPT ?? '')) fail('GitHub run identity is required');
  const candidates = [
    [path.join('deb', 'x64'), names.deb],
    [path.join('rpm', 'x64'), names.rpm],
    [path.join('zip', 'linux', 'x64'), names.zip],
  ];
  const payloads = candidates.map(([relative, name]) => {
    const folder = path.join(appDir, 'out', 'make', relative);
    const extension = path.extname(name);
    const listing = fs.readdirSync(folder).filter((entry) => entry.endsWith(extension));
    if (listing.length !== 1 || listing[0] !== name) fail(`unexpected generated ${extension} inventory`);
    const source = path.join(folder, name);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) fail('generated payload must be a non-empty regular file');
    return { source, name, bytes: stat.size, sha256: sha256File(source) };
  });
  const outDir = path.resolve(out);
  if (fs.existsSync(outDir)) fail('preview output directory must not already exist');
  fs.mkdirSync(outDir, { recursive: true });
  for (const payload of payloads) fs.copyFileSync(payload.source, path.join(outDir, payload.name));
  const receipt = {
    schema: PREVIEW_SCHEMA, eligibility: 'preview-only', version, commit,
    event: environment.GITHUB_EVENT_NAME, runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT,
    node: process.versions.node, npm: npmVersion(), runner: 'ubuntu-22.04', arch: 'x64',
    smoke: { packaged: true, debInstalled: true, zipExtracted: true, mode: 'hosted-xvfb-no-sandbox' },
    files: payloads.map(({ source, ...file }) => file),
  };
  fs.writeFileSync(path.join(outDir, PREVIEW_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
  const checksums = [...receipt.files].sort((a, b) => a.name.localeCompare(b.name)).map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, PREVIEW_CHECKSUMS), checksums);
  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--app' || args[2] !== '--out') fail('usage: collect-linux-preview.mjs --app <dir> --out <dir>');
    const receipt = collectLinuxPreview({ app: args[1], out: args[3] });
    process.stdout.write(`[linux-preview] ${receipt.commit}: ${receipt.files.length} payloads, preview only\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
