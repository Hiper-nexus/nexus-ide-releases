import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MACOS_SMOKE_CODEX, assertMacosCodexHeader, inspectMacosCodexTar,
  installMacosSmokeCodex, validateMacosCodexMetadata,
  validateMacosCodexPackage, verifyMacosCodexArchive,
} from './install-macos-smoke-codex.mjs';

const roots = [];
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mac-codex-test-'));
  roots.push(dir);
  return fs.realpathSync(dir);
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const metadata = () => ({ name: '@openai/codex', version: '0.145.0-darwin-arm64', os: ['darwin'], cpu: ['arm64'] });

function tarEntry(name, content = Buffer.alloc(0), type = '0') {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.fill(32, 148, 156);
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
function archive(extra = [], replace = {}) {
  return Buffer.concat([
    ...MACOS_SMOKE_CODEX.tarPaths.map((name) => tarEntry(name,
      name === 'package/package.json' ? JSON.stringify(replace.metadata ?? metadata()) : 'fixture',
      replace[name] ?? '0')),
    ...extra,
    Buffer.alloc(1024),
  ]);
}
function macho(cpu = 0x0100000c) {
  const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4); b.writeUInt32LE(2, 12); return b;
}

describe('verified macOS ARM64 Codex prerequisite', () => {
  it('accepts only the expected regular-file vendor tree and package identity', () => {
    expect(inspectMacosCodexTar(archive()).entries.map((e) => e.path)).toEqual([...MACOS_SMOKE_CODEX.tarPaths]);
  });
  it.each(['package/../escape', '/absolute', 'package\\escape', 'package/unexpected.sh'])('rejects unsafe or additional archive path %s', (name) => {
    expect(() => inspectMacosCodexTar(archive([tarEntry(name, 'bad')]))).toThrow(/MACOS_CODEX_TAR_ENTRY/);
  });
  it.each(['1', '2', '3', '6', 'x', 'g'])('rejects tar links and special entry type %s before extraction', (type) => {
    expect(() => inspectMacosCodexTar(archive([], { [MACOS_SMOKE_CODEX.tarPaths[0]]: type }))).toThrow(/MACOS_CODEX_TAR_ENTRY/);
  });
  it('rejects duplicate entries and invalid checksums', () => {
    expect(() => inspectMacosCodexTar(archive([tarEntry(MACOS_SMOKE_CODEX.tarPaths[0], 'duplicate')]))).toThrow(/MACOS_CODEX_TAR_ENTRY/);
    const corrupted = archive(); corrupted[0] ^= 1;
    expect(() => inspectMacosCodexTar(corrupted)).toThrow(/MACOS_CODEX_TAR_CHECKSUM/);
  });
  it('rejects lifecycle scripts and a foreign platform identity before extraction', () => {
    expect(() => inspectMacosCodexTar(archive([], { metadata: { ...metadata(), scripts: { install: 'untrusted' } } }))).toThrow(/MACOS_CODEX_PACKAGE_IDENTITY/);
    expect(() => validateMacosCodexMetadata({ ...metadata(), cpu: ['x64'] })).toThrow(/MACOS_CODEX_PACKAGE_IDENTITY/);
  });
  it('checks the pinned SHA512 when the byte count matches', async () => {
    const file = path.join(root(), 'same-size-untrusted.tgz'); fs.writeFileSync(file, 'wrong'); fs.truncateSync(file, MACOS_SMOKE_CODEX.archiveBytes);
    await expect(verifyMacosCodexArchive(file)).rejects.toThrow(/MACOS_CODEX_ARCHIVE_INTEGRITY/);
  });
  it('rejects symlink executables and non-ARM64 Mach-O headers', () => {
    expect(() => assertMacosCodexHeader(macho())).not.toThrow();
    expect(() => assertMacosCodexHeader(macho(0x01000007))).toThrow(/MACOS_CODEX_MACHO_ARM64/);
    expect(() => assertMacosCodexHeader(Buffer.from('not Mach-O'))).toThrow(/MACOS_CODEX_MACHO_ARM64/);
    const dir = root(); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(metadata()));
    const binary = path.join(dir, MACOS_SMOKE_CODEX.binaryRelativePath); fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.symlinkSync('/bin/true', binary);
    expect(() => validateMacosCodexPackage(dir)).toThrow(/MACOS_CODEX_EXECUTABLE/);
  });
  it('rejects an unrelated executable despite a valid ARM64 header', () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(metadata()));
    const binary = path.join(dir, MACOS_SMOKE_CODEX.binaryRelativePath); fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, macho(), { mode: 0o755 });
    expect(() => validateMacosCodexPackage(dir)).toThrow(/MACOS_CODEX_BINARY_INTEGRITY/);
  });
  it('cannot install or publish PATH on a foreign host', async () => {
    if (process.platform === 'darwin' && process.arch === 'arm64') return;
    const dir = root(); const prefix = path.join(dir, 'install'); const githubPath = path.join(dir, 'github-path');
    await expect(installMacosSmokeCodex({ prefix, githubPath })).rejects.toThrow(/MACOS_CODEX_HOST/);
    expect(fs.existsSync(prefix)).toBe(false); expect(fs.existsSync(githubPath)).toBe(false);
  });
});
