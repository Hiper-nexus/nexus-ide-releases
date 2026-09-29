#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_ELECTRON_VERSION = '43.7.4';
const ELECTRON_INSTALL_ENV = new Set([
  'CI',
  'COMSPEC',
  'ELECTRON_CACHE',
  'ELECTRON_CUSTOM_DIR',
  'ELECTRON_CUSTOM_FILENAME',
  'ELECTRON_GET_USE_PROXY',
  'ELECTRON_MIRROR',
  'ELECTRON_USE_REMOTE_CHECKSUMS',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'npm_config_arch',
  'npm_config_platform',
]);

const require = createRequire(import.meta.url);

export function sanitizeElectronInstallEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => ELECTRON_INSTALL_ENV.has(name) && typeof value === 'string',
    ),
  );
}

export function electronBinaryPath(packageRoot, platform = process.platform) {
  if (platform === 'darwin') {
    return path.join(
      packageRoot,
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron',
    );
  }
  return path.join(
    packageRoot,
    'dist',
    platform === 'win32' ? 'electron.exe' : 'electron',
  );
}

function electronPackageRoot() {
  return path.dirname(require.resolve('electron/package.json'));
}

function assertExpectedElectronVersion(packageRoot) {
  const packageJson = JSON.parse(
    readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  if (packageJson.version !== EXPECTED_ELECTRON_VERSION) {
    throw new Error(
      `Electron installer version mismatch: expected ${EXPECTED_ELECTRON_VERSION}`,
    );
  }
}

export function installElectron(environment = process.env) {
  const packageRoot = electronPackageRoot();
  assertExpectedElectronVersion(packageRoot);
  const binaryPath = electronBinaryPath(packageRoot);
  if (existsSync(binaryPath)) return binaryPath;

  const result = spawnSync(process.execPath, [path.join(packageRoot, 'install.js')], {
    cwd: packageRoot,
    env: sanitizeElectronInstallEnvironment(environment),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !existsSync(binaryPath)) {
    throw new Error(
      `Electron binary installation failed (${result.signal ?? result.status ?? 'missing binary'})`,
    );
  }
  return binaryPath;
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) installElectron();
