import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { createPackage } from '@electron/asar';
import { MakerZIP } from '@electron-forge/maker-zip';
import { describe, expect, it } from 'vitest';
import forgeConfig from '../forge.config';

const FILES = ['LICENSE', 'LICENSES.chromium.html'] as const;
const DIST = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f882-'));
  const staging = path.join(root, 'staging');
  const buildPath = path.join(staging, 'Electron.app', 'Contents', 'Resources', 'app');
  fs.mkdirSync(buildPath, { recursive: true });
  fs.writeFileSync(path.join(buildPath, 'package.json'), '{"name":"fixture","version":"0.76.192"}');
  for (const file of FILES) fs.copyFileSync(path.join(DIST, file), path.join(staging, file));
  return { root, staging, buildPath };
}

async function prune(buildPath: string, version = '43.8.3', platform = 'darwin') {
  const hook = forgeConfig.hooks?.packageAfterPrune;
  if (typeof hook !== 'function') throw new Error('packageAfterPrune hook unavailable');
  await hook(forgeConfig, buildPath, version, platform, 'arm64');
}

describe.runIf(process.platform === 'darwin')('F-882: Electron legal resources before signing', () => {
  it('preserves exact extracted-template texts through the real prune hook, ASAR and Mac ZIP maker', async () => {
    const f = fixture();
    try {
      await prune(f.buildPath);
      const resources = path.dirname(f.buildPath);
      const archive = await createPackage(f.buildPath, path.join(resources, 'app.asar'));
      await finished(archive);
      fs.rmSync(f.buildPath, { recursive: true });
      fs.renameSync(path.join(f.staging, 'Electron.app'), path.join(f.staging, 'NexusIDE.app'));
      const maker = new MakerZIP({});
      await maker.prepareConfig('arm64');
      const [zip] = await maker.make({ dir: f.staging, makeDir: path.join(f.root, 'make'), appName: 'NexusIDE',
        packageJSON: { name: 'fixture', version: '0.76.192' }, targetPlatform: 'darwin', targetArch: 'arm64' });
      const entries = execFileSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n');
      for (const file of FILES) {
        const entry = `NexusIDE.app/Contents/Resources/electron-licenses/${file}`;
        expect(entries).toContain(entry);
        const bytes = execFileSync('/usr/bin/unzip', ['-p', zip, entry], { maxBuffer: 32 * 1024 * 1024 });
        expect(sha(bytes)).toBe(sha(fs.readFileSync(path.join(DIST, file))));
      }
      const receipt = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', zip,
        'NexusIDE.app/Contents/Resources/electron-licenses/manifest.json'], { encoding: 'utf8' }));
      expect(receipt).toMatchObject({ schema: 'nexus.electron-licenses/v1', electronVersion: '43.8.3', platform: 'darwin', arch: 'arm64',
        sourceUrl: 'https://github.com/electron/electron/releases/download/v43.8.3/electron-v43.8.3-darwin-arm64.zip' });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(FILES)('refuses missing extracted-template %s before creating a receipt', async (file) => {
    const f = fixture();
    try {
      fs.unlinkSync(path.join(f.staging, file));
      await expect(prune(f.buildPath)).rejects.toThrow(/Electron.*legal|ENOENT/i);
      expect(fs.existsSync(path.join(path.dirname(f.buildPath), 'electron-licenses', 'manifest.json'))).toBe(false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(FILES)('refuses substituted extracted-template %s', async (file) => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.staging, file), 'MIT\nCopyright Electron\n');
      await expect(prune(f.buildPath)).rejects.toThrow(/Electron.*legal/i);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('refuses an unqualified runtime version instead of claiming 43.8.3 provenance', async () => {
    const f = fixture();
    try { await expect(prune(f.buildPath, '43.0.0')).rejects.toThrow(/Electron.*version/i); }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('leaves the independent non-Mac packaging path unchanged', async () => {
    const f = fixture();
    try {
      await prune(f.buildPath, '43.8.3', 'linux');
      expect(fs.existsSync(path.join(path.dirname(f.buildPath), 'electron-licenses'))).toBe(false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});
