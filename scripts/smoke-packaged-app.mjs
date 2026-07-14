import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { extractFile as extractAsarFile } from '@electron/asar';
import { constants as fsConstants, existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 70_000;
const MAX_LOG_CHARS = 32_000;
const PACKAGED_MAIN_BUNDLE_PATH = '.vite/build/main.js';
const PACKAGED_NOTICE_PATH = 'THIRD_PARTY_NOTICES.md';
const PACKAGED_LICENSE_PATHS = [
  'third_party/licenses/Apache-2.0.txt',
  'third_party/licenses/OFL-1.1.txt',
];
const PACKAGED_WAKE_MANIFEST_PATH = 'wake/manifest.json';
const REQUIRED_WAKE_MODEL_FILE = 'ei-jarvis-ptbr.onnx';
const PRODUCT_NAME = 'NexusIDE';
const EXECUTABLE_NAME = 'nexus-ide';
const PACKAGED_SMOKE_ARGUMENT = 'nexus-smoke-test';
/** Must match FUNCTIONAL_SMOKE_FILE_CONTENT in src/shared/smoke-types.ts. */
const FUNCTIONAL_SMOKE_MARKER_CONTENT = 'nexus-functional-smoke\n';
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const SUPPORTED_ARCHES = new Set(['arm64', 'x64']);
const BLOCKED_ENVIRONMENT_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NEXUS_BACKEND_URL',
  'NEXUS_CRON_ALLOW_INSECURE_LOCALHOST_TEST',
  'NEXUS_CRON_BACKEND_URL',
  'NEXUS_REMOTE_DEBUG',
  'NEXUS_SYNC_ALLOW_INSECURE_LOCALHOST_TEST',
  'NEXUS_SYNC_BACKEND_URL',
  'SSLKEYLOGFILE',
]);
const SENSITIVE_ENVIRONMENT_KEY =
  /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)$/iu;

export {
  TIMEOUT_MS,
  PRODUCT_NAME,
  EXECUTABLE_NAME,
  PACKAGED_SMOKE_ARGUMENT,
  FUNCTIONAL_SMOKE_MARKER_CONTENT,
  SUPPORTED_PLATFORMS,
  SUPPORTED_ARCHES,
};

export function resolveAppArgument(args) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--app' || !args[1]) {
    throw new Error(
      'usage: smoke-packaged-app.mjs [--app /path/to/packaged-app]',
    );
  }
  return path.resolve(args[1]);
}

/**
 * Default electron-forge package output for the host target.
 * darwin → out/NexusIDE-darwin-<arch>/NexusIDE.app
 * linux  → out/NexusIDE-linux-<arch>/nexus-ide
 * win32  → out/NexusIDE-win32-<arch>/nexus-ide.exe
 */
export function defaultPackagedTargetPath({
  platform = process.platform,
  arch = process.arch,
  cwd = process.cwd(),
} = {}) {
  assertSupportedTarget(platform, arch);
  const outDir = path.join(cwd, 'out', `${PRODUCT_NAME}-${platform}-${arch}`);
  if (platform === 'darwin') {
    return path.join(outDir, `${PRODUCT_NAME}.app`);
  }
  if (platform === 'win32') {
    return path.join(outDir, `${EXECUTABLE_NAME}.exe`);
  }
  return path.join(outDir, EXECUTABLE_NAME);
}

function assertSupportedTarget(platform, arch) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`unsupported packaged smoke platform: ${platform}`);
  }
  if (!SUPPORTED_ARCHES.has(arch)) {
    throw new Error(`unsupported packaged smoke arch: ${arch}`);
  }
}

/**
 * Resolve a CLI/default target into binary + resource roots for the platform.
 * Accepts the forge package directory, the .app bundle, or the main executable.
 */
export function resolvePackagedTarget(
  targetPath,
  { platform = process.platform, arch = process.arch } = {},
) {
  assertSupportedTarget(platform, arch);
  if (!targetPath) {
    throw new Error('packaged smoke target path is required');
  }
  const resolved = path.resolve(targetPath);

  if (platform === 'darwin') {
    return resolveDarwinTarget(resolved);
  }
  if (platform === 'win32') {
    return resolveWindowsTarget(resolved);
  }
  return resolveLinuxTarget(resolved);
}

