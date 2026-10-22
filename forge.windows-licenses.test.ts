import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import extract from '@electron-internal/extract-zip';
import forgeConfig from './forge.config';

const require = createRequire(import.meta.url);
const template = require('lodash/template') as (source: string) => (data: Record<string, unknown>) => string;

describe.skipIf(process.platform !== 'win32')('Windows installer legal payload', () => {
  it('preserves the Chromium notice through the actual NuGet template and pack step', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-licenses-'));
    try {
      const app = path.join(root, 'app');
      const output = path.join(root, 'packages');
      fs.mkdirSync(app);
      fs.mkdirSync(output);
      fs.mkdirSync(path.join(app, 'resources'));
      fs.mkdirSync(path.join(app, 'locales'));
      fs.writeFileSync(path.join(app, 'app.exe'), 'fixture, never executed');
      fs.writeFileSync(path.join(app, 'Squirrel.exe'), 'fixture, never executed');
      fs.writeFileSync(path.join(app, 'icudtl.dat'), 'fixture data');
      fs.writeFileSync(path.join(app, 'LICENSE'), 'Electron license fixture\n');
      const notices = '<!doctype html>Chromium license fixture\n';
      fs.writeFileSync(path.join(app, 'LICENSES.chromium.html'), notices);
      const configured = forgeConfig.makers?.find(maker => maker instanceof MakerSquirrel) as MakerSquirrel;
      const maker = configured.clone();
      await maker.prepareConfig('x64');
      const installerRoot = path.dirname(require.resolve('electron-winstaller/package.json'));
      const nuspec = template(fs.readFileSync(path.join(installerRoot, 'template.nuspectemplate'), 'utf8'))({
        ...maker.config,
        name: 'nexus_licenses_probe', title: 'License probe', version: '0.0.1',
        authors: 'Test', owners: 'Test', description: 'Packaging test', copyright: 'Test',
        iconUrl: 'https://example.invalid/icon.ico', exe: 'app.exe',
        additionalFiles: maker.config.additionalFiles ?? [],
      });
      const spec = path.join(root, 'probe.nuspec');
      fs.writeFileSync(spec, nuspec);
      execFileSync(path.join(installerRoot, 'vendor', 'nuget.exe'),
        ['pack', spec, '-BasePath', app, '-OutputDirectory', output, '-NoDefaultExcludes'],
        { timeout: 30_000, windowsHide: true, stdio: 'pipe' });
      const extracted = path.join(root, 'extracted');
      await extract(path.join(output, 'nexus_licenses_probe.0.0.1.nupkg'), { dir: extracted });
      const packagedNotice = path.join(extracted, 'lib', 'net45', 'LICENSES.chromium.html');
      expect(fs.existsSync(packagedNotice), 'Chromium notice missing from actual installer payload').toBe(true);
      expect(fs.readFileSync(packagedNotice, 'utf8')).toBe(notices);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
