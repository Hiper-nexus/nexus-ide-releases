import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const execute = promisify(execFile), directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-soak-bundle-unit-'))); directories.push(root);
  const app = path.join(root, 'NexusIDE.app'), archive = path.join(root, 'fixture.zip');
  await fs.mkdir(path.join(app, 'Contents', 'Resources'), { recursive: true });
  await fs.mkdir(path.join(app, 'Contents', 'MacOS'));
  await fs.writeFile(path.join(app, 'Contents', 'Resources', 'app.asar'), 'private byte fixture');
  await fs.writeFile(path.join(app, 'Contents', 'MacOS', 'nexus-ide'), 'private executable fixture', { mode: 0o755 });
  await fs.symlink('Resources/app.asar', path.join(app, 'Contents', 'alias'));
  await execute('python3', ['-c', "import os,stat,sys,zipfile\nfrom pathlib import Path\napp=Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for root,dirs,files in os.walk(app):\n  for name in files:\n   p=Path(root)/name; info=zipfile.ZipInfo(app.name+'/'+p.relative_to(app).as_posix()); info.create_system=3; info.external_attr=p.lstat().st_mode<<16\n   z.writestr(info,os.readlink(p).encode() if p.is_symlink() else p.read_bytes())", app, archive]);
  const compare = async () => JSON.parse((await execute('python3', [fileURLToPath(new URL('./compare-soak-bundle.py', import.meta.url)), app, archive], { timeout: 5000 })).stdout);
  return { app, archive, compare };
}
it('compares all bundle bytes, executable permissions and exact in-bundle links without extraction', async () => {
  const f = await fixture(), result = await f.compare();
  expect(result.files.length).toBe(3); expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(result.files.find(v => v.path.endsWith('alias')).target).toBe('Resources/app.asar');
});
it('refuses modified native/app bytes and additional executable content', async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.app, 'Contents', 'Resources', 'app.asar'), 'other unsealed bytes');
  await expect(f.compare()).rejects.toThrow();
  await fs.writeFile(path.join(f.app, 'Contents', 'Resources', 'app.asar'), 'private byte fixture');
  await fs.writeFile(path.join(f.app, 'Contents', 'MacOS', 'unexpected'), 'extra');
  await expect(f.compare()).rejects.toThrow();
});
it('refuses symlink substitution and duplicate ZIP entries', async () => {
  const f = await fixture(); await fs.unlink(path.join(f.app, 'Contents', 'alias'));
  await fs.symlink('/tmp/foreign', path.join(f.app, 'Contents', 'alias')); await expect(f.compare()).rejects.toThrow();
  await fs.unlink(path.join(f.app, 'Contents', 'alias')); await fs.symlink('Resources/app.asar', path.join(f.app, 'Contents', 'alias'));
  await execute('python3', ['-c', "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'a') as z:z.writestr('NexusIDE.app/Contents/Resources/app.asar','private byte fixture')", f.archive]);
  await expect(f.compare()).rejects.toThrow();
});
