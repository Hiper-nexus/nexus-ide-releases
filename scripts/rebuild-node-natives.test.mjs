import { describe, expect, it } from 'vitest';

import {
  rebuildNodeNatives,
  sanitizeBuildEnvironment,
} from './rebuild-node-natives.mjs';

describe('native rebuild environment', () => {
  it('removes credentials while preserving the build toolchain environment', () => {
    const sanitized = sanitizeBuildEnvironment({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      SDKROOT: '/tmp/sdk',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'secret',
      GH_TOKEN: 'secret',
      OPENAI_API_KEY: 'secret',
      LICENSE_PRIVATE_KEY: 'secret',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      WINDOWS_CERTIFICATE_PASSWORD: 'secret',
    });

    expect(sanitized).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      SDKROOT: '/tmp/sdk',
    });
  });
});

describe('native rebuild process', () => {
  it('runs the npm JavaScript CLI through Node instead of spawning npm.cmd', () => {
    const invocations = [];
    const run = (command, args, options) => {
      invocations.push({ command, args, options });
      return { status: 0, signal: null };
    };

    rebuildNodeNatives(
      {
        npm_execpath: 'C:\\npm\\bin\\npm-cli.js',
        PATH: 'C:\\Windows\\System32',
      },
      run,
      'C:\\node\\node.exe',
    );

    expect(invocations).toEqual([
      expect.objectContaining({
        command: 'C:\\node\\node.exe',
        args: [
          'C:\\npm\\bin\\npm-cli.js',
          'rebuild',
          'better-sqlite3',
        ],
        options: expect.objectContaining({ shell: false }),
      }),
    ]);
  });

  it('fails before spawning when npm did not provide its JavaScript CLI path', () => {
    expect(() => rebuildNodeNatives({}, () => ({ status: 0 }))).toThrow(
      'npm_execpath',
    );
  });
});
