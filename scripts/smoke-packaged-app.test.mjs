import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { finished } from 'node:stream/promises';
import { createPackage } from '@electron/asar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FUNCTIONAL_SMOKE_MARKER_CONTENT,
  GRACEFUL_CLOSE_TIMEOUT_MS,
  assertFunctionalMarker,
  assertPackagedWindowsRuntimeIcon,
  assertPackagedMainBundleBootable,
  inspectPackagedLegalArtifacts,
  inspectPackagedMainBundle,
  inspectPackagedWakeModel,
  assertNativeArtifactsPresent,
  assertNoBundledNodePtySpawnHelper,
  assertNoNativeLoadFailure,
  assertPackagedSmokeProof,
  defaultPackagedTargetPath,
  formatValidationMatrix,
  PROCESS_TREE_PROOF_TIMEOUT_MS,
  classifyProcessTreeProof,
  isKernelExitingRunState,
  killProcessTree,
  listProcessTreePids,
  parseProcessStatLines,
  processRunState,
  readProcessTreeStats,
  packagedBinaryForApp,
  packagedSmokeArgs,
  packagedSmokeEnvironment,
  packagedSmokeMarkerPath,
  packagedSmokeSpawnOptions,
  packagedSmokeValidationMatrix,
  requiredNativeArtifactGlobs,
  requiredResourceArtifacts,
  assertPackagedResourceArtifacts,
  resolveAppArgument,
  resolvePackagedMainBundlePath,
  resolvePackagedTarget,
  runPackagedSmoke,
  toHostAsarPath,
} from './smoke-packaged-app.mjs';
import { buildIco, encodePngEntry } from './build-windows-icon.mjs';
import * as packagedSmoke from './smoke-packaged-app.mjs';

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

function materializePackagedResources(resourcesDir, platform) {
  for (const spec of requiredResourceArtifacts({ platform })) {
    const full = path.join(resourcesDir, spec.relative);
    if (spec.kind === 'dir') {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (!fs.existsSync(full)) fs.writeFileSync(full, 'resource');
    }
  }
}

function writeTree(root, relativeFiles) {
  for (const relative of relativeFiles) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'native');
    if (path.basename(full) === 'spawn-helper') fs.chmodSync(full, 0o755);
  }
}

const ONNX_REDISTRIBUTION_FILES = [
  'onnxruntime-v1.19.2-MIT.txt',
  'onnxruntime-v1.19.2-ThirdPartyNotices.txt',
];
const ONNX_NOTICE = '\n## Microsoft ONNX Runtime 1.19.2\nmicrosoft/onnxruntime\n';
function writeOnnxLegalFiles(source) {
  const dir = path.join(source, 'third_party', 'licenses');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ONNX_REDISTRIBUTION_FILES) {
    fs.writeFileSync(path.join(dir, file),
      fs.readFileSync(new URL(`../third_party/licenses/${file}`, import.meta.url)));
  }
}

function writeElectronLegalFiles(resources) {
  const dir = path.join(resources, 'electron-licenses');
  fs.mkdirSync(dir, { recursive: true });
  const files = ['LICENSE', 'LICENSES.chromium.html'].map(name => {
    const bytes = fs.readFileSync(new URL(`../node_modules/electron/dist/${name}`, import.meta.url));
    fs.writeFileSync(path.join(dir, name), bytes);
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 'nexus.electron-licenses/v1',
    electronVersion: '43.7.4', platform: 'darwin', arch: 'arm64', source: 'packager-extracted-template',
    sourceUrl: 'https://github.com/electron/electron/releases/download/v43.7.4/electron-v43.7.4-darwin-arm64.zip', files }));
}

async function createFinishedPackage(source, destination) {
  // @electron/asar resolves createPackage after calling stream.end(), not
  // after the archive has physically emitted "finish". Reading immediately
  // is therefore racy under the full parallel suite.
  const archive = await createPackage(source, destination);
  await finished(archive);
}


/** The per-platform package npm installs for @napi-rs/keyring on a release runner. */
const keyringFixture = (platform, arch) => {
  const target = `${platform}-${arch}${{ linux: '-gnu', win32: '-msvc' }[platform] ?? ''}`;
  return `node_modules/@napi-rs/keyring-${target}/keyring.${target}.node`;
};

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
    const appPath = path.resolve('/tmp/release/NexusIDE.app');
    const target = resolvePackagedTarget(appPath, {
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(target.binary).toBe(
      path.join(appPath, 'Contents', 'MacOS', 'nexus-ide'),
    );
    expect(target.unpackedRoot).toBe(
      path.join(
        appPath,
        'Contents',
        'Resources',
        'app.asar.unpacked',
      ),
    );
    expect(packagedBinaryForApp(appPath, 'darwin')).toBe(
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
    const userData = path.resolve('/tmp/nexus-packaged-smoke');
    expect(packagedSmokeArgs(userData, 'darwin')).toEqual([
      'nexus-smoke-test',
      `--user-data-dir=${userData}`,
    ]);
  });

  it('disables Chromium sandbox only for the Linux CI smoke harness', () => {
    const userData = path.resolve('/tmp/nexus-packaged-smoke');
    expect(packagedSmokeArgs(userData, 'linux')).toEqual([
      '--no-sandbox',
      'nexus-smoke-test',
      `--user-data-dir=${userData}`,
    ]);
  });

  it('isolates filesystem defaults and strips secrets/injection variables', () => {
    const userData = path.resolve('/tmp/nexus-packaged-smoke');
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
      HOME: path.join(userData, 'home'),
      USERPROFILE: path.join(userData, 'home'),
      APPDATA: path.join(userData, 'home', 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(
        userData,
        'home',
        'AppData',
        'Local',
      ),
      TEMP: path.join(userData, 'tmp'),
      TMP: path.join(userData, 'tmp'),
      TMPDIR: path.join(userData, 'tmp'),
      NEXUS_USER_DATA_DIR: userData,
      NEXUS_FORCE_ALL_FLAGS: '1',
      NEXUS_PACKAGED_SMOKE: '1',
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
    const userData = path.resolve('/tmp/nexus-packaged-smoke');
    expect(packagedSmokeMarkerPath(userData)).toBe(
      path.join(userData, 'functional-smoke-workspace', 'smoke.txt'),
    );
  });
});