function resolveDarwinTarget(resolved) {
  let appPath = resolved;
  if (!appPath.endsWith('.app')) {
    const nested = path.join(resolved, `${PRODUCT_NAME}.app`);
    if (existsSync(nested)) {
      appPath = nested;
    } else {
      throw new Error(
        `packaged smoke target must be a .app bundle (or its parent package dir): ${resolved}`,
      );
    }
  }
  return {
    platform: 'darwin',
    appPath,
    packageDir: path.dirname(appPath),
    binary: path.join(appPath, 'Contents', 'MacOS', EXECUTABLE_NAME),
    resourcesDir: path.join(appPath, 'Contents', 'Resources'),
    unpackedRoot: path.join(
      appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
    ),
  };
}

function resolveWindowsTarget(resolved) {
  const lower = resolved.toLowerCase();
  let packageDir;
  let binary;
  if (lower.endsWith('.exe')) {
    binary = resolved;
    packageDir = path.dirname(resolved);
  } else {
    packageDir = resolved;
    binary = path.join(packageDir, `${EXECUTABLE_NAME}.exe`);
  }
  return {
    platform: 'win32',
    appPath: packageDir,
    packageDir,
    binary,
    resourcesDir: path.join(packageDir, 'resources'),
    unpackedRoot: path.join(packageDir, 'resources', 'app.asar.unpacked'),
  };
}

function resolveLinuxTarget(resolved) {
  let packageDir;
  let binary;
  const base = path.basename(resolved);
  if (base === EXECUTABLE_NAME) {
    // Executable path when it is a file or does not exist yet; directory only
    // when the path already exists as a folder (rare forge layout).
    if (existsSync(resolved) && isDirSync(resolved)) {
      packageDir = resolved;
      binary = path.join(packageDir, EXECUTABLE_NAME);
    } else {
      binary = resolved;
      packageDir = path.dirname(resolved);
    }
  } else {
    packageDir = resolved;
    binary = path.join(packageDir, EXECUTABLE_NAME);
  }
  return {
    platform: 'linux',
    appPath: packageDir,
    packageDir,
    binary,
    resourcesDir: path.join(packageDir, 'resources'),
    unpackedRoot: path.join(packageDir, 'resources', 'app.asar.unpacked'),
  };
}

