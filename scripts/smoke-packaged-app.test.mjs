import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPackage } from '@electron/asar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FUNCTIONAL_SMOKE_MARKER_CONTENT,
  assertFunctionalMarker,
  assertPackagedMainBundleBootable,
  inspectPackagedLegalArtifacts,
  inspectPackagedWakeModel,
  assertNativeArtifactsPresent,
  assertNoNativeLoadFailure,
  assertPackagedSmokeProof,
  defaultPackagedTargetPath,
  formatValidationMatrix,
  killProcessTree,
  packagedBinaryForApp,
  packagedSmokeArgs,
  packagedSmokeEnvironment,
  packagedSmokeMarkerPath,
  packagedSmokeSpawnOptions,
  packagedSmokeValidationMatrix,
  requiredNativeArtifactGlobs,
  resolveAppArgument,
  resolvePackagedTarget,
  runPackagedSmoke,
} from './smoke-packaged-app.mjs';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTemp(prefix = 'nexus-smoke-unit-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTree(root, relativeFiles) {
  for (const relative of relativeFiles) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'native');
    if (path.basename(full) === 'spawn-helper') fs.chmodSync(full, 0o755);
  }
}

describe('resolveAppArgument / default targets', () => {
  it('uses an explicit --app path', () => {
    expect(resolveAppArgument(['--app', '/tmp/release/NexusIDE.app'])).toBe(
      path.resolve('/tmp/release/NexusIDE.app'),
    );
  });

  it('rejects malformed CLI usage', () => {
    expect(() => resolveAppArgument(['--app'])).toThrow(/--app/);
    expect(() => resolveAppArgument(['--foo', 'bar'])).toThrow(/usage/);
  });

  it('resolves default forge outputs for macOS, Linux, and Windows', () => {
    const cwd = '/repo';
    expect(
      defaultPackagedTargetPath({ platform: 'darwin', arch: 'arm64', cwd }),
    ).toBe(path.join(cwd, 'out/NexusIDE-darwin-arm64/NexusIDE.app'));
    expect(
      defaultPackagedTargetPath({ platform: 'linux', arch: 'x64', cwd }),
    ).toBe(path.join(cwd, 'out/NexusIDE-linux-x64/nexus-ide'));
    expect(
      defaultPackagedTargetPath({ platform: 'win32', arch: 'x64', cwd }),
    ).toBe(path.join(cwd, 'out/NexusIDE-win32-x64/nexus-ide.exe'));
  });

  it('rejects unsupported platform/arch for defaults', () => {
    expect(() =>
      defaultPackagedTargetPath({ platform: 'freebsd', arch: 'x64' }),
    ).toThrow(/unsupported/);
    expect(() =>
      defaultPackagedTargetPath({ platform: 'darwin', arch: 'ia32' }),
    ).toThrow(/unsupported/);
  });
});

