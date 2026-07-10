import { describe, expect, it } from 'vitest';

import {
  electronBinaryPath,
  sanitizeElectronInstallEnvironment,
} from './install-electron.mjs';

describe('Electron installation bootstrap', () => {
  it('keeps only the environment needed to download and unpack Electron', () => {
    const source = {
      PATH: '/safe/bin',
      HOME: '/safe/home',
      HTTPS_PROXY: 'http://proxy.internal:8080',
      NO_PROXY: '127.0.0.1',
      ELECTRON_CACHE: '/safe/cache',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'must-not-reach-installer',
      APPLE_APP_SPECIFIC_PASSWORD: 'must-not-reach-installer',
      NODE_OPTIONS: '--require /tmp/injected.cjs',
      npm_config_userconfig: '/tmp/credential-bearing-npmrc',
    };

    expect(sanitizeElectronInstallEnvironment(source)).toEqual({
      PATH: '/safe/bin',
      HOME: '/safe/home',
      HTTPS_PROXY: 'http://proxy.internal:8080',
      NO_PROXY: '127.0.0.1',
      ELECTRON_CACHE: '/safe/cache',
    });
    expect(source.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
      'must-not-reach-installer',
    );
  });

  it('resolves the platform-specific executable inside the package', () => {
    expect(electronBinaryPath('/repo/electron', 'darwin')).toBe(
      '/repo/electron/dist/Electron.app/Contents/MacOS/Electron',
    );
    expect(electronBinaryPath('/repo/electron', 'linux')).toBe(
      '/repo/electron/dist/electron',
    );
    expect(electronBinaryPath('C:\\repo\\electron', 'win32')).toMatch(
      /electron[\\/]dist[\\/]electron\.exe$/,
    );
  });
});