function isDirSync(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** @deprecated Prefer resolvePackagedTarget; kept for callers/tests. */
export function packagedBinaryForApp(appPath, platform = process.platform) {
  return resolvePackagedTarget(appPath, { platform }).binary;
}

/**
 * Electron/Chromium can consume an unknown --switch before application code
 * sees process.argv. Use a positional sentinel for the app mode and a native
 * Chromium profile switch as a second isolation barrier.
 */
export function packagedSmokeArgs(userData, platform = process.platform) {
  const isolatedUserData = path.resolve(userData);
  const args = [
    PACKAGED_SMOKE_ARGUMENT,
    `--user-data-dir=${isolatedUserData}`,
  ];
  // GitHub-hosted Linux runners do not grant the user namespace required by
  // Chromium's setuid sandbox. This flag is scoped to the packaged smoke
  // harness; normal Linux launches remain sandboxed and unchanged.
  if (platform === 'linux') {
    args.unshift('--no-sandbox');
  }
  return args;
}

/** Keep every filesystem default scoped to the temporary smoke directory. */
export function packagedSmokeEnvironment(baseEnv, userData) {
  const isolatedUserData = path.resolve(userData);
  const home = path.join(isolatedUserData, 'home');
  const tmp = path.join(isolatedUserData, 'tmp');
  // Windows profile keys are set even on POSIX hosts so the matrix of isolation
  // is complete and unit-testable without running on Windows.
  return {
    ...sanitizedSmokeEnvironment(baseEnv),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    NEXUS_USER_DATA_DIR: isolatedUserData,
    // The packaged functional probe covers the product-wave IPC surface too.
    // Keep this test-only override explicit; normal packaged launches remain
    // fail-closed and use the persisted feature-flag policy.
    NEXUS_FORCE_ALL_FLAGS: '1',
  };
}

function sanitizedSmokeEnvironment(baseEnv) {
  return Object.fromEntries(
    Object.entries(baseEnv).filter(
      ([key, value]) =>
        typeof value === 'string' &&
        !BLOCKED_ENVIRONMENT_KEYS.has(key) &&
        !SENSITIVE_ENVIRONMENT_KEY.test(key),
    ),
  );
}

export function packagedSmokeSpawnOptions(userData, baseEnv, platform = process.platform) {
  return {
    env: packagedSmokeEnvironment(baseEnv, userData),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    // New process group on POSIX so timeout can SIGKILL the whole Electron tree.
    detached: platform !== 'win32',
    windowsHide: platform === 'win32',
  };
}

/** Functional smoke creates this file under app.getPath('userData'). */
export function packagedSmokeMarkerPath(userData) {
  return path.join(
    path.resolve(userData),
    'functional-smoke-workspace',
    'smoke.txt',
  );
}

export function assertPackagedSmokeProof(code, output) {
  if (code !== 0) {
    throw new Error(`packaged smoke exited ${String(code)}\n${output}`);
  }
  if (!output.includes('[smoke] renderer-mounted')) {
    throw new Error(`packaged smoke exited without renderer proof\n${output}`);
  }
  if (!output.includes('[smoke] functional-ready')) {
    const failed = output.match(/\[smoke\] functional-failed[^\n]*/u)?.[0];
    throw new Error(
      `packaged smoke exited without functional proof${failed ? ` (${failed})` : ''}\n${output}`,
    );
  }
  assertNoNativeLoadFailure(output);
}

/**
 * Vite's CJS main build must not erase import.meta.url before createRequire.
 * When it does, Electron throws during module evaluation, before the smoke
 * handler can suppress the native error dialog, and the release job times out.
 */
export function assertPackagedMainBundleBootable(bundle) {
  const source = Buffer.isBuffer(bundle) ? bundle.toString('utf8') : String(bundle);
  if (/createRequire[^;]{0,128}\(\{\}\.url\)/u.test(source)) {
    throw new Error(
      'packaged main bundle calls createRequire with undefined because import.meta.url was erased; use an absolute CommonJS filename',
    );
  }
}

export function inspectPackagedMainBundle(resourcesDir) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  let bundle;
  try {
    bundle = extractAsarFile(asarPath, PACKAGED_MAIN_BUNDLE_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not inspect packaged main bundle: ${message}`);
  }
  assertPackagedMainBundleBootable(bundle);
}

export function inspectPackagedLegalArtifacts(resourcesDir) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  let notice;
  try {
    notice = extractAsarFile(asarPath, PACKAGED_NOTICE_PATH).toString('utf8');
    for (const licensePath of PACKAGED_LICENSE_PATHS) {
      const license = extractAsarFile(asarPath, licensePath);
      if (license.length === 0) {
        throw new Error(`${licensePath} is empty`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`packaged legal artifacts are incomplete: ${message}`);
  }
  if (
    !notice.includes('Onlook CSS-to-Tailwind translator') ||
    !notice.includes('onlook-dev/onlook')
  ) {
    throw new Error('packaged third-party notice is missing Onlook attribution');
  }
}

/** A release without the trained PT-BR default model is not a valid Nexus build. */
export async function inspectPackagedWakeModel(resourcesDir) {
  const wakeDir = path.join(resourcesDir, 'wake');
  const manifestPath = path.join(resourcesDir, PACKAGED_WAKE_MANIFEST_PATH);
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const model = manifest?.defaultModel;
    if (
      manifest?.schemaVersion !== 1 ||
      model?.file !== REQUIRED_WAKE_MODEL_FILE ||
      model?.locale !== 'pt-BR' ||
      model?.required !== true ||
      model?.wakePhrase !== 'Ei Jarvis' ||
      !/^[a-f0-9]{64}$/u.test(model?.sha256 ?? '')
    ) {
      throw new Error('wake manifest does not declare the required PT-BR default');
    }
    const modelPath = path.join(wakeDir, REQUIRED_WAKE_MODEL_FILE);
    const bytes = await fs.readFile(modelPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== model.sha256) {
      throw new Error(`wake model checksum mismatch: ${sha256}`);
    }
    return Object.freeze({ path: modelPath, sha256, bytes: bytes.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`packaged PT-BR wake model is missing or invalid: ${message}`);
  }
}

/**
 * Fail if the log shows a native binding load crash (presence on disk is not enough).
 */
export function assertNoNativeLoadFailure(output) {
  const patterns = [
    /Cannot find module ['"]better-sqlite3['"]/u,
    /Cannot find module ['"]@lydell\/node-pty/u,
    /NODE_MODULE_VERSION/u,
    /was compiled against a different Node\.js version/u,
    /error while loading shared libraries/iu,
    /The specified module could not be found/u,
  ];
  for (const pattern of patterns) {
    if (pattern.test(output)) {
      throw new Error(
        `packaged smoke reported a native module load failure\n${output}`,
      );
    }
  }
}

export async function assertFunctionalMarker(userData) {
  const markerPath = packagedSmokeMarkerPath(userData);
  const content = await fs.readFile(markerPath, 'utf8');
  if (content !== FUNCTIONAL_SMOKE_MARKER_CONTENT) {
    throw new Error(
      `functional smoke marker content mismatch at ${markerPath}: ${JSON.stringify(content)}`,
    );
  }
  return markerPath;
}

/**
 * Expected on-disk native artifacts under app.asar.unpacked for a forge package.
 * Paths are relative to the unpacked root.
 */
export function requiredNativeArtifactGlobs({ platform, arch }) {
  assertSupportedTarget(platform, arch);
  const ptyPackage = `@lydell/node-pty-${platform}-${arch}`;
  const prebuildDir = `node_modules/${ptyPackage}/prebuilds/${platform}-${arch}`;
  const artifacts = [
    {
      id: 'webrtc-aec3-wasm',
      anyOf: [
        'node_modules/@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm',
      ],
    },
    {
      id: 'tesseract-worker',
      anyOf: ['node_modules/tesseract.js/src/worker-script/node/index.js'],
    },
    {
      id: 'tesseract-core',
      anyOf: ['node_modules/tesseract.js-core/index.js'],
    },
    {
      id: 'tesseract-wasm-feature-detect',
      anyOf: ['node_modules/wasm-feature-detect/dist/cjs/index.cjs'],
    },
    {
      id: 'better-sqlite3',
      // Prefer the rebuild output; also accept prebuild bin layout.
      anyOf: [
        'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        // Electron ABI folders vary; match via directory scan when exact path missing.
      ],
      scan: {
        under: 'node_modules/better-sqlite3',
        fileName: /^(better_sqlite3|better-sqlite3)\.node$/u,
      },
    },
    {
      id: 'node-pty',
      anyOf:
        platform === 'win32'
          ? [
              `${prebuildDir}/conpty.node`,
              `${prebuildDir}/pty.node`,
            ]
          : [`${prebuildDir}/pty.node`],
    },
    {
      id: 'onnxruntime-node',
      anyOf: [
        `node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime_binding.node`,
      ],
    },
  ];
  if (platform === 'linux') {
    artifacts.push({
      id: 'onnxruntime-linux-shared',
      anyOf: [
        `node_modules/onnxruntime-node/bin/napi-v3/linux/${arch}/libonnxruntime.so.1`,
      ],
    });
  }
  // @lydell/node-pty ships spawn-helper for macOS, while its Linux prebuild
  // uses openpty directly and intentionally contains only pty.node.
  if (platform === 'darwin') {
    artifacts.push({
      id: 'node-pty-spawn-helper',
      anyOf: [`${prebuildDir}/spawn-helper`],
      executable: true,
    });
  }
  return artifacts;
}

/**
 * Verify native modules and helpers exist outside the asar (loadable at runtime).
 * Returns the resolved absolute paths per artifact id.
 */
export async function assertNativeArtifactsPresent(
  unpackedRoot,
  { platform = process.platform, arch = process.arch } = {},
) {
  const specs = requiredNativeArtifactGlobs({ platform, arch });
  const found = {};
  const missing = [];

  for (const spec of specs) {
    let hit = null;
    for (const relative of spec.anyOf ?? []) {
      const absolute = path.join(unpackedRoot, relative);
      if (await pathExists(absolute)) {
        hit = absolute;
        break;
      }
    }
    if (!hit && spec.scan) {
      hit = await findFileByName(
        path.join(unpackedRoot, spec.scan.under),
        spec.scan.fileName,
      );
    }
    if (!hit) {
      missing.push(spec.id);
    } else {
      if (spec.executable) {
        await fs.access(hit, fsConstants.X_OK).catch(() => {
          throw new Error(`packaged native helper is not executable: ${hit}`);
        });
      }
      found[spec.id] = hit;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `packaged native artifacts missing under ${unpackedRoot}: ${missing.join(', ')}`,
    );
  }
  return found;
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findFileByName(root, fileNamePattern) {
  if (!(await pathExists(root))) return null;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (fileNamePattern.test(entry.name)) {
        return full;
      }
    }
  }
  return null;
}

/**
 * Terminate the Electron process tree. On POSIX the child is spawned detached
 * (new process group); kill(-pid) reaps helpers. On Windows use taskkill /T.
 */
export function killProcessTree(
  pid,
  {
    platform = process.platform,
    kill = process.kill.bind(process),
    runSync = spawnSync,
  } = {},
) {
  if (!pid || pid <= 0) return;
  if (platform === 'win32') {
    runSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    return;
  }
  try {
    kill(-pid, 'SIGKILL');
  } catch {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      // Process already exited.
    }
  }
}

/**
 * Honest cross-platform status. Unit/structural coverage never upgrades a
 * foreign OS to "testado localmente".
 */
export function packagedSmokeValidationMatrix({
  hostPlatform = process.platform,
  runtimeExecuted = false,
  runtimePlatform = null,
} = {}) {
  const platforms = ['darwin', 'linux', 'win32'];
  /** @type {Record<string, { structural: boolean, localRuntime: boolean, status: string }>} */
  const matrix = {};
  for (const platform of platforms) {
    const structural = true;
    const localRuntime =
      runtimeExecuted === true &&
      runtimePlatform === platform &&
      hostPlatform === platform;
    matrix[platform] = {
      structural,
      localRuntime,
      status: localRuntime ? 'testado localmente' : 'apenas estrutural',
    };
  }
  return matrix;
}

export function formatValidationMatrix(matrix) {
  return ['darwin', 'linux', 'win32']
    .map((platform) => `${platform}: ${matrix[platform].status}`)
    .join('\n');
}

export async function runPackagedSmoke(
  targetPath,
  {
    platform = process.platform,
    arch = process.arch,
    timeoutMs = TIMEOUT_MS,
    spawnImpl = spawn,
    env = process.env,
    killTree = killProcessTree,
    inspectMainBundle = inspectPackagedMainBundle,
    inspectLegalArtifacts = inspectPackagedLegalArtifacts,
    inspectWakeModel = inspectPackagedWakeModel,
  } = {},
) {
  const target = resolvePackagedTarget(targetPath, { platform, arch });
  await fs.access(
    target.binary,
    platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK,
  );
  await assertNativeArtifactsPresent(target.unpackedRoot, { platform, arch });
  inspectMainBundle(target.resourcesDir);
  inspectLegalArtifacts(target.resourcesDir);
  await inspectWakeModel(target.resourcesDir);

  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexus-packaged-smoke-'),
  );
  await fs.mkdir(path.join(userData, 'home'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(userData, 'tmp'), { recursive: true, mode: 0o700 });

  let output = '';
  let runtimeExecuted = false;

  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawnImpl(
        target.binary,
        packagedSmokeArgs(userData, platform),
        packagedSmokeSpawnOptions(userData, env, platform),
      );
      runtimeExecuted = true;
      const append = (chunk) => {
        output = (output + chunk.toString()).slice(-MAX_LOG_CHARS);
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      let settled = false;
      let timeout;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn(value);
      };
      child.once('error', (error) => finish(reject, error));

      timeout = setTimeout(() => {
        killTree(child.pid, { platform });
        const captured = output.trim();
        finish(
          reject,
          new Error(
            `packaged smoke timed out after ${timeoutMs}ms` +
              (captured ? `\n${captured}` : '\n<no packaged app output captured>'),
          ),
        );
      }, timeoutMs);
      timeout.unref?.();

      child.once('close', (exitCode) => finish(resolve, exitCode));
    });

    assertPackagedSmokeProof(code, output);
    await assertFunctionalMarker(userData);
    process.stdout.write(output);

    const matrix = packagedSmokeValidationMatrix({
      hostPlatform: process.platform,
      runtimeExecuted: runtimeExecuted && spawnImpl === spawn,
      runtimePlatform: platform,
    });
    process.stdout.write(
      `\n[smoke] validation-matrix\n${formatValidationMatrix(matrix)}\n`,
    );
    return { code, output, matrix, target };
  } finally {
    await fs.rm(userData, { recursive: true, force: true });
  }
}

async function main() {
  const platform = process.platform;
  const arch = process.arch;
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`packaged smoke does not support platform: ${platform}`);
  }
  if (!SUPPORTED_ARCHES.has(arch)) {
    throw new Error(`packaged smoke does not support arch: ${arch}`);
  }

  const explicit = resolveAppArgument(process.argv.slice(2));
  const targetPath = explicit ?? defaultPackagedTargetPath({ platform, arch });
  await runPackagedSmoke(targetPath, { platform, arch });
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
