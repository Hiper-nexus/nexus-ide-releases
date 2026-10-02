import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

function probe(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-zip-proof-'));
  roots.push(root);
  const zip = path.join(root, 'app.zip');
  const fixture = spawnSync('python3', ['-c', `
import json,sys,zipfile,stat,base64
entries=json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], 'w') as z:
  for name,content,kind in entries:
    i=zipfile.ZipInfo(name); i.create_system=3
    i.external_attr=((stat.S_IFLNK if kind=='link' else stat.S_IFREG)|0o755)<<16
    z.writestr(i,base64.b64decode(content) if kind=='elf' else content)
`, zip, JSON.stringify(entries)], { encoding: 'utf8' });
  if (fixture.status !== 0) throw new Error(fixture.stderr);
  return spawnSync('python3', [new URL('./extract-linux-zip.py', import.meta.url).pathname, '--archive', zip, '--out', path.join(root, 'extracted')], { encoding: 'utf8' });
}

describe.skipIf(process.platform !== 'linux')('generated Linux ZIP extraction boundary', () => {
  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(62, 18);
  const binary = ['NexusIDE-linux-x64/nexus-ide', header.toString('base64'), 'elf'];
  it('extracts the Forge root and preserves executable permission and an internal link', () => {
    const result = probe([binary, ['NexusIDE-linux-x64/local', 'nexus-ide', 'link']]);
    expect(result.status).toBe(0);
    expect(fs.statSync(result.stdout.trim()).mode & 0o111).not.toBe(0);
  });
  it.each([
    ['../outside', 'x', 'file'],
    ['/tmp/outside', 'x', 'file'],
    ['NexusIDE-linux-x64/../outside', 'x', 'file'],
    ['NexusIDE-linux-x64/link', '../../outside', 'link'],
    ['NexusIDE-linux-x64/link', '/tmp/outside', 'link'],
  ])('rejects escaping archive entry %s before extraction', (name, content, kind) => {
    expect(probe([binary, [name, content, kind]]).status).not.toBe(0);
  });
  it('rejects files nested beneath symlinks and duplicate paths', () => {
    expect(probe([binary, ['NexusIDE-linux-x64/link', 'inner', 'link'], ['NexusIDE-linux-x64/link/file', 'x', 'file']]).status).not.toBe(0);
    expect(probe([binary, binary]).status).not.toBe(0);
  });
  it('rejects a runnable file of the wrong format or architecture', () => {
    expect(probe([['NexusIDE-linux-x64/nexus-ide', '#!/bin/sh\nexit 0\n', 'file']]).status).not.toBe(0);
    const arm = Buffer.from(header);
    arm.writeUInt16LE(183, 18);
    expect(probe([['NexusIDE-linux-x64/nexus-ide', arm.toString('base64'), 'elf']]).status).not.toBe(0);
  });
});