describe('proofs: renderer, functional, marker, natives', () => {
  it('requires a complete multi-resolution Nexus ICO in Windows resources', () => {
    const resources = makeTemp('nexus-smoke-windows-icon-');
    const rgba = Buffer.alloc(8 * 8 * 4, 255);
    fs.writeFileSync(
      path.join(resources, 'icon.ico'),
      buildIco(encodePngEntry(rgba, 8)),
    );

    expect(assertPackagedWindowsRuntimeIcon(resources)).toMatchObject({
      path: path.join(resources, 'icon.ico'),
      sizes: [16, 24, 32, 48, 64, 128, 256],
    });

    fs.writeFileSync(path.join(resources, 'icon.ico'), Buffer.from('not-an-ico'));
    expect(() => assertPackagedWindowsRuntimeIcon(resources)).toThrow(/ICO/i);
  });

  it('converts canonical ASAR entries to the host separator at extraction time', () => {
    expect(toHostAsarPath('/.vite/build/main.js', '\\')).toBe(
      '.vite\\build\\main.js',
    );
    expect(toHostAsarPath('third_party\\licenses\\Apache-2.0.txt', '/')).toBe(
      'third_party/licenses/Apache-2.0.txt',
    );
  });

  it('inspects main chunks and legal files from a real ASAR archive', async () => {
    const root = makeTemp('nexus-smoke-asar-boundary-');
    const source = path.join(root, 'source');
    const resources = path.join(root, 'resources');
    writeTree(source, [
      '.vite/build/main.js',
      '.vite/build/main-hashed.js',
      'third_party/licenses/Apache-2.0.txt',
      'third_party/licenses/OFL-1.1.txt',
    ]);
    fs.writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({ main: '.vite/build/main.js' }),
    );
    fs.writeFileSync(
      path.join(source, 'THIRD_PARTY_NOTICES.md'),
      '## Onlook CSS-to-Tailwind translator\nonlook-dev/onlook\n' + ONNX_NOTICE,
    );
    writeOnnxLegalFiles(source);
    fs.mkdirSync(resources, { recursive: true });
    await createFinishedPackage(source, path.join(resources, 'app.asar'));

    expect(() => inspectPackagedMainBundle(resources)).not.toThrow();
    if (process.platform === 'darwin') writeElectronLegalFiles(resources);
    expect(() => inspectPackagedLegalArtifacts(resources, { platform: process.platform, arch: process.arch })).not.toThrow();
  });

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

  it('inspects the hashed main declared by package.json when the legacy path is absent', async () => {
    const source = makeTemp('nexus-smoke-main-source-');
    const resources = makeTemp('nexus-smoke-main-resources-');
    fs.mkdirSync(path.join(source, '.vite', 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({ main: '.vite/build/main-hashed.js' }),
    );
    fs.writeFileSync(
      path.join(source, '.vite', 'build', 'main-hashed.js'),
      'const req=(0,node_module.createRequire)({}.url);req.resolve("asset");',
    );
    await createFinishedPackage(source, path.join(resources, 'app.asar'));

    expect(() => inspectPackagedMainBundle(resources)).toThrow(
      /createRequire.*undefined.*import\.meta\.url/iu,
    );
  });

  it('resolves the main bundle when Forge nests the Vite output under app', () => {
    expect(
      resolvePackagedMainBundlePath([
        'resources/app/.vite/build/main.js',
        'resources/app/.vite/build/preload.js',
      ]),
    ).toBe('resources/app/.vite/build/main.js');
    expect(resolvePackagedMainBundlePath(['.vite/build/main.js'])).toBe(
      '.vite/build/main.js',
    );
    expect(
      resolvePackagedMainBundlePath(['build/main.js'], 'build/main.js'),
    ).toBe('build/main.js');
    expect(resolvePackagedMainBundlePath(['resources/app/main.js'])).toBeNull();
  });

  it('F-881: rejects an ASAR that omits the ONNX Runtime redistribution texts', async () => {
    const root = makeTemp('nexus-smoke-onnx-missing-');
    const source = path.join(root, 'source');
    const resources = path.join(root, 'resources');
    writeTree(source, ['third_party/licenses/Apache-2.0.txt', 'third_party/licenses/OFL-1.1.txt']);
    fs.writeFileSync(path.join(source, 'THIRD_PARTY_NOTICES.md'),
      '## Onlook CSS-to-Tailwind translator\nonlook-dev/onlook\n');
    fs.mkdirSync(resources, { recursive: true });
    await createFinishedPackage(source, path.join(resources, 'app.asar'));

    expect(() => inspectPackagedLegalArtifacts(resources)).toThrow(/onnxruntime/i);
  });

  it.each(ONNX_REDISTRIBUTION_FILES)('F-881: rejects missing pinned %s in a real ASAR', async (file) => {
    const root = makeTemp('nexus-smoke-onnx-single-missing-');
    const source = path.join(root, 'source');
    const resources = path.join(root, 'resources');
    writeTree(source, ['third_party/licenses/Apache-2.0.txt', 'third_party/licenses/OFL-1.1.txt']);
    writeOnnxLegalFiles(source);
    fs.unlinkSync(path.join(source, 'third_party', 'licenses', file));
    fs.writeFileSync(path.join(source, 'THIRD_PARTY_NOTICES.md'),
      '## Onlook CSS-to-Tailwind translator\nonlook-dev/onlook\n' + ONNX_NOTICE);
    fs.mkdirSync(resources, { recursive: true });
    await createFinishedPackage(source, path.join(resources, 'app.asar'));
    expect(() => inspectPackagedLegalArtifacts(resources)).toThrow(/onnxruntime/i);
  });

  it.each(ONNX_REDISTRIBUTION_FILES)('F-881: rejects truncated or substituted %s in a real ASAR', async (file) => {
    const root = makeTemp('nexus-smoke-onnx-tampered-');
    const source = path.join(root, 'source');
    const resources = path.join(root, 'resources');
    writeTree(source, ['third_party/licenses/Apache-2.0.txt', 'third_party/licenses/OFL-1.1.txt']);
    writeOnnxLegalFiles(source);
    fs.writeFileSync(path.join(source, 'third_party', 'licenses', file), 'MIT License\nCopyright Microsoft\n');
    fs.writeFileSync(path.join(source, 'THIRD_PARTY_NOTICES.md'),
      '## Onlook CSS-to-Tailwind translator\nonlook-dev/onlook\n' + ONNX_NOTICE);
    fs.mkdirSync(resources, { recursive: true });
    await createFinishedPackage(source, path.join(resources, 'app.asar'));
    expect(() => inspectPackagedLegalArtifacts(resources)).toThrow(/pinned ONNX Runtime/i);
  });

  it.runIf(process.platform === 'darwin').each(['missing', 'version', 'source', 'LICENSE', 'LICENSES.chromium.html'])('F-882: rejects %s Electron distribution proof at the Mac legal gate', async (fault) => {
    const root = makeTemp('nexus-smoke-electron-legal-');
    const source = path.join(root, 'source');
    const resources = path.join(root, 'resources');
    writeTree(source, ['third_party/licenses/Apache-2.0.txt', 'third_party/licenses/OFL-1.1.txt']);
    writeOnnxLegalFiles(source);
    fs.writeFileSync(path.join(source, 'THIRD_PARTY_NOTICES.md'),
      '## Onlook CSS-to-Tailwind translator\nonlook-dev/onlook\n' + ONNX_NOTICE);
    fs.mkdirSync(resources, { recursive: true });
    await createFinishedPackage(source, path.join(resources, 'app.asar'));
    if (fault !== 'missing') {
      writeElectronLegalFiles(resources);
      const manifestPath = path.join(resources, 'electron-licenses', 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (fault === 'version') manifest.electronVersion = '43.0.0';
      else if (fault === 'source') manifest.sourceUrl = 'https://example.org/claimed-license.zip';
      else fs.writeFileSync(path.join(resources, 'electron-licenses', fault), 'MIT\nCopyright Electron\n');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    expect(() => inspectPackagedLegalArtifacts(resources, { platform: 'darwin', arch: 'arm64' })).toThrow(/Electron.*legal/i);
    if (fault === 'missing') expect(() => inspectPackagedLegalArtifacts(resources, { platform: 'linux', arch: 'x64' })).not.toThrow();
  });

  it('requires notices plus Apache, OFL and pinned ONNX texts inside app.asar', async () => {
    const root = makeTemp('nexus-smoke-legal-');
    const source = path.join(root, 'source');
    const resources = path.join(root, 'resources');
    fs.mkdirSync(path.join(source, 'third_party', 'licenses'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(source, 'THIRD_PARTY_NOTICES.md'),
      '## Onlook CSS-to-Tailwind translator\nonlook-dev/onlook\n' + ONNX_NOTICE,
    );
    fs.writeFileSync(
      path.join(source, 'third_party', 'licenses', 'Apache-2.0.txt'),
      'Apache License 2.0',
    );
    fs.writeFileSync(
      path.join(source, 'third_party', 'licenses', 'OFL-1.1.txt'),
      'SIL Open Font License 1.1',
    );
    writeOnnxLegalFiles(source);
    fs.mkdirSync(resources, { recursive: true });
    await createFinishedPackage(source, path.join(resources, 'app.asar'));

    if (process.platform === 'darwin') writeElectronLegalFiles(resources);
    expect(() => inspectPackagedLegalArtifacts(resources, { platform: process.platform, arch: process.arch })).not.toThrow();
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
    await createFinishedPackage(source, path.join(resources, 'app.asar'));

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

  it('requires a physical Main-owned command proof for a signed release, while keeping ordinary ad-hoc smoke separate', () => {
    const ready = '[smoke] renderer-mounted\n[smoke] functional-ready\n';
    const unavailable = '[smoke] main-owned-command {"status":"unavailable","reason":"ad-hoc"}\n';
    for (const output of [ready, ready + unavailable,
      ready + '[smoke] main-owned-command {"status":"failed"}\n']) {
      expect(() => assertPackagedSmokeProof(0, output, { requireMainOwnedCommand: true })).toThrow(/Main-owned command proof/);
    }
    expect(() => assertPackagedSmokeProof(0, ready + unavailable)).not.toThrow();
    const proof = { status: 'passed', densePathFiles: 768, profileBytes: 4096, exitCode: 0, physicalExitProven: true };
    expect(() => assertPackagedSmokeProof(0, ready + `[smoke] main-owned-command ${JSON.stringify(proof)}\n`, { requireMainOwnedCommand: true })).not.toThrow();
    for (const patch of [{ physicalExitProven: false }, { exitCode: 1 }, { profileBytes: 65537 }, { densePathFiles: 1 }]) {
      expect(() => assertPackagedSmokeProof(0, ready + `[smoke] main-owned-command ${JSON.stringify({ ...proof, ...patch })}\n`, { requireMainOwnedCommand: true })).toThrow(/Main-owned command proof/);
    }
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

  it('F-1295: Resources sem shell-integration ou sem nx-shim.cjs reprova o pacote', async () => {
    const platform = 'darwin';
    const complete = makeTemp('resources-complete-');
    materializePackagedResources(complete, platform);
    await expect(assertPackagedResourceArtifacts(complete, { platform })).resolves.toBeUndefined();

    const withoutShell = makeTemp('resources-no-shell-');
    materializePackagedResources(withoutShell, platform);
    fs.rmSync(path.join(withoutShell, 'shell-integration'), { recursive: true, force: true });
    await expect(assertPackagedResourceArtifacts(withoutShell, { platform })).rejects.toThrow(
      /shell-integration/,
    );

    const withoutShim = makeTemp('resources-no-shim-');
    materializePackagedResources(withoutShim, platform);
    fs.rmSync(path.join(withoutShim, 'mission-shims', 'nx-shim.cjs'));
    await expect(assertPackagedResourceArtifacts(withoutShim, { platform })).rejects.toThrow(
      /nx-shim\.cjs/,
    );
  });

  it('F-1295: cada extraResource do forge e o sentinela do diretório existem no repositório', () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    // linux: mesmo conjunto estático, sem o supervisor Darwin gerado no build.
    for (const spec of requiredResourceArtifacts({ platform: 'linux' })) {
      const sourcePath = spec.kind === 'file' && spec.relative.includes('/')
        ? path.join(repoRoot, spec.source, path.basename(spec.relative))
        : path.join(repoRoot, spec.source);
      expect(fs.existsSync(sourcePath), spec.relative).toBe(true);
    }
  });

  it('lists native bindings without treating spawn-helper as an artifact', () => {
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
        'onnxruntime-node',
        'napi-keyring',
      ]),
    );
    expect(linux).not.toContain('node-pty-spawn-helper');
    expect(win).not.toContain('node-pty-spawn-helper');
    expect(darwin).not.toContain('node-pty-spawn-helper');
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
        keyringFixture(platform, arch),
      ];
      if (platform === 'linux') {
        files.push(
          `node_modules/onnxruntime-node/bin/napi-v3/linux/${arch}/libonnxruntime.so.1`,
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
      expect(found['napi-keyring']).toMatch(/keyring\.[\w-]+\.node$/);
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

  it('fails when any macOS node-pty spawn-helper is bundled', async () => {
    const unpacked = makeTemp();
    writeTree(unpacked, [
      'node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper',
    ]);
    await expect(
      assertNoBundledNodePtySpawnHelper(unpacked),
    ).rejects.toThrow(/forbidden/);
    await expect(
      assertNativeArtifactsPresent(unpacked, {
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).rejects.toThrow(/forbidden/);
  });

  it('fails when a spawn-helper is hidden inside app.asar', async () => {
    const resources = makeTemp('nexus-spawn-helper-asar-');
    const source = makeTemp('nexus-spawn-helper-asar-source-');
    const unpacked = path.join(resources, 'app.asar.unpacked');
    fs.mkdirSync(unpacked, { recursive: true });
    writeTree(source, [
      'node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper',
    ]);
    await createFinishedPackage(source, path.join(resources, 'app.asar'));

    await expect(
      assertNoBundledNodePtySpawnHelper(unpacked),
    ).rejects.toThrow(/asar contains forbidden/);
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
      'node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node',
      'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node',
    ]);
    const found = await assertNativeArtifactsPresent(unpacked, {
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(found['better-sqlite3']).toMatch(/better-sqlite3\.node$/);
  });
});

describe('process tree termination', () => {
  it('does not report an already-dead zombie awaiting parent reaping', () => {
    const runSync = vi.fn(() => ({
      status: 0,
      stdout:
        ' 42 10 42 Z+\n' +
        ' 43 42 43 S+\n' +
        ' 99 10 99 R+\n',
    }));

    expect(
      listProcessTreePids(42, {
        platform: 'darwin',
        runSync,
      }),
    ).toEqual([43]);
    expect(runSync).toHaveBeenCalledWith(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,stat='],
      expect.objectContaining({ shell: false }),
    );
  });

  it('never converts an unreadable ps inventory into an empty tree', () => {
    expect(() =>
      listProcessTreePids(42, {
        platform: 'darwin',
        runSync: () => ({
          status: 1,
          stdout: '',
          error: new Error('ps unavailable'),
        }),
      }),
    ).toThrow(/process-tree inventory failed.*ps unavailable/);
  });

  it('uses taskkill /T /F on Windows without a shell', () => {
    const runSync = vi.fn(() => ({ status: 0 }));
    killProcessTree(4242, { platform: 'win32', runSync });
    expect(runSync).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/T', '/F'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it('escalates SIGTERM → SIGKILL and reports remaining orphans', () => {
    const live = new Set([99, 100]);
    const kill = vi.fn((pid, signal) => {
      if (signal === 'SIGKILL') {
        // Group kill removes the group leader; orphan 100 sticks until targeted.
        if (pid === -99 || pid === 99) live.delete(99);
        if (pid === 100) live.delete(100);
      }
    });
    const listPids = vi.fn(() => [...live].sort((a, b) => a - b));
    const proof = killProcessTree(99, {
      platform: 'darwin',
      kill,
      listPids,
      classifyRemaining: (pids) => ({
        orphans: pids,
        kernelExiting: [],
        warnings: [],
      }),
      sleep: () => undefined,
      termGraceMs: 0,
      killGraceMs: 0,
      pollMs: 0,
    });
    expect(kill).toHaveBeenCalledWith(-99, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-99, 'SIGKILL');
    expect(proof.ok).toBe(true);
    expect(proof.remainingPids).toEqual([]);
    expect(proof.signalled.some((s) => s.includes('SIGTERM'))).toBe(true);
  });

  it('returns remainingPids when helpers refuse to die', () => {
    const kill = vi.fn();
    const proof = killProcessTree(42, {
      platform: 'darwin',
      kill,
      listPids: () => [42, 777],
      classifyRemaining: (pids) => ({
        orphans: pids,
        kernelExiting: [],
        warnings: [],
      }),
      sleep: () => undefined,
      termGraceMs: 0,
      killGraceMs: 0,
      pollMs: 0,
    });
    expect(proof.ok).toBe(false);
    expect(proof.remainingPids).toEqual([42, 777]);
    expect(proof.processTreeProof).toEqual({
      orphans: [42, 777],
      kernelExiting: [],
      elapsedMs: expect.any(Number),
    });
  });

  it('fails closed when any termination inventory read fails', () => {
    const proof = killProcessTree(42, {
      platform: 'darwin',
      kill: vi.fn(),
      listPids: () => {
        throw new Error('inventory denied');
      },
      sleep: () => undefined,
      termGraceMs: 0,
      killGraceMs: 0,
      pollMs: 0,
    });
    expect(proof.ok).toBe(false);
    expect(proof.remainingPids).toEqual([42]);
    expect(proof.inventoryError).toMatch(/inventory denied/);
  });

  it('no-ops for invalid pids', () => {
    const kill = vi.fn();
    expect(killProcessTree(0, { platform: 'linux', kill })).toEqual({
      ok: true,
      remainingPids: [],
      signalled: [],
      warnings: [],
      processTreeProof: { orphans: [], kernelExiting: [], elapsedMs: 0 },
    });
    expect(killProcessTree(undefined, { platform: 'linux', kill })).toEqual({
      ok: true,
      remainingPids: [],
      signalled: [],
      warnings: [],
      processTreeProof: { orphans: [], kernelExiting: [], elapsedMs: 0 },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('treats kernel E/Z leftovers as terminated, not as working orphans', () => {
    const proof = killProcessTree(8638, {
      platform: 'darwin',
      kill: vi.fn(),
      listPids: () => [8638, 9001],
      classifyRemaining: () => ({
        orphans: [],
        kernelExiting: [8638, 9001],
        warnings: ['kernel-exiting: 8638', 'kernel-exiting: 9001'],
      }),
      sleep: () => undefined,
      termGraceMs: 0,
      killGraceMs: 0,
      pollMs: 0,
    });
    expect(proof.ok).toBe(true);
    expect(proof.remainingPids).toEqual([]);
    expect(proof.warnings).toEqual([
      'kernel-exiting: 8638',
      'kernel-exiting: 9001',
    ]);
    expect(proof.processTreeProof).toEqual({
      orphans: [],
      kernelExiting: [8638, 9001],
      elapsedMs: expect.any(Number),
    });
  });

  it('still fails when a live S/R/T pid remains beside kernel-exiting ones', () => {
    const proof = killProcessTree(42, {
      platform: 'darwin',
      kill: vi.fn(),
      listPids: () => [42, 43],
      classifyRemaining: () => ({
        orphans: [43],
        kernelExiting: [42],
        warnings: ['kernel-exiting: 42'],
      }),
      sleep: () => undefined,
      termGraceMs: 0,
      killGraceMs: 0,
      pollMs: 0,
    });
    expect(proof.ok).toBe(false);
    expect(proof.remainingPids).toEqual([43]);
    expect(proof.warnings).toEqual(['kernel-exiting: 42']);
    expect(proof.processTreeProof).toEqual({
      orphans: [43],
      kernelExiting: [42],
      elapsedMs: expect.any(Number),
    });
  });

  it('caps the process-tree proof instead of waiting on leftovers forever', () => {
    let t = 0;
    const proof = killProcessTree(42, {
      platform: 'darwin',
      kill: vi.fn(),
      listPids: () => [42],
      classifyRemaining: () => ({
        orphans: [42],
        kernelExiting: [],
        warnings: [],
      }),
      now: () => t,
      sleep: (ms) => {
        t += ms;
      },
      pollMs: 20,
      termGraceMs: 0,
      killGraceMs: 1_000,
      proofTimeoutMs: 60,
    });
    expect(proof.ok).toBe(false);
    expect(proof.remainingPids).toEqual([42]);
    expect(proof.processTreeProof.elapsedMs).toBe(60);
    expect(proof.processTreeProof.orphans).toEqual([42]);
    expect(t).toBe(60);
  });
});

describe('process-tree STAT classification', () => {
  it('reads the run state through a leading no-tty marker', () => {
    expect(processRunState('?Es')).toBe('E');
    expect(processRunState('Es')).toBe('E');
    expect(processRunState('Z+')).toBe('Z');
    expect(processRunState('Ss')).toBe('S');
    expect(processRunState('R')).toBe('R');
    expect(processRunState('T')).toBe('T');
    expect(processRunState('')).toBe('');
  });

  it('treats only E and Z as kernel-exiting', () => {
    expect(isKernelExitingRunState('?Es')).toBe(true);
    expect(isKernelExitingRunState('Z')).toBe(true);
    expect(isKernelExitingRunState('S+')).toBe(false);
    expect(isKernelExitingRunState('R')).toBe(false);
    expect(isKernelExitingRunState('T')).toBe(false);
    expect(isKernelExitingRunState('U')).toBe(false);
  });

  it('parses pid/stat/command rows from ps', () => {
    expect(
      parseProcessStatLines(
        ' 8638 Es   /private/tmp/dmg/NexusIDE.app/Contents/MacOS/nexus-ide\n' +
          '  9001 Ss helper\n' +
          '\n',
      ),
    ).toEqual([
      {
        pid: 8638,
        stat: 'Es',
        command: '/private/tmp/dmg/NexusIDE.app/Contents/MacOS/nexus-ide',
      },
      { pid: 9001, stat: 'Ss', command: 'helper' },
    ]);
  });

  it('partitions remaining pids and names kernel-exiting warnings', () => {
    const classified = classifyProcessTreeProof(
      [
        { pid: 8638, stat: '?Es', command: '(nexus-ide)' },
        { pid: 9001, stat: 'Z', command: '<defunct>' },
        { pid: 42, stat: 'Ss', command: 'helper' },
      ],
      [8638, 9001, 42, 7],
    );
    expect(classified).toEqual({
      orphans: [7, 42],
      kernelExiting: [8638, 9001],
      warnings: ['kernel-exiting: 8638', 'kernel-exiting: 9001'],
    });
  });

  it('reads STAT via ps -o pid=,stat=,command= with a mocked inventory', () => {
    const runSync = vi.fn(() => ({
      status: 0,
      stdout:
        ' 8638 Es   /Volumes/NexusIDE/NexusIDE.app/Contents/MacOS/nexus-ide\n' +
        '   42 Ss helper\n',
    }));
    const rows = readProcessTreeStats([8638, 42], { runSync });
    expect(rows.map((row) => row.pid)).toEqual([8638, 42]);
    expect(isKernelExitingRunState(rows[0].stat)).toBe(true);
    expect(classifyProcessTreeProof(rows, [8638, 42])).toEqual({
      orphans: [42],
      kernelExiting: [8638],
      warnings: ['kernel-exiting: 8638'],
    });
    expect(runSync).toHaveBeenCalledWith(
      'ps',
      ['-o', 'pid=,stat=,command=', '-p', '8638,42'],
      expect.objectContaining({ shell: false }),
    );
    expect(PROCESS_TREE_PROOF_TIMEOUT_MS).toBe(60_000);
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
      keyringFixture(platform, arch),
    ];
    if (platform === 'linux') {
      files.push(
        `node_modules/onnxruntime-node/bin/napi-v3/linux/${arch}/libonnxruntime.so.1`,
      );
    }
    writeTree(unpacked, files);
    materializePackagedResources(path.dirname(unpacked), platform);
    if (platform === 'win32') {
      const rgba = Buffer.alloc(8 * 8 * 4, 255);
      fs.writeFileSync(
        path.join(path.dirname(unpacked), 'icon.ico'),
        buildIco(encodePngEntry(rgba, 8)),
      );
    }
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

  it('reuses an owned private profile across launches and awaits the runtime probe', async () => {
    const { targetPath } = fixturePackage({ platform: 'linux', arch: 'x64' });
    const session = await packagedSmoke.createPackagedSmokeSession();
    try {
      const observed = [];
      for (let launch = 0; launch < 2; launch += 1) {
        const result = await runPackagedSmoke(targetPath, {
          platform: 'linux', arch: 'x64', smokeSession: session, remoteDebugging: true,
          runtimeProbe: async (_child, context) => {
            await new Promise(resolve => setTimeout(resolve, 5));
            expect(context.userData).toBe(session.userData);
            return { launch };
          },
          spawnImpl: (_binary, args, opts) => {
            expect(fs.existsSync(path.join(opts.env.NEXUS_USER_DATA_DIR, 'DevToolsActivePort'))).toBe(false);
            observed.push({ args, env: opts.env });
            return fakeChild({ writeMarker: () => {
              const marker = packagedSmokeMarkerPath(opts.env.NEXUS_USER_DATA_DIR);
              fs.mkdirSync(path.dirname(marker), { recursive: true });
              fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
            } });
          },
          inspectMainBundle: () => {}, inspectLegalArtifacts: () => {}, listTreePids: () => [],
        });
        expect(result.runtimeProof).toEqual({ launch });
        expect(fs.existsSync(session.userData)).toBe(true);
        fs.writeFileSync(path.join(session.userData, 'DevToolsActivePort'), 'previous process endpoint');
      }
      expect(observed.map(o => o.env.NEXUS_USER_DATA_DIR)).toEqual([session.userData, session.userData]);
      expect(observed.every(o => o.env.HOME === path.join(session.userData, 'home'))).toBe(true);
      expect(observed.every(o => o.args.includes('--remote-debugging-port=0'))).toBe(true);
      expect(observed.every(o => o.args.includes('--remote-debugging-address=127.0.0.1'))).toBe(true);
      if (process.platform !== 'win32') expect(fs.statSync(session.userData).mode & 0o077).toBe(0);
    } finally {
      await packagedSmoke.disposePackagedSmokeSession(session);
    }
    expect(fs.existsSync(session.userData)).toBe(false);
  });

  it('rejects a failed runtime probe even when renderer and functional smoke succeeded', async () => {
    const { targetPath } = fixturePackage({ platform: 'linux', arch: 'x64' });
    const session = await packagedSmoke.createPackagedSmokeSession();
    const writes = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { writes.push(String(chunk)); return true; });
    try {
      await expect(runPackagedSmoke(targetPath, {
        platform: 'linux', arch: 'x64', smokeSession: session,
        runtimeProbe: async () => { throw new Error('preference did not survive restart'); },
        spawnImpl: (_binary, _args, opts) => fakeChild({ stdoutText: '[smoke] renderer-mounted\n[smoke] functional-ready: 22 probes\n[smoke] shutdown-complete: physical PTY inventory proven\n[smoke] expected-exit\n', writeMarker: () => {
          const marker = packagedSmokeMarkerPath(opts.env.NEXUS_USER_DATA_DIR);
          fs.mkdirSync(path.dirname(marker), { recursive: true });
          fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
        } }),
        inspectMainBundle: () => {}, inspectLegalArtifacts: () => {}, listTreePids: () => [],
      })).rejects.toThrow('preference did not survive restart');
      expect(writes.join('')).toContain('[smoke] functional-ready: 22 probes');
      expect(writes.join('')).toContain('[smoke] shutdown-complete: physical PTY inventory proven');
      expect(writes.join('')).toContain('[smoke] processTreeProof {"orphans":[]');
      expect(writes.join('')).not.toContain('validation-matrix');
      expect(writes.join('')).not.toContain('restartProof');
      expect(fs.existsSync(session.userData)).toBe(true);
    } finally {
      stdout.mockRestore();
      await packagedSmoke.disposePackagedSmokeSession(session);
    }
  });

  it('refuses caller-created profiles and never spawns into them', async () => {
    const { targetPath } = fixturePackage({ platform: 'linux', arch: 'x64' });
    const outside = makeTemp('nexus-unowned-profile-');
    const spawnImpl = vi.fn();
    await expect(runPackagedSmoke(targetPath, {
      platform: 'linux', arch: 'x64', smokeSession: { userData: outside }, spawnImpl,
      inspectMainBundle: () => {}, inspectLegalArtifacts: () => {},
    })).rejects.toThrow('must be created by this harness');
    await expect(packagedSmoke.disposePackagedSmokeSession({ userData: outside })).rejects.toThrow('unowned');
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('keeps long probe deadlines exclusive to explicit soak with inspector disabled', async () => {
    for (const options of [
      { runtimeProbeTimeoutMs: 450000 },
      { runtimeProbeTimeoutMs: 450000, soakProbe: true, env: {} },
      { runtimeProbeTimeoutMs: 450000, soakProbe: true, env: { NEXUS_SMOKE_SOAK: '1' }, remoteDebugging: true },
      { runtimeProbeTimeoutMs: 450000, soakProbe: true, env: { NEXUS_SMOKE_SOAK: '1' }, timeoutMs: Infinity },
      { runtimeProbeTimeoutMs: 590000, runtimeGatesProbe: true, env: {} },
      { runtimeProbeTimeoutMs: 590000, runtimeGatesProbe: true, remoteDebugging: true, env: { NEXUS_SMOKE_RUNTIME_GATES: '1' } },
      { runtimeProbeTimeoutMs: 590000, runtimeGatesProbe: true, env: { NEXUS_SMOKE_RUNTIME_GATES: '1', NEXUS_SMOKE_RUNTIME_GATEWAY: 'http://external.invalid:5000' } },
    ]) await expect(runPackagedSmoke('/never-launched/NexusIDE.app', options)).rejects.toThrow('invalid packaged smoke runtime probe options');
  });

  it.skipIf(process.platform === 'win32')('refuses a replaced profile symlink without touching its target', async () => {
    const { targetPath } = fixturePackage({ platform: 'linux', arch: 'x64' });
    const session = await packagedSmoke.createPackagedSmokeSession();
    const held = `${session.userData}.held`;
    const outside = makeTemp('nexus-smoke-symlink-target-');
    const marker = path.join(outside, 'preserve.txt');
    fs.writeFileSync(marker, 'outside remains');
    fs.renameSync(session.userData, held);
    fs.symlinkSync(outside, session.userData);
    const spawnImpl = vi.fn();
    try {
      await expect(runPackagedSmoke(targetPath, {
        platform: 'linux', arch: 'x64', smokeSession: session, spawnImpl,
        inspectMainBundle: () => {}, inspectLegalArtifacts: () => {},
      })).rejects.toThrow('private ownership');
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(fs.readFileSync(marker, 'utf8')).toBe('outside remains');
    } finally {
      fs.unlinkSync(session.userData);
      fs.renameSync(held, session.userData);
      await packagedSmoke.disposePackagedSmokeSession(session);
    }
  });

  it('bounds a stalled runtime probe and aborts it after the application exits', async () => {
    const { targetPath } = fixturePackage({ platform: 'linux', arch: 'x64' });
    let signal;
    await expect(runPackagedSmoke(targetPath, {
      platform: 'linux', arch: 'x64', runtimeProbeTimeoutMs: 10,
      runtimeProbe: async (_child, context) => { signal = context.signal; return new Promise(() => {}); },
      spawnImpl: (_binary, _args, opts) => fakeChild({ writeMarker: () => {
        const marker = packagedSmokeMarkerPath(opts.env.NEXUS_USER_DATA_DIR);
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
      } }),
      inspectMainBundle: () => {}, inspectLegalArtifacts: () => {}, listTreePids: () => [],
    })).rejects.toThrow('runtime probe timed out');
    expect(signal.aborted).toBe(true);
  });

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
      listTreePids: () => [],
    });

    expect(capturedArgs[0]).toBe('nexus-smoke-test');
    expect(capturedArgs.some(arg => arg.startsWith('--remote-debugging-'))).toBe(false);
    expect(capturedOpts.shell).toBe(false);
    expect(capturedOpts.detached).toBe(true);
    expect(capturedEnv.HOME).toContain('nexus-packaged-smoke-');
    expect(capturedEnv.TMPDIR).toContain(path.join('tmp'));
    // A fake child proves harness behavior, never a packaged runtime.
    expect(result.matrix.darwin.status).toBe('apenas estrutural');
    expect(result.matrix.linux.status).toBe('apenas estrutural');
    expect(result.matrix.win32.status).toBe('apenas estrutural');
    expect(result.shutdownMode).toBe('graceful');
    expect(result.treeProof).toEqual({
      ok: true,
      remainingPids: [],
      signalled: [],
      warnings: [],
      processTreeProof: { orphans: [], kernelExiting: [], elapsedMs: 0 },
    });
    expect(result.processTreeProof).toEqual({
      orphans: [],
      kernelExiting: [],
      elapsedMs: 0,
    });
  });

  it('kills the process tree on timeout', async () => {
    const { targetPath } = fixturePackage({ platform: 'linux', arch: 'x64' });
    const child = new EventEmitter();
    child.pid = 777;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const killTree = vi.fn(() => {
      queueMicrotask(() => child.emit('close', null));
      return { ok: true, remainingPids: [], signalled: ['group:SIGKILL'] };
    });

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

  it('reaps the whole tree when the packaged child reports a launch error', async () => {
    const { targetPath } = fixturePackage({ platform: 'linux', arch: 'x64' });
    const child = new EventEmitter();
    child.pid = 776;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const killTree = vi.fn(() => ({
      ok: true,
      remainingPids: [],
      signalled: ['group:SIGTERM'],
    }));

    await expect(
      runPackagedSmoke(targetPath, {
        platform: 'linux',
        arch: 'x64',
        killTree,
        spawnImpl: () => {
          queueMicrotask(() => child.emit('error', new Error('launch failed')));
          return child;
        },
        inspectMainBundle: () => {},
        inspectLegalArtifacts: () => {},
      }),
    ).rejects.toThrow(/launch failed/);

    expect(killTree).toHaveBeenCalledWith(776, { platform: 'linux' });
  });

  it('gives Linux a bounded graceful-close window before reaping the tree', async () => {
    const { targetPath } = fixturePackage({ platform: 'linux', arch: 'x64' });
    const child = new EventEmitter();
    child.pid = 778;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const events = [];
    const killTree = vi.fn(() => {
      events.push('reaped');
      return { ok: true, remainingPids: [], signalled: ['group:SIGTERM'] };
    });

    const result = await runPackagedSmoke(targetPath, {
      platform: 'linux',
      arch: 'x64',
      gracefulCloseTimeoutMs: 10,
      killTree,
      spawnImpl: (_binary, _args, opts) => {
        queueMicrotask(() => {
          const marker = packagedSmokeMarkerPath(opts.env.NEXUS_USER_DATA_DIR);
          // The real runner writes this marker before emitting functional-ready.
          fs.mkdirSync(path.dirname(marker), { recursive: true });
          fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
          events.push('ready');
          child.stdout.emit(
            'data',
            Buffer.from(
              '[smoke] renderer-mounted\n' +
                '[smoke] functional-ready: 20 probes\n' +
                '[smoke] shutdown-complete: physical PTY inventory proven\n',
            ),
          );
        });
        return child;
      },
      inspectMainBundle: () => {},
      inspectLegalArtifacts: () => {},
    });

    expect(result.code).toBe(0);
    expect(events).toEqual(['ready', 'reaped']);
    expect(killTree).toHaveBeenCalledWith(778, { platform: 'linux' });
    expect(result.treeProof?.ok).toBe(true);
    expect(result.shutdownMode).toBe('external-reap');
  });

  it('does not reap when the app closes itself after functional readiness', async () => {
    const { targetPath } = fixturePackage({ platform: 'darwin', arch: 'arm64' });
    const child = new EventEmitter();
    child.pid = 779;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const killTree = vi.fn();
    const listTreePids = vi.fn(() => []);

    const result = await runPackagedSmoke(targetPath, {
      platform: 'darwin',
      arch: 'arm64',
      gracefulCloseTimeoutMs: 20,
      requireGracefulClose: true,
      killTree,
      listTreePids,
      spawnImpl: (_binary, _args, opts) => {
        queueMicrotask(() => {
          const marker = packagedSmokeMarkerPath(opts.env.NEXUS_USER_DATA_DIR);
          fs.mkdirSync(path.dirname(marker), { recursive: true });
          fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
          child.stdout.emit(
            'data',
            Buffer.from(
              '[smoke] renderer-mounted\n' +
                '[smoke] functional-ready: 20 probes\n' +
                '[smoke] shutdown-complete: physical PTY inventory proven\n',
            ),
          );
          child.emit('close', 0, null);
        });
        return child;
      },
      inspectMainBundle: () => {},
      inspectLegalArtifacts: () => {},
    });

    expect(result.code).toBe(0);
    expect(result.shutdownMode).toBe('graceful');
    expect(result.treeProof?.signalled).toEqual([]);
    expect(listTreePids).toHaveBeenCalledWith(779, { platform: 'darwin' });
    expect(killTree).not.toHaveBeenCalled();
  });

  it('rejects a macOS root exit without the main-owned shutdown proof', async () => {
    const { targetPath } = fixturePackage({ platform: 'darwin', arch: 'arm64' });
    const child = new EventEmitter();
    child.pid = 7790;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    await expect(
      runPackagedSmoke(targetPath, {
        platform: 'darwin',
        arch: 'arm64',
        gracefulCloseTimeoutMs: 20,
        requireGracefulClose: true,
        killTree: vi.fn(),
        listTreePids: () => [],
        spawnImpl: (_binary, _args, opts) => {
          queueMicrotask(() => {
            const marker = packagedSmokeMarkerPath(
              opts.env.NEXUS_USER_DATA_DIR,
            );
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
            child.stdout.emit(
              'data',
              Buffer.from(
                '[smoke] renderer-mounted\n' +
                  '[smoke] functional-ready: 20 probes\n',
              ),
            );
            child.emit('close', 0, null);
          });
          return child;
        },
        inspectMainBundle: () => {},
        inspectLegalArtifacts: () => {},
      }),
    ).rejects.toThrow(/main-owned shutdown-complete proof/);
  });

  it('rejects a natural non-zero close after readiness on Linux', async () => {
    const { targetPath } = fixturePackage({ platform: 'linux', arch: 'x64' });
    const child = new EventEmitter();
    child.pid = 77901;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    await expect(
      runPackagedSmoke(targetPath, {
        platform: 'linux',
        arch: 'x64',
        gracefulCloseTimeoutMs: 20,
        listTreePids: () => [],
        spawnImpl: (_binary, _args, opts) => {
          queueMicrotask(() => {
            const marker = packagedSmokeMarkerPath(
              opts.env.NEXUS_USER_DATA_DIR,
            );
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
            child.stdout.emit(
              'data',
              Buffer.from(
                '[smoke] renderer-mounted\n' +
                  '[smoke] functional-ready: 20 probes\n',
              ),
            );
            child.emit('close', 7, null);
          });
          return child;
        },
        inspectMainBundle: () => {},
        inspectLegalArtifacts: () => {},
      }),
    ).rejects.toThrow(/successful natural close.*exit=7/);
  });

  it('lets a naturally closing helper drain before the grace deadline', async () => {
    const { targetPath } = fixturePackage({ platform: 'darwin', arch: 'arm64' });
    const child = new EventEmitter();
    child.pid = 7791;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const killTree = vi.fn();
    const listTreePids = vi
      .fn()
      .mockReturnValueOnce([7792])
      .mockReturnValueOnce([]);

    const result = await runPackagedSmoke(targetPath, {
      platform: 'darwin',
      arch: 'arm64',
      gracefulCloseTimeoutMs: 100,
      requireGracefulClose: true,
      killTree,
      listTreePids,
      classifyRemaining: (pids) => ({
        orphans: pids,
        kernelExiting: [],
        warnings: [],
      }),
      spawnImpl: (_binary, _args, opts) => {
        queueMicrotask(() => {
          const marker = packagedSmokeMarkerPath(opts.env.NEXUS_USER_DATA_DIR);
          fs.mkdirSync(path.dirname(marker), { recursive: true });
          fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
          child.stdout.emit(
            'data',
            Buffer.from(
              '[smoke] renderer-mounted\n' +
                '[smoke] functional-ready: 20 probes\n' +
                '[smoke] shutdown-complete: physical PTY inventory proven\n',
            ),
          );
          child.emit('close', 0, null);
        });
        return child;
      },
      inspectMainBundle: () => {},
      inspectLegalArtifacts: () => {},
    });

    expect(result.shutdownMode).toBe('graceful');
    expect(listTreePids).toHaveBeenCalledTimes(2);
    expect(killTree).not.toHaveBeenCalled();
  });

  it('fails macOS local proof after bounded fallback reaping', async () => {
    const { targetPath } = fixturePackage({ platform: 'darwin', arch: 'arm64' });
    const child = new EventEmitter();
    child.pid = 780;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const killTree = vi.fn(() => ({
      ok: true,
      remainingPids: [],
      signalled: ['group:SIGTERM'],
    }));

    await expect(
      runPackagedSmoke(targetPath, {
        platform: 'darwin',
        arch: 'arm64',
        gracefulCloseTimeoutMs: 10,
        requireGracefulClose: true,
        killTree,
        spawnImpl: (_binary, _args, opts) => {
          queueMicrotask(() => {
            const marker = packagedSmokeMarkerPath(opts.env.NEXUS_USER_DATA_DIR);
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, FUNCTIONAL_SMOKE_MARKER_CONTENT);
            child.stdout.emit(
              'data',
              Buffer.from('[smoke] renderer-mounted\n[smoke] functional-ready: 20 probes\n'),
            );
          });
          return child;
        },
        inspectMainBundle: () => {},
        inspectLegalArtifacts: () => {},
      }),
    ).rejects.toThrow(
      /functional-ready but did not close gracefully within 10ms/,
    );

    expect(killTree).toHaveBeenCalledWith(780, { platform: 'darwin' });
  });
});

describe('graceful packaged shutdown contract', () => {
  it('keeps the default grace window short and below the outer timeout', () => {
    expect(GRACEFUL_CLOSE_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    expect(GRACEFUL_CLOSE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('detectPackagedTargetArch', () => {
  const lipoReporting = (stdout, status = 0) => () => ({ status, stdout });

  it('validates a cross-built darwin/x64 app as x64 on an arm64 host', async () => {
    const { detectPackagedTargetArch } = await import('./smoke-packaged-app.mjs');
    const arch = detectPackagedTargetArch('/tmp/NexusIDE.app/Contents/MacOS/nexus-ide', {
      platform: 'darwin',
      fallbackArch: 'arm64',
      runLipo: lipoReporting('x86_64\n'),
    });
    expect(arch).toBe('x64');
  });

  it('keeps the host arch for a universal binary so the launch stays native', async () => {
    const { detectPackagedTargetArch } = await import('./smoke-packaged-app.mjs');
    const arch = detectPackagedTargetArch('/tmp/bin', {
      platform: 'darwin',
      fallbackArch: 'arm64',
      runLipo: lipoReporting('x86_64 arm64\n'),
    });
    expect(arch).toBe('arm64');
  });

  it('falls back to the host arch when lipo fails or reports nothing usable', async () => {
    const { detectPackagedTargetArch } = await import('./smoke-packaged-app.mjs');
    expect(detectPackagedTargetArch('/tmp/bin', {
      platform: 'darwin',
      fallbackArch: 'arm64',
      runLipo: lipoReporting('', 1),
    })).toBe('arm64');
    expect(detectPackagedTargetArch('/tmp/bin', {
      platform: 'darwin',
      fallbackArch: 'arm64',
      runLipo: lipoReporting('ppc64\n'),
    })).toBe('arm64');
  });

  it('is a no-op outside darwin', async () => {
    const { detectPackagedTargetArch } = await import('./smoke-packaged-app.mjs');
    const arch = detectPackagedTargetArch('/tmp/bin', {
      platform: 'linux',
      fallbackArch: 'x64',
      runLipo: () => {
        throw new Error('must not be called');
      },
    });
    expect(arch).toBe('x64');
  });
});