describe('resolvePackagedTarget / packagedBinaryForApp', () => {
  it('resolves macOS .app binary and unpacked natives root', () => {
    const target = resolvePackagedTarget('/tmp/release/NexusIDE.app', {
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(target.binary).toBe(
      path.join('/tmp/release/NexusIDE.app', 'Contents', 'MacOS', 'nexus-ide'),
    );
    expect(target.unpackedRoot).toBe(
      path.join(
        '/tmp/release/NexusIDE.app',
        'Contents',
        'Resources',
        'app.asar.unpacked',
      ),
    );
    expect(packagedBinaryForApp('/tmp/release/NexusIDE.app', 'darwin')).toBe(
      target.binary,
    );
  });

  it('resolves macOS package directory containing .app', () => {
    const root = makeTemp();
    const app = path.join(root, 'NexusIDE.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'nexus-ide'), '');
    const target = resolvePackagedTarget(root, {
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(target.appPath).toBe(app);
    expect(target.binary).toBe(path.join(app, 'Contents', 'MacOS', 'nexus-ide'));
  });

  it('rejects non-app macOS targets without nested bundle', () => {
    expect(() =>
      resolvePackagedTarget('/tmp/release/NexusIDE', {
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toThrow(/\.app/);
  });

  it('resolves Linux package directory and executable path', () => {
    const packageDir = path.resolve('/out/NexusIDE-linux-x64');
    const dirTarget = resolvePackagedTarget(packageDir, {
      platform: 'linux',
      arch: 'x64',
    });
    expect(dirTarget.binary).toBe(path.join(packageDir, 'nexus-ide'));
    expect(dirTarget.unpackedRoot).toBe(
      path.join(packageDir, 'resources', 'app.asar.unpacked'),
    );

    const root = makeTemp();
    const realPackage = path.join(root, 'NexusIDE-linux-x64');
    fs.mkdirSync(path.join(realPackage, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(realPackage, 'nexus-ide'), '');
    const fileTarget = resolvePackagedTarget(
      path.join(realPackage, 'nexus-ide'),
      { platform: 'linux', arch: 'x64' },
    );
    expect(fileTarget.binary).toBe(path.join(realPackage, 'nexus-ide'));
    expect(fileTarget.packageDir).toBe(realPackage);
  });

  it('resolves Windows package directory and .exe path', () => {
    const packageDir = path.resolve('/out/NexusIDE-win32-x64');
    const dirTarget = resolvePackagedTarget(packageDir, {
      platform: 'win32',
      arch: 'x64',
    });
    expect(dirTarget.binary).toBe(path.join(packageDir, 'nexus-ide.exe'));
    expect(dirTarget.unpackedRoot).toBe(
      path.join(packageDir, 'resources', 'app.asar.unpacked'),
    );

    const exePath = path.join(packageDir, 'nexus-ide.exe');
    const exeTarget = resolvePackagedTarget(exePath, {
      platform: 'win32',
      arch: 'x64',
    });
    expect(exeTarget.binary).toBe(exePath);
    expect(exeTarget.packageDir).toBe(packageDir);
  });
});

describe('isolation args and environment', () => {
  it('launches with positional sentinel and Chromium user-data switch', () => {
    const userData = '/tmp/nexus-packaged-smoke';
    expect(packagedSmokeArgs(userData)).toEqual([
      'nexus-smoke-test',
      '--user-data-dir=/tmp/nexus-packaged-smoke',
    ]);
  });

  it('isolates filesystem defaults and strips secrets/injection variables', () => {
    const userData = '/tmp/nexus-packaged-smoke';
    const env = packagedSmokeEnvironment(
      {
        PATH: '/bin',
        FOO: 'bar',
        OPENAI_API_KEY: 'secret',
        GITHUB_TOKEN: 'secret',
        NODE_OPTIONS: '--require /tmp/inject.js',
        NEXUS_BACKEND_URL: 'https://production.example',
        NEXUS_SYNC_BACKEND_URL: 'https://sync.production.example',
        NEXUS_SYNC_ALLOW_INSECURE_LOCALHOST_TEST: '1',
      },
      userData,
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      FOO: 'bar',
      HOME: '/tmp/nexus-packaged-smoke/home',
      USERPROFILE: '/tmp/nexus-packaged-smoke/home',
      APPDATA: path.join('/tmp/nexus-packaged-smoke/home', 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(
        '/tmp/nexus-packaged-smoke/home',
        'AppData',
        'Local',
      ),
      TEMP: '/tmp/nexus-packaged-smoke/tmp',
      TMP: '/tmp/nexus-packaged-smoke/tmp',
      TMPDIR: '/tmp/nexus-packaged-smoke/tmp',
      NEXUS_USER_DATA_DIR: userData,
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('NEXUS_BACKEND_URL');
    expect(env).not.toHaveProperty('NEXUS_SYNC_BACKEND_URL');
    expect(env).not.toHaveProperty(
      'NEXUS_SYNC_ALLOW_INSECURE_LOCALHOST_TEST',
    );
  });

  it('spawns without shell and detaches only on POSIX', () => {
    const userData = '/tmp/nexus-packaged-smoke';
    expect(packagedSmokeSpawnOptions(userData, {}, 'darwin')).toMatchObject({
      shell: false,
      detached: true,
      windowsHide: false,
    });
    expect(packagedSmokeSpawnOptions(userData, {}, 'linux')).toMatchObject({
      shell: false,
      detached: true,
    });
    expect(packagedSmokeSpawnOptions(userData, {}, 'win32')).toMatchObject({
      shell: false,
      detached: false,
      windowsHide: true,
    });
  });

  it('computes the functional marker path under isolated userData', () => {
    expect(packagedSmokeMarkerPath('/tmp/nexus-packaged-smoke')).toBe(
      '/tmp/nexus-packaged-smoke/functional-smoke-workspace/smoke.txt',
    );
  });
});

describe('proofs: renderer, functional, marker, natives', () => {
  it('requires the pinned default PT-BR wake model in packaged resources', async () => {
    const resources = makeTemp('nexus-smoke-wake-');
    const wakeDir = path.join(resources, 'wake');
    fs.mkdirSync(wakeDir, { recursive: true });
    const model = Buffer.from('required-ptbr-model');
    const sha256 = createHash('sha256').update(model).digest('hex');
    fs.writeFileSync(path.join(wakeDir, 'ei-jarvis-ptbr.onnx'), model);
    fs.writeFileSync(path.join(wakeDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      defaultModel: {
        file: 'ei-jarvis-ptbr.onnx',
        locale: 'pt-BR',
        required: true,
        sha256,
        wakePhrase: 'Ei Jarvis',
      },
    }));

    await expect(inspectPackagedWakeModel(resources)).resolves.toMatchObject({
      sha256,
      bytes: model.length,
    });
    fs.rmSync(path.join(wakeDir, 'ei-jarvis-ptbr.onnx'));
    await expect(inspectPackagedWakeModel(resources)).rejects.toThrow(/wake model/i);
  });

  it('rejects a main bundle that rewrites import.meta.url to undefined', () => {
    const broken = Buffer.from(
      'const req=(0,node_module.createRequire)({}.url);req.resolve("asset");',
    );

    expect(() => assertPackagedMainBundleBootable(broken)).toThrow(
      /createRequire.*undefined.*import\.meta\.url/iu,
    );
  });

  it('accepts a main bundle with an absolute createRequire base', () => {
    const healthy = Buffer.from(
      'const req=(0,node_module.createRequire)(__filename);req.resolve("asset");',
    );

    expect(() => assertPackagedMainBundleBootable(healthy)).not.toThrow();
  });

  it('requires notices plus Apache and OFL texts inside app.asar', async () => {
    const root = makeTemp('nexus-smoke-legal-');
    const source = path.join(root, 'source');
    const resources = path.join(root, 'resources');
    fs.mkdirSync(path.join(source, 'third_party', 'licenses'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(source, 'THIRD_PARTY_NOTICES.md'),
      '## Onlook CSS-to-Tailwind translator\nonlook-dev/onlook\n',
    );
    fs.writeFileSync(
      path.join(source, 'third_party', 'licenses', 'Apache-2.0.txt'),
      'Apache License 2.0',
    );
    fs.writeFileSync(
      path.join(source, 'third_party', 'licenses', 'OFL-1.1.txt'),
      'SIL Open Font License 1.1',
    );
    fs.mkdirSync(resources, { recursive: true });
    await createPackage(source, path.join(resources, 'app.asar'));

    expect(() => inspectPackagedLegalArtifacts(resources)).not.toThrow();
  });

  it('fails closed when a declared packaged license is absent', async () => {
    const root = makeTemp('nexus-smoke-legal-missing-');
    const source = path.join(root, 'source');
    const resources = path.join(root, 'resources');
    fs.mkdirSync(path.join(source, 'third_party', 'licenses'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(source, 'THIRD_PARTY_NOTICES.md'),
      '## Onlook CSS-to-Tailwind translator\nonlook-dev/onlook\n',
    );
    fs.writeFileSync(
      path.join(source, 'third_party', 'licenses', 'Apache-2.0.txt'),
      'Apache License 2.0',
    );
    fs.mkdirSync(resources, { recursive: true });
    await createPackage(source, path.join(resources, 'app.asar'));

    expect(() => inspectPackagedLegalArtifacts(resources)).toThrow(
      /legal artifacts are incomplete/i,
    );
  });

  it('requires both renderer-mounted and functional-ready', () => {
    expect(() =>
      assertPackagedSmokeProof(
        0,
        '[smoke] renderer-mounted\n[smoke] functional-ready: 20 probes, 71 tools, 9 adapters\n',
      ),
    ).not.toThrow();
    expect(() => assertPackagedSmokeProof(0, '[smoke] renderer-mounted\n')).toThrow(
      /functional proof/,
    );
    expect(() => assertPackagedSmokeProof(1, '[smoke] functional-ready\n')).toThrow(
      /exited 1/,
    );
  });

  it('rejects native load failures even when exit code is 0', () => {
    expect(() =>
      assertNoNativeLoadFailure(
        'Error: The module was compiled against a different Node.js version',
      ),
    ).toThrow(/native module load failure/);
    expect(() =>
      assertPackagedSmokeProof(
        0,
        '[smoke] renderer-mounted\n[smoke] functional-ready\nCannot find module \'better-sqlite3\'\n',
      ),
    ).toThrow(/native module load failure/);
  });

  it('validates functional marker content', async () => {
    const userData = makeTemp();
    const marker = packagedSmokeMarkerPath(userData);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
    await expect(assertFunctionalMarker(userData)).resolves.toBe(marker);

    fs.writeFileSync(marker, 'wrong\n');
    await expect(assertFunctionalMarker(userData)).rejects.toThrow(/mismatch/);
  });

  it('lists required native artifacts per platform (spawn-helper only on POSIX)', () => {
    const darwin = requiredNativeArtifactGlobs({
      platform: 'darwin',
      arch: 'arm64',
    }).map((s) => s.id);
    const linux = requiredNativeArtifactGlobs({
      platform: 'linux',
      arch: 'x64',
    }).map((s) => s.id);
    const win = requiredNativeArtifactGlobs({
      platform: 'win32',
      arch: 'x64',
    }).map((s) => s.id);

    expect(darwin).toEqual(
      expect.arrayContaining([
        'webrtc-aec3-wasm',
        'tesseract-worker',
        'tesseract-core',
        'tesseract-wasm-feature-detect',
        'better-sqlite3',
        'node-pty',
        'node-pty-spawn-helper',
        'onnxruntime-node',
      ]),
    );
    expect(linux).toContain('node-pty-spawn-helper');
    expect(win).not.toContain('node-pty-spawn-helper');
    expect(win).toEqual(
      expect.arrayContaining(['webrtc-aec3-wasm', 'tesseract-worker', 'tesseract-core', 'tesseract-wasm-feature-detect', 'better-sqlite3', 'node-pty', 'onnxruntime-node']),
    );
  });

  it('asserts native artifacts for darwin/linux/win32 fixture trees', async () => {
    for (const { platform, arch } of [
      { platform: 'darwin', arch: 'arm64' },
      { platform: 'linux', arch: 'x64' },
      { platform: 'win32', arch: 'x64' },
    ]) {
      const unpacked = makeTemp(`unpacked-${platform}-`);
      const files = [
        'node_modules/@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm',
        'node_modules/tesseract.js/src/worker-script/node/index.js',
        'node_modules/tesseract.js-core/index.js',
        'node_modules/wasm-feature-detect/dist/cjs/index.cjs',
        'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        `node_modules/@lydell/node-pty-${platform}-${arch}/prebuilds/${platform}-${arch}/pty.node`,
        `node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime_binding.node`,
      ];
      if (platform !== 'win32') {
        files.push(
          `node_modules/@lydell/node-pty-${platform}-${arch}/prebuilds/${platform}-${arch}/spawn-helper`,
        );
      }
      writeTree(unpacked, files);
      const found = await assertNativeArtifactsPresent(unpacked, {
        platform,
        arch,
      });
      expect(found['better-sqlite3']).toMatch(/better_sqlite3\.node$/);
      expect(found['webrtc-aec3-wasm']).toMatch(/webrtcaec3-0\.3\.0\.wasm$/);
      expect(found['node-pty']).toMatch(/pty\.node$/);
      expect(found['onnxruntime-node']).toMatch(/onnxruntime_binding\.node$/);
      if (platform !== 'win32') {
        expect(found['node-pty-spawn-helper']).toMatch(/spawn-helper$/);
      }
    }
  });

  it('fails when a required native artifact is missing', async () => {
    const unpacked = makeTemp();
    writeTree(unpacked, [
      'node_modules/@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm',
      'node_modules/tesseract.js/src/worker-script/node/index.js',
      'node_modules/tesseract.js-core/index.js',
      'node_modules/wasm-feature-detect/dist/cjs/index.cjs',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    ]);
    await expect(
      assertNativeArtifactsPresent(unpacked, {
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).rejects.toThrow(/missing/);
  });

  it('fails when the POSIX node-pty helper is not executable', async () => {
    const unpacked = makeTemp();
    writeTree(unpacked, [
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node',
      'node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/spawn-helper',
      'node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node',
    ]);
    fs.chmodSync(
      path.join(
        unpacked,
        'node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/spawn-helper',
      ),
      0o644,
    );
    await expect(
      assertNativeArtifactsPresent(unpacked, {
        platform: 'linux',
        arch: 'x64',
      }),
    ).rejects.toThrow(/not executable/);
  });

  it('accepts better-sqlite3 prebuild bin layout via scan fallback', async () => {
    const unpacked = makeTemp();
    writeTree(unpacked, [
      'node_modules/@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm',
      'node_modules/tesseract.js/src/worker-script/node/index.js',
      'node_modules/tesseract.js-core/index.js',
      'node_modules/wasm-feature-detect/dist/cjs/index.cjs',
      'node_modules/better-sqlite3/bin/darwin-arm64-148/better-sqlite3.node',
      'node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/pty.node',
      'node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper',
      'node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node',
    ]);
    const found = await assertNativeArtifactsPresent(unpacked, {
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(found['better-sqlite3']).toMatch(/better-sqlite3\.node$/);
  });
});

describe('process tree termination', () => {
  it('uses taskkill /T /F on Windows without a shell', () => {
    const runSync = vi.fn(() => ({ status: 0 }));
    killProcessTree(4242, { platform: 'win32', runSync });
    expect(runSync).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/T', '/F'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it('sends SIGKILL to the process group on POSIX, then falls back to pid', () => {
    const kill = vi.fn((pid) => {
      if (pid < 0) {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
    });
    killProcessTree(99, { platform: 'darwin', kill });
    expect(kill).toHaveBeenNthCalledWith(1, -99, 'SIGKILL');
    expect(kill).toHaveBeenNthCalledWith(2, 99, 'SIGKILL');
  });

  it('no-ops for invalid pids', () => {
    const kill = vi.fn();
    killProcessTree(0, { platform: 'linux', kill });
    killProcessTree(undefined, { platform: 'linux', kill });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('validation matrix honesty', () => {
  it('never marks foreign platforms as locally runtime-tested from structure alone', () => {
    const structuralOnly = packagedSmokeValidationMatrix({
      hostPlatform: 'darwin',
      runtimeExecuted: false,
    });
    expect(structuralOnly.darwin.status).toBe('apenas estrutural');
    expect(structuralOnly.linux.status).toBe('apenas estrutural');
    expect(structuralOnly.win32.status).toBe('apenas estrutural');
    expect(structuralOnly.linux.localRuntime).toBe(false);
    expect(structuralOnly.win32.localRuntime).toBe(false);
  });

  it('marks only the host platform as local when a real runtime probe ran', () => {
    const matrix = packagedSmokeValidationMatrix({
      hostPlatform: 'darwin',
      runtimeExecuted: true,
      runtimePlatform: 'darwin',
    });
    expect(matrix.darwin.status).toBe('testado localmente');
    expect(matrix.linux.status).toBe('apenas estrutural');
    expect(matrix.win32.status).toBe('apenas estrutural');
  });

  it('does not promote Windows/Linux from mocks or cross-host claims', () => {
    // A unit test running on macOS with a mocked win32 spawn is not local validation.
    const mockedWin = packagedSmokeValidationMatrix({
      hostPlatform: 'darwin',
      runtimeExecuted: true,
      runtimePlatform: 'win32',
    });
    expect(mockedWin.win32.localRuntime).toBe(false);
    expect(mockedWin.win32.status).toBe('apenas estrutural');

    const format = formatValidationMatrix(mockedWin);
    expect(format).toContain('darwin: apenas estrutural');
    expect(format).toContain('win32: apenas estrutural');
    expect(format).toContain('linux: apenas estrutural');
  });
});

describe('runPackagedSmoke integration (fixture + fake spawn)', () => {
  function fixturePackage({ platform, arch }) {
    const root = makeTemp(`pkg-${platform}-`);
    let binary;
    let unpacked;
    if (platform === 'darwin') {
      const app = path.join(root, 'NexusIDE.app');
      binary = path.join(app, 'Contents', 'MacOS', 'nexus-ide');
      unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked');
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, '');
    } else if (platform === 'win32') {
      binary = path.join(root, 'nexus-ide.exe');
      unpacked = path.join(root, 'resources', 'app.asar.unpacked');
      fs.writeFileSync(binary, '');
    } else {
      binary = path.join(root, 'nexus-ide');
      unpacked = path.join(root, 'resources', 'app.asar.unpacked');
      fs.writeFileSync(binary, '');
    }
    if (platform !== 'win32') fs.chmodSync(binary, 0o755);

    const files = [
      'node_modules/@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm',
      'node_modules/tesseract.js/src/worker-script/node/index.js',
      'node_modules/tesseract.js-core/index.js',
      'node_modules/wasm-feature-detect/dist/cjs/index.cjs',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      `node_modules/@lydell/node-pty-${platform}-${arch}/prebuilds/${platform}-${arch}/pty.node`,
      `node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime_binding.node`,
    ];
    if (platform !== 'win32') {
      files.push(
        `node_modules/@lydell/node-pty-${platform}-${arch}/prebuilds/${platform}-${arch}/spawn-helper`,
      );
    }
    writeTree(unpacked, files);
    const wakeDir = path.join(path.dirname(unpacked), 'wake');
    const wakeModel = Buffer.from('fixture-ptbr-wake-model');
    const wakeHash = createHash('sha256').update(wakeModel).digest('hex');
    fs.mkdirSync(wakeDir, { recursive: true });
    fs.writeFileSync(path.join(wakeDir, 'ei-jarvis-ptbr.onnx'), wakeModel);
    fs.writeFileSync(path.join(wakeDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      defaultModel: {
        file: 'ei-jarvis-ptbr.onnx',
        locale: 'pt-BR',
        required: true,
        sha256: wakeHash,
        wakePhrase: 'Ei Jarvis',
      },
    }));
    return { root, binary, targetPath: platform === 'darwin' ? path.join(root, 'NexusIDE.app') : root };
  }

  function fakeChild({ stdoutText, exitCode = 0, writeMarker }) {
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (writeMarker) writeMarker();
      child.stdout.emit(
        'data',
        Buffer.from(
          stdoutText ??
            '[smoke] renderer-mounted\n[smoke] functional-ready: 20 probes\n',
        ),
      );
      child.emit('close', exitCode);
    });
    return child;
  }

  it('runs structural checks and proves readiness via isolated marker', async () => {
    const { targetPath } = fixturePackage({ platform: 'darwin', arch: 'arm64' });
    let capturedEnv;
    let capturedArgs;
    let capturedOpts;

    const result = await runPackagedSmoke(targetPath, {
      platform: 'darwin',
      arch: 'arm64',
      spawnImpl: (binary, args, opts) => {
        capturedArgs = args;
        capturedOpts = opts;
        capturedEnv = opts.env;
        return fakeChild({
          writeMarker: () => {
            const marker = packagedSmokeMarkerPath(opts.env.NEXUS_USER_DATA_DIR);
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
          },
        });
      },
      inspectMainBundle: () => {},
      inspectLegalArtifacts: () => {},
    });

    expect(capturedArgs[0]).toBe('nexus-smoke-test');
    expect(capturedOpts.shell).toBe(false);
    expect(capturedOpts.detached).toBe(true);
    expect(capturedEnv.HOME).toContain('nexus-packaged-smoke-');
    expect(capturedEnv.TMPDIR).toContain(path.join('tmp'));
    // A fake child proves harness behavior, never a packaged runtime.
    expect(result.matrix.darwin.status).toBe('apenas estrutural');
    expect(result.matrix.linux.status).toBe('apenas estrutural');
    expect(result.matrix.win32.status).toBe('apenas estrutural');
  });

  it('kills the process tree on timeout', async () => {
    const { targetPath } = fixturePackage({ platform: 'linux', arch: 'x64' });
    const killTree = vi.fn();
    const child = new EventEmitter();
    child.pid = 777;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    await expect(
      runPackagedSmoke(targetPath, {
        platform: 'linux',
        arch: 'x64',
        timeoutMs: 20,
        killTree,
        spawnImpl: () => {
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from('[smoke] boot-started\n'));
            child.stderr.emit(
              'data',
              Buffer.from('[main] waiting-for-renderer\n'),
            );
          });
          return child;
        },
        inspectMainBundle: () => {},
        inspectLegalArtifacts: () => {},
      }),
    ).rejects.toThrow(
      /timed out[\s\S]*\[smoke\] boot-started[\s\S]*\[main\] waiting-for-renderer/,
    );

    expect(killTree).toHaveBeenCalledWith(777, { platform: 'linux' });
  });
});
