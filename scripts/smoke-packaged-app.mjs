import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { extractFile as extractAsarFile, listPackage } from '@electron/asar';
import { constants as fsConstants, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 100 s: duas sondas de eco de PTY podem esperar até 15 s cada sob carga
// (ver PTY_ECHO_WAIT_MS no preload) sem estourar o prazo do smoke inteiro.
const TIMEOUT_MS = 100_000;
// Darwin supervisor proof has no give-up deadline once SIGTERM is in flight;
// the app may legitimately take tens of seconds to emit shutdown-complete for
// a live shell pane under the signed responsibility cohort.
const GRACEFUL_CLOSE_TIMEOUT_MS = 45_000;
const PROCESS_TREE_POLL_MS = 50;
// Hard cap for the post-kill process-tree proof. Kernel-exiting (E) and
// zombie (Z) pids never leave `ps` on a wedged host; waiting on them is how
// the packaged smoke hung. Live S/R/T leftovers still fail, but the wait
// itself must terminate with a diagnosis.
const PROCESS_TREE_PROOF_TIMEOUT_MS = 60_000;
const MAX_LOG_CHARS = 32_000;
const PACKAGED_MAIN_BUNDLE_PATH = '.vite/build/main.js';
const PACKAGED_NOTICE_PATH = 'THIRD_PARTY_NOTICES.md';
// Official v1.19.2 redistribution texts, pinned to upstream ffceed9d44f2.
// Provenance: third_party/provenance/onnxruntime-v1.19.2.json.
const PINNED_RUNTIME_LICENSES = {
  'third_party/licenses/onnxruntime-v1.19.2-MIT.txt':
    '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c',
  'third_party/licenses/onnxruntime-v1.19.2-ThirdPartyNotices.txt':
    'cf7342f7ba482ef715ae58f5f497a8d3564fa255164175aea324cd293c5701a0',
};
// Distribution bytes qualified from Electron v43.7.4 Darwin; see F-882.
const MAC_ELECTRON_VERSION = '43.7.4';
const MAC_ELECTRON_LEGAL_FILES = [
  { name: 'LICENSE', bytes: 1096, sha256: '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d' },
  { name: 'LICENSES.chromium.html', bytes: 19956022, sha256: '7ae82e97b8a60b9d97871e0e11a05285aea2d42bef665f93f6a4f415235839ed' },
];
const PACKAGED_LICENSE_PATHS = [
  'third_party/licenses/Apache-2.0.txt',
  'third_party/licenses/OFL-1.1.txt',
  ...Object.keys(PINNED_RUNTIME_LICENSES),
];
const PACKAGED_WAKE_MANIFEST_PATH = 'wake/manifest.json';
const REQUIRED_WAKE_MODEL_FILE = 'ei-jarvis-ptbr.onnx';
const PRODUCT_NAME = 'NexusIDE';
const EXECUTABLE_NAME = 'nexus-ide';
const PACKAGED_SMOKE_ARGUMENT = 'nexus-smoke-test';
const WINDOWS_RUNTIME_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
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
  GRACEFUL_CLOSE_TIMEOUT_MS,
  PROCESS_TREE_PROOF_TIMEOUT_MS,
  PRODUCT_NAME,
  EXECUTABLE_NAME,
  PACKAGED_SMOKE_ARGUMENT,
  FUNCTIONAL_SMOKE_MARKER_CONTENT,
  WINDOWS_RUNTIME_ICON_SIZES,
  SUPPORTED_PLATFORMS,
  SUPPORTED_ARCHES,
};

/**
 * `icon.ico` is deliberately shipped outside app.asar for BrowserWindow's
 * Windows runtime fallback. Keep this release gate separate from the source
 * icon builder: it proves Forge did not drop or truncate the copied resource.
 */
export function assertPackagedWindowsRuntimeIcon(resourcesDir) {
  const iconPath = path.join(resourcesDir, 'icon.ico');
  let ico;
  try {
    ico = readFileSync(iconPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`packaged Windows runtime ICO is missing: ${detail}`);
  }
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error('packaged Windows runtime ICO has an invalid header');
  }
  const count = ico.readUInt16LE(4);
  const directoryEnd = 6 + count * 16;
  if (count !== WINDOWS_RUNTIME_ICON_SIZES.length || directoryEnd > ico.length) {
    throw new Error('packaged Windows runtime ICO has an invalid directory');
  }

  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    const size = ico[at] === 0 ? 256 : ico[at];
    const bytes = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    if (bytes === 0 || offset < directoryEnd || offset + bytes > ico.length) {
      throw new Error(`packaged Windows runtime ICO has an invalid ${size}px entry`);
    }
    sizes.push(size);
  }
  if (sizes.join(',') !== WINDOWS_RUNTIME_ICON_SIZES.join(',')) {
    throw new Error(
      `packaged Windows runtime ICO sizes are ${sizes.join(',')} ` +
        `(expected ${WINDOWS_RUNTIME_ICON_SIZES.join(',')})`,
    );
  }
  return { path: iconPath, sizes };
}

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

const DARWIN_ARCH_ALIASES = new Map([
  ['arm64', 'arm64'],
  ['x86_64', 'x64'],
]);

/**
 * A cross-built app must be validated against ITS architecture, not the
 * host's: packaging prunes foreign-arch native payloads, so probing a
 * darwin/x64 bundle for the arm64 host's artifacts demands files that are
 * correctly absent. Read the arch from the Mach-O binary; a universal binary
 * keeps the fallback so the smoke launch stays native.
 */
