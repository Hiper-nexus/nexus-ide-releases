import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertPackagedSmokeProof,
  packagedSmokeArgs,
  packagedSmokeEnvironment,
  packagedSmokeMarkerPath,
  packagedBinaryForApp,
  resolveAppArgument,
} from './smoke-packaged-app.mjs';

describe('packaged app smoke target', () => {
  it('uses an explicit app extracted from a release artifact', () => {
    expect(resolveAppArgument(['--app', '/tmp/release/NexusIDE.app'])).toBe(
      '/tmp/release/NexusIDE.app',
    );
    expect(packagedBinaryForApp('/tmp/release/NexusIDE.app')).toBe(
      path.join('/tmp/release/NexusIDE.app', 'Contents', 'MacOS', 'NexusIDE'),
    );
  });

  it('rejects malformed or non-app targets', () => {
    expect(() => resolveAppArgument(['--app'])).toThrow(/--app/);
    expect(() => packagedBinaryForApp('/tmp/release/NexusIDE')).toThrow(/\.app/);
  });

  it('launches with a positional sentinel and isolated Chromium/user-data paths', () => {
    const userData = '/tmp/nexus-packaged-smoke';

    expect(packagedSmokeArgs(userData)).toEqual([
      'nexus-smoke-test',
      '--user-data-dir=/tmp/nexus-packaged-smoke',
    ]);
    expect(packagedSmokeEnvironment({ PATH: '/bin' }, userData)).toMatchObject({
      PATH: '/bin',
      HOME: '/tmp/nexus-packaged-smoke/home',
      NEXUS_USER_DATA_DIR: userData,
    });
    expect(packagedSmokeMarkerPath(userData)).toBe(
      '/tmp/nexus-packaged-smoke/functional-smoke-workspace/smoke.txt',
    );
  });

  it('requires both a mounted renderer and completed functional probes', () => {
    expect(() =>
      assertPackagedSmokeProof(
        0,
        '[smoke] renderer-mounted\n[smoke] functional-ready: 16 probes, 71 tools, 9 adapters\n',
      ),
    ).not.toThrow();
    expect(() => assertPackagedSmokeProof(0, '[smoke] renderer-mounted\n')).toThrow(
      /functional proof/,
    );
    expect(() => assertPackagedSmokeProof(1, '[smoke] functional-ready\n')).toThrow(
      /exited 1/,
    );
  });
});
