import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots = [];
const script = fileURLToPath(new URL('./install-linux-smoke-codex.mjs', import.meta.url));
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-linux-codex-test-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Estes scripts só rodam em host Linux x64 (exigem /bin/true e recusam outro SO
// ou arquitetura: LINUX_CODEX_HOST); o CI Linux x64 os executa.
describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('verified Linux Codex smoke prerequisite', () => {
  it('rejects a tampered archive before extraction or PATH publication', () => {
    const dir = root();
    const archive = path.join(dir, 'untrusted.tgz');
    const prefix = path.join(dir, 'install');
    const githubPath = path.join(dir, 'github-path');
    const githubEnv = path.join(dir, 'github-env');
    fs.writeFileSync(archive, 'untrusted archive bytes');
    const result = spawnSync(process.execPath, [script, '--archive', archive, '--prefix', prefix], {
      env: { ...process.env, GITHUB_PATH: githubPath, GITHUB_ENV: githubEnv }, encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('LINUX_CODEX_ARCHIVE_INTEGRITY');
    expect(fs.existsSync(prefix)).toBe(false);
    expect(fs.existsSync(githubPath)).toBe(false);
    expect(fs.existsSync(githubEnv)).toBe(false);
  });

  it('rejects a foreign platform identity before probing its executable', async () => {
    const { validateLinuxCodexPackage } = await import('./install-linux-smoke-codex.mjs');
    const dir = root();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.145.0-darwin-x64', os: ['darwin'], cpu: ['x64'] }));
    expect(() => validateLinuxCodexPackage(dir)).toThrow(/LINUX_CODEX_PACKAGE_IDENTITY/);
  });

  it('checks the pinned SHA512 even when the archive byte count matches', async () => {
    const { verifyLinuxCodexArchive } = await import('./install-linux-smoke-codex.mjs');
    const dir = root();
    const archive = path.join(dir, 'same-size-untrusted.tgz');
    fs.writeFileSync(archive, 'wrong contents');
    fs.truncateSync(archive, 135637111);
    await expect(verifyLinuxCodexArchive(archive)).rejects.toThrow(/LINUX_CODEX_ARCHIVE_INTEGRITY/);
  });

  it('rejects a symlink executable even when its target is a Linux binary', async () => {
    const { validateLinuxCodexPackage } = await import('./install-linux-smoke-codex.mjs');
    const dir = packageFixture();
    const binary = path.join(dir, 'vendor/x86_64-unknown-linux-musl/bin/codex');
    fs.symlinkSync('/bin/true', binary);
    expect(() => validateLinuxCodexPackage(dir)).toThrow(/LINUX_CODEX_EXECUTABLE/);
  });

  it('rejects an ARM ELF despite an x64 npm package identity', async () => {
    const { validateLinuxCodexPackage } = await import('./install-linux-smoke-codex.mjs');
    const dir = packageFixture();
    const binary = path.join(dir, 'vendor/x86_64-unknown-linux-musl/bin/codex');
    const bytes = fs.readFileSync('/bin/true');
    bytes.writeUInt16LE(183, 18);
    fs.writeFileSync(binary, bytes, { mode: 0o755 });
    expect(() => validateLinuxCodexPackage(dir)).toThrow(/LINUX_CODEX_ELF_X64/);
  });

  it('rejects an unrelated Linux executable with a valid x64 ELF header', async () => {
    const { validateLinuxCodexPackage } = await import('./install-linux-smoke-codex.mjs');
    const dir = packageFixture();
    fs.copyFileSync('/bin/true', path.join(dir, 'vendor/x86_64-unknown-linux-musl/bin/codex'));
    expect(() => validateLinuxCodexPackage(dir)).toThrow(/LINUX_CODEX_BINARY_INTEGRITY/);
  });
});

function packageFixture() {
  const dir = root();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.145.0-linux-x64', os: ['linux'], cpu: ['x64'] }));
  fs.mkdirSync(path.join(dir, 'vendor/x86_64-unknown-linux-musl/bin'), { recursive: true });
  return dir;
}