export function detectPackagedTargetArch(
  binaryPath,
  {
    platform = process.platform,
    fallbackArch = process.arch,
    runLipo = (target) =>
      spawnSync('/usr/bin/lipo', ['-archs', target], { encoding: 'utf8' }),
  } = {},
) {
  if (platform !== 'darwin') return fallbackArch;
  const result = runLipo(binaryPath);
  if (result.status !== 0 || !result.stdout) return fallbackArch;
  const archs = result.stdout
    .trim()
    .split(/\s+/u)
    .map((name) => DARWIN_ARCH_ALIASES.get(name))
    .filter((name) => name && SUPPORTED_ARCHES.has(name));
  if (archs.length === 0) return fallbackArch;
  return archs.includes(fallbackArch) ? fallbackArch : archs[0];
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
    // Confined to the packaged smoke harness. UtilityProcess PTY ownership may
    // admit a consistent ad-hoc local package chain only when this marker is set;
    // normal launches keep the Team ID ownership boundary.
    NEXUS_PACKAGED_SMOKE: '1',
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

export function assertPackagedSmokeProof(code, output, { requireMainOwnedCommand = false } = {}) {
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
  if (requireMainOwnedCommand) {
    const lines = output.split('\n').filter(line => line.startsWith('[smoke] main-owned-command '));
    let proof;
    try { proof = lines.length === 1 ? JSON.parse(lines[0].slice('[smoke] main-owned-command '.length)) : null; } catch { proof = null; }
    if (proof?.status !== 'passed' || proof.exitCode !== 0 || proof.physicalExitProven !== true ||
        proof.densePathFiles !== 768 || !Number.isSafeInteger(proof.profileBytes) || proof.profileBytes <= 0 || proof.profileBytes > 65536) {
      throw new Error('packaged smoke lacks a valid Main-owned command proof');
    }
    return { status: 'passed', densePathFiles: 768, profileBytes: proof.profileBytes, exitCode: 0, physicalExitProven: true };
  }
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

/**
 * Forge/Vite has emitted the main bundle under both the root `.vite` path and
 * an `app/.vite` path across Electron/Forge versions and host runners. Keep
 * the smoke contract strict about the file itself while tolerating that
 * packaging-root variation.
 */
export function resolvePackagedMainBundlePath(entries, declaredMain = null) {
  const target = PACKAGED_MAIN_BUNDLE_PATH;
  const normalizedDeclared =
    typeof declaredMain === 'string'
      ? declaredMain
          .replaceAll('\\', '/')
          .replace(/^\.\//u, '')
          .replace(/^\/+/, '')
      : null;
  const candidates = entries
    .filter((entry) => typeof entry === 'string')
    .map((entry) =>
      entry
        .replaceAll('\\', '/')
        .replace(/^\.\//u, '')
        .replace(/^\/+/, ''),
    )
    .filter((entry) =>
      normalizedDeclared
        ? entry === normalizedDeclared || entry.endsWith(`/${normalizedDeclared}`)
        : entry === target || entry.endsWith(`/${target}`),
    )
    .sort((left, right) => left.length - right.length);
  return candidates[0] ?? null;
}

export function toHostAsarPath(entry, separator = path.sep) {
  return entry
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .split('/')
    .join(separator);
}

function extractPackagedAsarFile(asarPath, entry) {
  return extractAsarFile(asarPath, toHostAsarPath(entry));
}

export function inspectPackagedMainBundle(resourcesDir) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  let bundle;
  try {
    bundle = extractPackagedAsarFile(asarPath, PACKAGED_MAIN_BUNDLE_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let declaredMain = null;
    try {
      const packageJson = JSON.parse(
        extractPackagedAsarFile(asarPath, 'package.json').toString('utf8'),
      );
      declaredMain = packageJson?.main ?? null;
    } catch {
      // Fall back to the conventional Vite path when package metadata is
      // unavailable; the original extraction error remains authoritative.
    }
    if (typeof declaredMain === 'string') {
      const directDeclaredPath = declaredMain
        .replaceAll('\\', '/')
        .replace(/^\.\//u, '')
        .replace(/^\/+/, '');
      if (
        directDeclaredPath.length > 0 &&
        !directDeclaredPath.split('/').includes('..')
      ) {
        try {
          // The normal Forge archive stores package.json and its declared main
          // at the same root. Read that exact path first; enumerating a large
          // archive is only needed for the historical nested-root variant.
          bundle = extractPackagedAsarFile(asarPath, directDeclaredPath);
        } catch {
          // Try the package-root variation below.
        }
      }
    }
    if (!bundle) {
      try {
        const fallbackPath = resolvePackagedMainBundlePath(
          listPackage(asarPath),
          declaredMain,
        );
        if (fallbackPath) {
          bundle = extractPackagedAsarFile(asarPath, fallbackPath);
        }
      } catch {
        // Preserve the original extraction error below; a corrupt archive is
        // still a hard release failure, not a reason to hide the root cause.
      }
    }
    if (!bundle) {
      throw new Error(`could not inspect packaged main bundle: ${message}`);
    }
  }
  assertPackagedMainBundleBootable(bundle);

  // Vite may leave package.json pointing at a tiny stable `main.js` loader
  // while the evaluated code lives in a hashed `main-*.js` chunk. Inspecting
  // only the loader let a broken createRequire(import.meta.url) reach Electron.
  const mainChunks = listPackage(asarPath)
    .map((entry) =>
      entry
        .replaceAll('\\', '/')
        .replace(/^\.\//u, '')
        .replace(/^\/+/, ''),
    )
    .filter((entry) =>
      /(?:^|\/)\.vite\/build\/main(?:-[^/]+)?\.js$/u.test(entry),
    );
  if (mainChunks.length === 0) {
    throw new Error('could not inspect packaged main bundle: no main chunks found');
  }
  for (const chunk of mainChunks) {
    assertPackagedMainBundleBootable(extractPackagedAsarFile(asarPath, chunk));
  }
}

function inspectMacElectronLegalArtifacts(resourcesDir, arch) {
  try {
    const dir = path.join(resourcesDir, 'electron-licenses');
    if (!lstatSync(dir).isDirectory()) throw new Error('license directory is not regular');
    const manifestPath = path.join(dir, 'manifest.json');
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.size > 4096) throw new Error('manifest is missing or oversized');
    const receipt = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const sourceUrl = `https://github.com/electron/electron/releases/download/v${MAC_ELECTRON_VERSION}/electron-v${MAC_ELECTRON_VERSION}-darwin-${arch}.zip`;
    if (!SUPPORTED_ARCHES.has(arch) || receipt?.schema !== 'nexus.electron-licenses/v1' ||
        receipt.electronVersion !== MAC_ELECTRON_VERSION || receipt.platform !== 'darwin' || receipt.arch !== arch ||
        receipt.source !== 'packager-extracted-template' || receipt.sourceUrl !== sourceUrl ||
        !Array.isArray(receipt.files) || receipt.files.length !== MAC_ELECTRON_LEGAL_FILES.length) {
      throw new Error('runtime version or extracted-template provenance differs');
    }
    for (const [index, expected] of MAC_ELECTRON_LEGAL_FILES.entries()) {
      const recorded = receipt.files[index];
      if (recorded?.name !== expected.name || recorded.bytes !== expected.bytes || recorded.sha256 !== expected.sha256) {
        throw new Error(`manifest does not bind ${expected.name}`);
      }
      const file = path.join(dir, expected.name);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size !== expected.bytes ||
          createHash('sha256').update(readFileSync(file)).digest('hex') !== expected.sha256) {
        throw new Error(`distribution text ${expected.name} is absent or substituted`);
      }
    }
  } catch (error) {
    throw new Error(`Electron packaged legal resources are incomplete: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function inspectPackagedLegalArtifacts(resourcesDir, { platform = process.platform, arch = process.arch } = {}) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  let notice;
  try {
    notice = extractPackagedAsarFile(
      asarPath,
      PACKAGED_NOTICE_PATH,
    ).toString('utf8');
    for (const licensePath of PACKAGED_LICENSE_PATHS) {
      const license = extractPackagedAsarFile(asarPath, licensePath);
      if (license.length === 0) {
        throw new Error(`${licensePath} is empty`);
      }
      const expected = PINNED_RUNTIME_LICENSES[licensePath];
      if (expected && createHash('sha256').update(license).digest('hex') !== expected) {
        throw new Error(`${licensePath} does not match the pinned ONNX Runtime redistribution text`);
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
  if (platform === 'darwin') inspectMacElectronLegalArtifacts(resourcesDir, arch);
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
    {
      // In-process Keychain/Secret Service for the browser cookie import
      // (optional per-platform package of @napi-rs/keyring, N-API: no rebuild).
      id: 'napi-keyring',
      anyOf: [],
      scan: {
        under: 'node_modules/@napi-rs',
        fileName: new RegExp(`^keyring\\.${platform}-${arch}(?:-gnu|-msvc)?\\.node$`, 'u'),
      },
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
  return artifacts;
}

export async function assertNoBundledNodePtySpawnHelper(unpackedRoot) {
  const forbidden = await findFileByName(unpackedRoot, /^spawn-helper$/u);
  if (forbidden) {
    throw new Error(
      `packaged Darwin runtime contains forbidden node-pty spawn-helper: ${forbidden}`,
    );
  }
  const asarPath = path.join(path.dirname(unpackedRoot), 'app.asar');
  if (await pathExists(asarPath)) {
    const forbiddenAsarEntry = listPackage(asarPath).find((entry) =>
      /(?:^|\/)spawn-helper$/u.test(entry.replaceAll('\\', '/')),
    );
    if (forbiddenAsarEntry) {
      throw new Error(
        `packaged Darwin asar contains forbidden node-pty spawn-helper: ` +
          forbiddenAsarEntry,
      );
    }
  }
}

/**
 * Verify native modules and helpers exist outside the asar (loadable at runtime).
 * Returns the resolved absolute paths per artifact id.
 */
export async function assertNativeArtifactsPresent(
  unpackedRoot,
  { platform = process.platform, arch = process.arch } = {},
) {
  if (platform === 'darwin') {
    await assertNoBundledNodePtySpawnHelper(unpackedRoot);
  }
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
 * First run-state letter in a Darwin/Linux `ps` STAT field.
 * A leading `?` is "no controlling tty", not a state (`?Es` → `E`).
 *
 * @param {string | null | undefined} stat
 * @returns {string}
 */
export function processRunState(stat) {
  const token = String(stat ?? '').trim();
  for (const ch of token) {
    if (ch >= 'A' && ch <= 'Z') return ch;
  }
  return '';
}

/**
 * Kernel is already tearing the process down. These are not working orphans.
 *
 * @param {string | null | undefined} stat
 * @returns {boolean}
 */
export function isKernelExitingRunState(stat) {
  const state = processRunState(stat);
  return state === 'E' || state === 'Z';
}

/**
 * Parse `ps -o pid=,stat=,command=` rows.
 *
 * @param {string} stdout
 * @returns {{ pid: number, stat: string, command: string }[]}
 */
export function parseProcessStatLines(stdout) {
  /** @type {{ pid: number, stat: string, command: string }[]} */
  const rows = [];
  for (const line of String(stdout).split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/u.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      stat: match[2],
      command: match[3].trim(),
    });
  }
  return rows;
}

/**
 * Split inspected pids into live orphans vs kernel-exiting. A pid requested
 * but missing from `ps` is fail-closed as live — an unreadable row is not
 * proof of termination.
 *
 * @param {{ pid: number, stat: string, command?: string }[]} rows
 * @param {number[]} requestedPids
 * @returns {{
 *   orphans: number[],
 *   kernelExiting: number[],
 *   warnings: string[],
 * }}
 */
export function classifyProcessTreeProof(rows, requestedPids) {
  const wanted = new Set(requestedPids);
  /** @type {number[]} */
  const orphans = [];
  /** @type {number[]} */
  const kernelExiting = [];
  const seen = new Set();
  for (const row of rows) {
    if (!wanted.has(row.pid)) continue;
    seen.add(row.pid);
    if (isKernelExitingRunState(row.stat)) {
      kernelExiting.push(row.pid);
    } else {
      orphans.push(row.pid);
    }
  }
  for (const pid of requestedPids) {
    if (!seen.has(pid)) orphans.push(pid);
  }
  orphans.sort((a, b) => a - b);
  kernelExiting.sort((a, b) => a - b);
  return {
    orphans,
    kernelExiting,
    warnings: kernelExiting.map((pid) => `kernel-exiting: ${pid}`),
  };
}

export function emptyProcessTreeProof(elapsedMs = 0) {
  return { orphans: [], kernelExiting: [], elapsedMs };
}

/**
 * Read STAT/command for specific pids. Throws when `ps` cannot be read.
 *
 * @param {number[]} pids
 * @param {{ runSync?: typeof spawnSync }} [options]
 * @returns {{ pid: number, stat: string, command: string }[]}
 */
export function readProcessTreeStats(
  pids,
  { runSync = spawnSync } = {},
) {
  if (!pids.length) return [];
  const result = runSync(
    'ps',
    ['-o', 'pid=,stat=,command=', '-p', pids.join(',')],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    },
  );
  if (
    result.error ||
    result.status !== 0 ||
    typeof result.stdout !== 'string'
  ) {
    const detail =
      result.error?.message ?? `ps exited ${String(result.status)}`;
    throw new Error(`process-stat inventory failed: ${detail}`);
  }
  return parseProcessStatLines(result.stdout);
}

function defaultClassifyRemaining(pids, { runSync }) {
  return classifyProcessTreeProof(
    readProcessTreeStats(pids, { runSync }),
    pids,
  );
}

/**
 * Live PIDs that still belong to the smoke process group (or are direct
 * descendants of `rootPid`). Used to prove PTY/provider orphans are gone.
 *
 * Throws when the operating-system inventory cannot be read. An unreadable
 * process table is not equivalent to an empty process tree.
 *
 * @returns {number[]}
 */
export function listProcessTreePids(
  rootPid,
  {
    platform = process.platform,
    runSync = spawnSync,
  } = {},
) {
  if (!rootPid || rootPid <= 0 || platform === 'win32') return [];
  const result = runSync(
    'ps',
    ['-axo', 'pid=,ppid=,pgid=,stat='],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    },
  );
  if (
    result.error ||
    result.status !== 0 ||
    typeof result.stdout !== 'string'
  ) {
    const detail =
      result.error?.message ??
      `ps exited ${String(result.status)}`;
    throw new Error(`process-tree inventory failed: ${detail}`);
  }
  /** @type {Map<number, { ppid: number, pgid: number, zombie: boolean }>} */
  const rows = new Map();
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
    if (!match) continue;
    // A killed direct child remains as a Z zombie until this Node process can
    // service SIGCHLD. killProcessTree deliberately polls synchronously, so
    // counting that already-dead bookkeeping entry creates a deterministic
    // false leak that disappears as soon as the event loop resumes.
    rows.set(Number(match[1]), {
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      // Retain zombies as ancestry nodes so an unusual still-attached live
      // child cannot evade the walk; omit only the dead identity from proof.
      zombie: match[4].startsWith('Z'),
    });
  }
  if (!rows.has(rootPid)) {
    // Root already gone: still collect orphans that kept the same process group.
    const leftovers = [];
    for (const [pid, row] of rows) {
      if (row.pgid === rootPid && !row.zombie) leftovers.push(pid);
    }
    return leftovers.sort((a, b) => a - b);
  }
  const live = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, row] of rows) {
      if (live.has(pid)) continue;
      if (row.pgid === rootPid || live.has(row.ppid)) {
        live.add(pid);
        grew = true;
      }
    }
  }
  return [...live]
    .filter((pid) => !rows.get(pid)?.zombie)
    .sort((a, b) => a - b);
}

function sleepMs(ms, sleep = (n) => {
  // Synchronous sleep via Atomics so unit tests can inject a no-op.
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, Math.max(0, n));
}) {
  if (ms > 0) sleep(ms);
}

/**
 * Terminate the Electron process tree and prove helpers are gone.
 *
 * On POSIX the child is spawned detached (new process group). Escalate
 * SIGTERM → SIGKILL so real-mission can flush evidence on before-quit, then
 * re-scan `ps` until PTY/provider descendants exit (or timeout).
 * On Windows use taskkill /T.
 *
 * Pids in kernel E (exiting) or Z (zombie) are not working orphans: the
 * process-tree proof records them as `kernel-exiting: <pid>` and treats
 * them as terminated. Live S/R/T leftovers still fail the proof.
 *
 * @returns {{
 *   ok: boolean,
 *   remainingPids: number[],
 *   signalled: string[],
 *   warnings: string[],
 *   processTreeProof: {
 *     orphans: number[],
 *     kernelExiting: number[],
 *     elapsedMs: number,
 *   },
 *   inventoryError?: string,
 * }}
 */
export function killProcessTree(
  pid,
  {
    platform = process.platform,
    kill = process.kill.bind(process),
    runSync = spawnSync,
    listPids = listProcessTreePids,
    classifyRemaining = defaultClassifyRemaining,
    sleep = sleepMs,
    now = Date.now,
    termGraceMs = 1_500,
    killGraceMs = 1_500,
    pollMs = 100,
    proofTimeoutMs = PROCESS_TREE_PROOF_TIMEOUT_MS,
  } = {},
) {
  const startedAt = now();
  const elapsed = () => Math.max(0, now() - startedAt);
  const proofOf = (partition) => ({
    orphans: partition.orphans,
    kernelExiting: partition.kernelExiting,
    elapsedMs: elapsed(),
  });

  if (!pid || pid <= 0) {
    return {
      ok: true,
      remainingPids: [],
      signalled: [],
      warnings: [],
      processTreeProof: emptyProcessTreeProof(0),
    };
  }
  if (platform === 'win32') {
    runSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    return {
      ok: true,
      remainingPids: [],
      signalled: ['taskkill'],
      warnings: [],
      processTreeProof: emptyProcessTreeProof(elapsed()),
    };
  }

  /** @type {string[]} */
  const signalled = [];
  const succeeded = (partition) => ({
    ok: true,
    remainingPids: [],
    signalled,
    warnings: partition.warnings ?? [],
    processTreeProof: proofOf(partition),
  });
  const signalGroup = (signal) => {
    try {
      kill(-pid, signal);
      signalled.push(`group:${signal}`);
    } catch {
      try {
        kill(pid, signal);
        signalled.push(`pid:${signal}`);
      } catch {
        // Process already exited.
      }
    }
  };

  let inventoryError = null;
  const emptyPartition = () => ({
    orphans: [],
    kernelExiting: [],
    warnings: [],
  });
  const inspect = () => {
    let remaining;
    try {
      remaining = listPids(pid, { platform, runSync });
    } catch (error) {
      inventoryError =
        error instanceof Error ? error.message : String(error);
      return null;
    }
    if (remaining.length === 0) return emptyPartition();
    try {
      return classifyRemaining(remaining, { platform, runSync });
    } catch {
      // Unreadable STAT is not proof of exit — keep the pid as a live orphan.
      return {
        orphans: remaining,
        kernelExiting: [],
        warnings: [],
      };
    }
  };
  const waitUntilOrphansGone = (budgetMs) => {
    const proofDeadline = startedAt + proofTimeoutMs;
    const deadline = Math.min(now() + Math.max(0, budgetMs), proofDeadline);
    let snapshot = inspect();
    while (
      snapshot !== null &&
      snapshot.orphans.length > 0 &&
      now() < deadline
    ) {
      sleep(pollMs);
      snapshot = inspect();
    }
    return snapshot;
  };

  // Soft stop first: Electron before-quit + real-mission evidence flush.
  signalGroup('SIGTERM');
  let snapshot = waitUntilOrphansGone(termGraceMs);
  if (snapshot !== null && snapshot.orphans.length === 0 && !inventoryError) {
    return succeeded(snapshot);
  }

  // Hard stop process group + root, then re-check for live orphans only.
  signalGroup('SIGKILL');
  for (const orphan of snapshot?.orphans ?? []) {
    try {
      kill(orphan, 'SIGKILL');
      signalled.push(`orphan:${orphan}:SIGKILL`);
    } catch {
      // Already gone or not owned.
    }
  }
  const killBudget = Math.min(
    killGraceMs,
    Math.max(0, startedAt + proofTimeoutMs - now()),
  );
  snapshot = waitUntilOrphansGone(killBudget);
  if (snapshot !== null && snapshot.orphans.length === 0 && !inventoryError) {
    return succeeded(snapshot);
  }
  const failed = snapshot ?? {
    orphans: [pid],
    kernelExiting: [],
    warnings: [],
  };
  return {
    ok: false,
    remainingPids: failed.orphans,
    signalled,
    warnings: failed.warnings,
    processTreeProof: proofOf(failed),
    ...(inventoryError ? { inventoryError } : {}),
  };
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

// Only sessions created here may keep a profile across two test launches.
// A caller cannot redirect cleanup or the app's HOME to an operator profile.
const ownedSmokeSessions = new WeakSet();

export async function createPackagedSmokeSession() {
  const userData = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexus-packaged-smoke-'),
  ));
  try {
    await fs.mkdir(path.join(userData, 'home'), { mode: 0o700 });
    await fs.mkdir(path.join(userData, 'tmp'), { mode: 0o700 });
    const session = Object.freeze({ userData });
    ownedSmokeSessions.add(session);
    return session;
  } catch (error) {
    await fs.rm(userData, { recursive: true, force: true });
    throw error;
  }
}

async function assertOwnedSmokeSession(session) {
  if (!session || !ownedSmokeSessions.has(session)) {
    throw new Error('packaged smoke session must be created by this harness');
  }
  for (const directory of [session.userData, path.join(session.userData, 'home'), path.join(session.userData, 'tmp')]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory ||
        (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid())))) {
      throw new Error('packaged smoke session directory lost its private ownership');
    }
  }
}

export async function disposePackagedSmokeSession(session) {
  if (!session || !ownedSmokeSessions.has(session)) {
    throw new Error('cannot dispose an unowned packaged smoke session');
  }
  ownedSmokeSessions.delete(session);
  // fs.rm unlinks symlinks; it never follows a replaced profile into its target.
  // F-931: no Windows uma CLI instalada no host (AGY) ainda segura o próprio
  // SQLite no HOME isolado por instantes depois que o app sai (EBUSY).
  await fs.rm(session.userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

export async function runPackagedSmoke(
  targetPath,
  {
    platform = process.platform,
    arch = process.arch,
    timeoutMs = TIMEOUT_MS,
    gracefulCloseTimeoutMs = GRACEFUL_CLOSE_TIMEOUT_MS,
    spawnImpl = spawn,
    env = process.env,
    killTree = killProcessTree,
    listTreePids = listProcessTreePids,
    classifyRemaining = defaultClassifyRemaining,
    requireGracefulClose =
      platform === 'darwin' &&
      process.platform === 'darwin' &&
      spawnImpl === spawn,
    inspectMainBundle = inspectPackagedMainBundle,
    inspectLegalArtifacts = inspectPackagedLegalArtifacts,
    inspectWakeModel = inspectPackagedWakeModel,
    smokeSession = null,
    remoteDebugging = false,
    runtimeProbe = null,
    runtimeProbeTimeoutMs = 30_000,
    soakProbe = false,
    runtimeGatesProbe = false,
  } = {},
) {
  const privateSoak = soakProbe === true && env.NEXUS_SMOKE_SOAK === '1' && remoteDebugging === false;
  const privateRuntime = runtimeGatesProbe === true && env.NEXUS_SMOKE_RUNTIME_GATES === '1' && remoteDebugging === false && !soakProbe &&
    ['exercise', 'resume'].includes(env.NEXUS_SMOKE_RUNTIME_PHASE) && /^http:\/\/127\.0\.0\.1:\d+$/u.test(env.NEXUS_SMOKE_RUNTIME_GATEWAY ?? '') &&
    /^[a-f0-9-]{36}$/u.test(env.NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE ?? '');
  if (typeof remoteDebugging !== 'boolean' || typeof soakProbe !== 'boolean' || typeof runtimeGatesProbe !== 'boolean' || (soakProbe && !privateSoak) || (runtimeGatesProbe && !privateRuntime) ||
      (privateSoak && (typeof runtimeProbe !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 300_000 || timeoutMs > 480_000)) ||
      (privateRuntime && (typeof runtimeProbe !== 'function' || !smokeSession || !Number.isFinite(timeoutMs) || timeoutMs <= TIMEOUT_MS || timeoutMs > 600_000)) ||
      (runtimeProbe !== null && typeof runtimeProbe !== 'function') ||
      !Number.isFinite(runtimeProbeTimeoutMs) || runtimeProbeTimeoutMs <= 0 || runtimeProbeTimeoutMs > (privateRuntime ? 590_000 : privateSoak ? 450_000 : TIMEOUT_MS)) {
    throw new Error('invalid packaged smoke runtime probe options');
  }
  const target = resolvePackagedTarget(targetPath, { platform, arch });
  await fs.access(
    target.binary,
    platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK,
  );
  await assertNativeArtifactsPresent(target.unpackedRoot, { platform, arch });
  inspectMainBundle(target.resourcesDir);
  inspectLegalArtifacts(target.resourcesDir, { platform, arch });
  await inspectWakeModel(target.resourcesDir);
  if (platform === 'win32') {
    assertPackagedWindowsRuntimeIcon(target.resourcesDir);
  }

  const ownsSession = smokeSession === null;
  const session = smokeSession ?? await createPackagedSmokeSession();
  let userData;
  const probeController = new AbortController();
  let probeTimeout;
  let runtimeProofTask = null;

  let output = '';
  let runtimeExecuted = false;
  let shutdownMode = null;
  /** @type {{
   *   ok: boolean,
   *   remainingPids: number[],
   *   signalled: string[],
   *   inventoryError?: string,
   * } | null} */
  let treeProof = null;

  try {
    await assertOwnedSmokeSession(session);
    userData = session.userData;
    if (remoteDebugging) {
      // Chromium leaves this endpoint file in a reused profile. Never let the
      // second launch connect to the previous process's debugging endpoint.
      try {
        await fs.unlink(path.join(userData, 'DevToolsActivePort'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const code = await new Promise((resolve, reject) => {
      const child = spawnImpl(
        target.binary,
        [...packagedSmokeArgs(userData, platform), ...(remoteDebugging
          ? ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']
          : [])],
        packagedSmokeSpawnOptions(userData, env, platform),
      );
      if (runtimeProbe) {
        runtimeProofTask = new Promise(resolveProbe => {
          let completed = false;
          const finishProbe = outcome => {
            if (completed) return;
            completed = true;
            clearTimeout(probeTimeout);
            resolveProbe(outcome);
          };
          probeTimeout = setTimeout(() => {
            probeController.abort();
            finishProbe({ error: new Error('packaged smoke runtime probe timed out') });
          }, runtimeProbeTimeoutMs);
          Promise.resolve().then(() => runtimeProbe(child, { userData, signal: probeController.signal }))
            .then(value => finishProbe({ value }), error => finishProbe({ error }));
        });
      }
      runtimeExecuted = true;
      let settled = false;
      let readySeen = false;
      let shutdownProofSeen = false;
      let expectedExitSeen = false;
      let naturalCloseSeen = false;
      let naturalExitCode = null;
      let naturalSignalCode = null;
      let timeout;
      let gracefulCloseTimeout;
      let naturalTreePoll;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(gracefulCloseTimeout);
        clearTimeout(naturalTreePoll);
        fn(value);
      };
      const reapTree = () => {
        shutdownMode = 'external-reap';
        treeProof = killTree(child.pid, { platform }) ?? {
          ok: true,
          remainingPids: [],
          signalled: [],
          warnings: [],
          processTreeProof: emptyProcessTreeProof(0),
        };
        if (!treeProof.processTreeProof) {
          treeProof = {
            ...treeProof,
            warnings: treeProof.warnings ?? [],
            processTreeProof: {
              orphans: treeProof.remainingPids ?? [],
              kernelExiting: [],
              elapsedMs: 0,
            },
          };
        }
        for (const warning of treeProof.warnings ?? []) {
          process.stderr.write(`[smoke] ${warning}\n`);
        }
        if (!treeProof.ok) {
          const proof = treeProof.processTreeProof;
          process.stderr.write(
            `[smoke] process-tree proof failed after kill: ` +
              `orphans=${(proof?.orphans ?? treeProof.remainingPids).join(',')}` +
              ` kernel-exiting=${(proof?.kernelExiting ?? []).join(',') || 'none'}` +
              ` elapsedMs=${proof?.elapsedMs ?? 'unknown'}` +
              (treeProof.inventoryError
                ? ` inventory=${treeProof.inventoryError}`
                : '') +
              `\n`,
          );
        }
        return treeProof;
      };
      const rejectOrphanedTree = () => {
        const proof = treeProof?.processTreeProof;
        finish(
          reject,
          new Error(
            `packaged smoke left orphan processes after termination: ` +
              (proof?.orphans ?? treeProof.remainingPids).join(',') +
              (proof
                ? ` (kernel-exiting: ${proof.kernelExiting.join(',') || 'none'}, elapsedMs=${proof.elapsedMs})`
                : ''),
          ),
        );
      };
      const finishNaturalClose = (partition = {
        kernelExiting: [],
        warnings: [],
      }) => {
        shutdownMode = 'graceful';
        treeProof = {
          ok: true,
          remainingPids: [],
          signalled: [],
          warnings: partition.warnings ?? [],
          processTreeProof: {
            orphans: [],
            kernelExiting: partition.kernelExiting ?? [],
            elapsedMs: 0,
          },
        };
        for (const warning of treeProof.warnings) {
          process.stderr.write(`[smoke] ${warning}\n`);
        }
        if (naturalExitCode !== 0 || naturalSignalCode) {
          finish(
            reject,
            new Error(
              `packaged smoke did not prove a successful natural close after ` +
                `functional-ready (exit=${String(naturalExitCode)}, ` +
                `signal=${naturalSignalCode ?? 'none'}, mode=${shutdownMode})`,
            ),
          );
          return;
        }
        if (requireGracefulClose && !shutdownProofSeen) {
          finish(
            reject,
            new Error(
              `packaged smoke exited without its main-owned shutdown-complete proof`,
            ),
          );
          return;
        }
        finish(resolve, 0);
      };
      const proveNaturalTreeExit = ({ scheduleRetry = true } = {}) => {
        let remainingPids;
        try {
          remainingPids = listTreePids(child.pid, { platform });
        } catch (error) {
          const inventoryError =
            error instanceof Error ? error.message : String(error);
          reapTree();
          finish(
            reject,
            new Error(
              `packaged smoke could not prove natural process-tree exit: ` +
                inventoryError,
            ),
          );
          return false;
        }
        if (remainingPids.length === 0) {
          finishNaturalClose();
          return true;
        }
        let partition;
        try {
          partition = classifyRemaining(remainingPids, { platform });
        } catch {
          partition = {
            orphans: remainingPids,
            kernelExiting: [],
            warnings: [],
          };
        }
        if (partition.orphans.length === 0) {
          finishNaturalClose(partition);
          return true;
        }
        if (scheduleRetry && !settled) {
          naturalTreePoll = setTimeout(
            () => proveNaturalTreeExit(),
            Math.min(PROCESS_TREE_POLL_MS, gracefulCloseTimeoutMs),
          );
          naturalTreePoll.unref?.();
        }
        return false;
      };
      const onGracefulCloseTimeout = () => {
        if (settled) return;
        // The root may have closed just before the deadline while one helper
        // was still draining. Take one final read-only inventory before using
        // any signal.
        if (
          naturalCloseSeen &&
          proveNaturalTreeExit({ scheduleRetry: false })
        ) {
          return;
        }
        reapTree();
        if (!treeProof.ok) {
          rejectOrphanedTree();
          return;
        }
        if (requireGracefulClose) {
          const captured = output.trim();
          // BridgeSpace pattern: intentional expected-exit after physical proof.
          // The app may still need a harness reap for residual Electron helpers;
          // that is success when shutdown-complete + expected-exit were proven.
          if (shutdownProofSeen && expectedExitSeen && treeProof?.ok) {
            finish(resolve, 0);
            return;
          }
          finish(
            reject,
            new Error(
              `packaged smoke reached functional-ready but did not close ` +
                `gracefully within ${gracefulCloseTimeoutMs}ms; its process ` +
                `tree required external reaping` +
                (captured ? `\n${captured}` : ''),
            ),
          );
          return;
        }
        // Linux/Windows CI historically tolerates a browser helper that keeps
        // Electron alive after the functional contract has passed. Preserve
        // that contract, but only after a bounded graceful-close opportunity
        // and a successful whole-tree reap.
        finish(resolve, 0);
      };
      const append = (chunk) => {
        output = (output + chunk.toString()).slice(-MAX_LOG_CHARS);
        if (output.includes('[smoke] shutdown-complete')) {
          shutdownProofSeen = true;
        }
        if (output.includes('[smoke] expected-exit')) {
          expectedExitSeen = true;
        }
        // functional-ready starts app.quit(), whose fail-closed shutdown must
        // finish its own PTY proof. Killing here races that proof and can
        // manufacture PhysicalPtyShutdownError. Give the app one short,
        // bounded window to close itself before the cross-platform reaper is
        // allowed to intervene.
        if (!settled && !readySeen && output.includes('[smoke] functional-ready')) {
          readySeen = true;
          gracefulCloseTimeout = setTimeout(
            onGracefulCloseTimeout,
            gracefulCloseTimeoutMs,
          );
          gracefulCloseTimeout.unref?.();
        }
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.once('error', (error) => {
        reapTree();
        finish(reject, error);
      });

      timeout = setTimeout(() => {
        reapTree();
        const captured = output.trim();
        finish(
          reject,
          new Error(
            `packaged smoke timed out after ${timeoutMs}ms` +
              (captured ? `\n${captured}` : '\n<no packaged app output captured>'),
          ),
        );
      }, timeoutMs);
      // This deadline owns the harness liveness. The packaged app is launched
      // as a detached process group, so unref'ing every timer can let Node exit
      // cleanly before a slow first launch (Gatekeeper/notarization) emits
      // either `close` or renderer proof. `finish()` always clears the timer.

      child.once('close', (exitCode, signalCode) => {
        if (settled) return;
        if (!readySeen) {
          // Startup/functional failure is not permission to leave detached
          // Electron helpers behind.
          reapTree();
          if (!treeProof.ok) {
            rejectOrphanedTree();
            return;
          }
          finish(resolve, exitCode);
          return;
        }

        naturalCloseSeen = true;
        naturalExitCode = exitCode;
        naturalSignalCode = signalCode;
        // `close` proves the root and its inherited stdio closed, but a helper
        // with independent stdio can still be finishing. Poll read-only until
        // the same bounded deadline instead of racing that last graceful exit.
        proveNaturalTreeExit();
      });
    });

    assertPackagedSmokeProof(code, output);
    await assertFunctionalMarker(userData);
    const runtimeOutcome = runtimeProofTask ? await runtimeProofTask : null;
    process.stdout.write(output);
    const processTreeProof =
      treeProof?.processTreeProof ?? emptyProcessTreeProof(0);
    if (treeProof) {
      process.stdout.write(
        `\n[smoke] process-tree ok=${treeProof.ok} ` +
          `remaining=${treeProof.remainingPids.length} ` +
          `signalled=${treeProof.signalled.join(',') || 'none'} ` +
          `shutdown=${shutdownMode ?? 'unknown'}\n`,
      );
      process.stdout.write(
        `[smoke] processTreeProof ${JSON.stringify(processTreeProof)}\n`,
      );
    }
    if (runtimeOutcome && 'error' in runtimeOutcome) throw runtimeOutcome.error;

    const matrix = packagedSmokeValidationMatrix({
      hostPlatform: process.platform,
      runtimeExecuted: runtimeExecuted && spawnImpl === spawn,
      runtimePlatform: platform,
    });
    process.stdout.write(
      `\n[smoke] validation-matrix\n${formatValidationMatrix(matrix)}\n`,
    );
    return {
      code,
      output,
      matrix,
      target,
      treeProof,
      shutdownMode,
      processTreeProof,
      runtimeProof: runtimeOutcome?.value ?? null,
    };
  } finally {
    clearTimeout(probeTimeout);
    probeController.abort();
    if (ownsSession) await disposePackagedSmokeSession(session);
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

  const args = process.argv.slice(2);
  if (args.includes('--verify-busy-banner-probe')) {
    const { parseBusyBannerArguments, runPackagedBusyBannerProbe } = await import('./smoke-packaged-busy-banner.mjs');
    const options = parseBusyBannerArguments(args);
    const target = options.app ?? defaultPackagedTargetPath({ platform, arch });
    const probe = resolvePackagedTarget(target, { platform, arch });
    const targetArch = detectPackagedTargetArch(probe.binary, { platform, fallbackArch: arch });
    await runPackagedBusyBannerProbe(target, { expectedVersion: options.expectedVersion, evidenceDir: options.evidenceDir, platform, arch: targetArch });
    return;
  }
  if (args.includes('--verify-hang-probe')) {
    // F-764 A.1: o watchdog perfila a main presa DENTRO do binário de release.
    const { parseHangProbeArguments, runPackagedHangProbe } = await import('./smoke-packaged-hang-probe.mjs');
    const options = parseHangProbeArguments(args);
    const target = options.app ?? defaultPackagedTargetPath({ platform, arch });
    const probe = resolvePackagedTarget(target, { platform, arch });
    const targetArch = detectPackagedTargetArch(probe.binary, { platform, fallbackArch: arch });
    await runPackagedHangProbe(target, { platform, arch: targetArch });
    return;
  }
  if (args.includes('--verify-restart')) {
    const { parseRestartSmokeArguments, runPackagedRestartSmoke } = await import('./smoke-packaged-restart.mjs');
    const options = parseRestartSmokeArguments(args);
    const target = options.app ?? defaultPackagedTargetPath({ platform, arch });
    const probe = resolvePackagedTarget(target, { platform, arch });
    const targetArch = detectPackagedTargetArch(probe.binary, { platform, fallbackArch: arch });
    await runPackagedRestartSmoke(target, { expectedVersion: options.expectedVersion, platform, arch: targetArch });
    return;
  }
  const explicit = resolveAppArgument(args);
  if (explicit) {
    const probe = resolvePackagedTarget(explicit, { platform, arch });
    const targetArch = detectPackagedTargetArch(probe.binary, {
      platform,
      fallbackArch: arch,
    });
    await runPackagedSmoke(explicit, { platform, arch: targetArch });
    return;
  }
  await runPackagedSmoke(defaultPackagedTargetPath({ platform, arch }), {
    platform,
    arch,
  });
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
