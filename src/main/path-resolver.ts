import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { isCurrentProcessSmokeTest } from './smoke-core';
import { BUILTIN_ADAPTERS } from '../adapters/builtin';
import { windowsNpmShimSpawn, windowsNpmShimTarget } from './adapters/windows-npm-shim';
import { compareAppVersions, isValidAppVersion } from '../shared/app-version';
import { writeFileAtomicAsync } from './util/atomic-write';

/**
 * Single source of truth for CLI PATH + binary resolution.
 *
 * macOS (and Linux) GUI apps launched from Finder/the dock inherit a MINIMAL
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — NOT the user's login-shell PATH where
 * `claude`, `codex`, `kimi`, `grok`, homebrew, npm-global and ~/.local/bin live.
 *
 * Doctrine:
 *  1. Fold login-shell PATH + curated install dirs into process.env.PATH once
 *     at bootstrap (and again on explicit rescan).
 *  2. Resolve CLI binaries to **absolute paths** during discovery.
 *  3. Spawn with that absolute path (`PtySpawnSpec.file`), never a bare name
 *     that re-searches a different environment in the PTY host.
 */

const START = '__NEXUS_PATH_START__';
const END = '__NEXUS_PATH_END__';
const RESOLVE_TIMEOUT_MS = 4000;
const WINDOWS_PTY_EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.com',
  '.cmd',
  '.bat',
]);

interface LoginShellExecOptions {
  readonly encoding: 'utf8';
  readonly timeout: number;
  readonly env: NodeJS.ProcessEnv;
}

export type LoginShellPathExecutor = (
  file: string,
  args: readonly string[],
  options: LoginShellExecOptions,
) => Promise<string>;

export interface CliBinaryResolution {
  /** Absolute path to an executable file. */
  readonly binPath: string;
  /** Version-only diagnostic; never includes executable paths. */
  readonly installationWarning?: string;
  /** PATH string that located the binary (process.env or login+fallbacks). */
  readonly effectivePath: string;
  /** How the binary was found. */
  readonly source: 'absolute' | 'process-path' | 'login-path' | 'fallback-dir';
}

/**
 * Real OS account home — NOT process.env.HOME.
 *
 * Disposable runs (real-mission E2E, some smoke harnesses) rewrite HOME to a
 * private temp dir so the child cannot touch the operator profile. `os.homedir()`
 * follows $HOME and would then look for CLIs under /tmp/.../home/.local/bin
 * (empty), reporting only Homebrew tools as installed. `userInfo().homedir`
 * comes from the passwd database and still points at the real user home where
 * claude/kimi/grok/agy actually live.
 */
export function realUserHome(): string {
  try {
    const info = os.userInfo();
    if (info?.homedir && path.isAbsolute(info.homedir)) return info.homedir;
  } catch {
    // getpwuid can fail in some sandboxes — fall through.
  }
  return os.homedir();
}

/**
 * Curated install dirs unioned when shell resolution misses them.
 * Order matters when the login shell probe fails: vendor CLI installers
 * (Kimi Code, Grok, etc.) come before generic ~/.local/bin, which may hold a
 * different package with the same bare name (e.g. legacy kimi-cli via uv).
 */
/**
 * Node version managers keep one bin dir per installed version; a CLI
 * installed with `npm i -g` lives only in the version that was active. Newest
 * first so the version the operator most likely uses wins a name clash.
 */
function nvmVersionBinDirs(home: string): string[] {
  const root = path.join(home, '.nvm', 'versions', 'node');
  let versions: string[];
  try {
    versions = fs.readdirSync(root);
  } catch {
    return [];
  }
  const numeric = (version: string) =>
    version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  return versions
    .filter((version) => /^v?\d+\.\d+\.\d+/.test(version))
    .sort((a, b) => {
      const [x, y] = [numeric(a), numeric(b)];
      for (let i = 0; i < 3; i += 1) {
        if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0);
      }
      return 0;
    })
    .map((version) => path.join(root, version, 'bin'));
}

/** Windows per-user install roots (npm/pnpm globals, native CLI installers). */
function windowsUserBinDirs(home: string): string[] {
  if (process.platform !== 'win32') return [];
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  return [
    path.join(appData, 'npm'),
    path.join(localAppData, 'pnpm'),
    path.join(localAppData, 'Volta', 'bin'),
    path.join(home, 'scoop', 'shims'),
    // F-1508: instalador do agy, atalhos do winget e o Node do instalador MSI.
    path.join(localAppData, 'agy', 'bin'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    path.join(programFiles, 'nodejs'),
  ];
}

export function commonCliBinDirs(home = realUserHome()): string[] {
  return [
    // Vendor-specific official installers first.
    path.join(home, '.kimi-code', 'bin'),
    path.join(home, '.grok', 'bin'),
    path.join(home, '.claude', 'bin'),
    // Instalador local antigo do Claude Code (`claude migrate-installer`).
    path.join(home, '.claude', 'local'),
    path.join(home, '.codex', 'bin'),
    path.join(home, '.hermes', 'node', 'bin'),
    path.join(home, '.local', 'share', 'claude', 'versions'),
    // Package managers / version managers.
    // Nexus releases are built and validated on Node 22. Homebrew keeps
    // versioned formulae keg-only, so Finder-launched apps do not see this
    // directory through /opt/homebrew/bin.
    '/opt/homebrew/opt/node@22/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/opt/node@22/bin',
    '/usr/local/bin',
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.nvm', 'current', 'bin'),
    ...nvmVersionBinDirs(home),
    path.join(home, '.fnm', 'current', 'bin'),
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.proto', 'shims'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm'),
    ...windowsUserBinDirs(home),
    '/snap/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.yarn', 'bin'),
    path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'),
    '/usr/local/go/bin',
    // Generic user bins last (may shadow vendor tools with same name).
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
  ];
}

function existingDirs(dirs: readonly string[]): string[] {
  return dirs.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function executeLoginShellForOutput(
  file: string,
  args: readonly string[],
  options: LoginShellExecOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // windowsHide: o PowerShell da sonda do Windows (F-1508) não pisca console.
    execFile(file, [...args], { ...options, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * F-1508: o PATH que um processo NOVO receberia no Windows — o de máquina e o
 * do usuário, do registro, já expandidos —, lido pelo PowerShell do System32
 * com saída UTF-8 (o reg.exe sai na página OEM e estragaria `C:\Users\João`).
 * O processo do app herda o PATH do momento em que abriu (o reinício do
 * auto-update herda o da versão anterior): sem esta leitura, uma CLI
 * instalada com o app aberto nunca aparecia. `''` em qualquer falha; entrada
 * com `%VAR%` sem valor não vira pasta.
 */
const WINDOWS_PATH_QUERY =
  "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
  "$p=@('Machine','User' | ForEach-Object { [Environment]::GetEnvironmentVariable('Path', $_) } | Where-Object { $_ }) -join ';'; " +
  `[Console]::Out.Write('${START}' + $p + '${END}')`;

async function probeWindowsEnvironmentPath(
  exec: LoginShellPathExecutor,
  timeoutMs: number,
): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const out = await exec(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PATH_QUERY],
      { encoding: 'utf8', timeout: timeoutMs, env: process.env },
    );
    if (!out.includes(START) || !out.includes(END)) return '';
    return out
      .slice(out.indexOf(START) + START.length, out.indexOf(END))
      .split(';')
      .map((dir) => dir.trim().replace(/^"(.*)"$/u, '$1'))
      .filter((dir) => dir.length > 0 && !dir.includes('%'))
      .join(path.delimiter);
  } catch {
    return '';
  }
}

/**
 * Ask the user's login+interactive shell for its PATH.
 *
 * The shell is deliberately asynchronous: login profiles can invoke package
 * managers or network-backed helpers and must never freeze Electron's main
 * event loop for the full probe timeout.
 */
export async function probeLoginShellPath(
  exec: LoginShellPathExecutor = executeLoginShellForOutput,
  home = realUserHome(),
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<string> {
  if (process.platform === 'win32') return probeWindowsEnvironmentPath(exec, timeoutMs);
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    // Force the real account home so isolated $HOME (E2E/smoke) still sources
    // the operator's .zprofile/.zshrc where nvm/homebrew PATH exports live.
    // -l login, -i interactive. Sentinel-wrapped against banner/prompt noise.
    const out = await exec(
      shell,
      ['-lic', `printf '%s%s%s' '${START}' "$PATH" '${END}'`],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        env: {
          ...process.env,
          HOME: home,
          USER: process.env.USER ?? path.basename(home),
          LOGNAME: process.env.LOGNAME ?? path.basename(home),
        },
      },
    );
    if (!out.includes(START) || !out.includes(END)) return '';
    return out.slice(out.indexOf(START) + START.length, out.indexOf(END));
  } catch {
    return '';
  }
}

/**
 * Build the effective PATH used for discovery and spawn.
 * Order: current process PATH → login shell → curated fallbacks.
 *
 * This function is intentionally pure and synchronous. The asynchronous login
 * shell probe belongs in `resolveEffectivePath`; callers that do not await it
 * still receive the current process PATH plus safe local fallbacks.
 */
export function buildEffectivePath(options: {
  processPath?: string;
  loginPath?: string;
  home?: string;
} = {}): string {
  const home = options.home ?? realUserHome();
  const processPath = options.processPath ?? process.env.PATH ?? '';
  const loginPath = options.loginPath ?? '';
  const parts = new Set<string>();
  for (const dir of processPath.split(path.delimiter)) {
    if (dir) parts.add(dir);
  }
  for (const dir of loginPath.split(path.delimiter)) {
    if (dir) parts.add(dir);
  }
  for (const dir of existingDirs(commonCliBinDirs(home))) {
    parts.add(dir);
  }
  return [...parts].join(path.delimiter);
}

export async function resolveEffectivePath(options: {
  processPath?: string;
  loginPath?: string;
  home?: string;
} = {}): Promise<string> {
  const home = options.home ?? realUserHome();
  const loginPath =
    options.loginPath ?? (await probeLoginShellPath(undefined, home));
  return buildEffectivePath({
    ...options,
    home,
    loginPath,
  });
}

let folded = false;
let memoizedEffectivePath: string | null = null;
let bootPathRevalidation: Promise<string> | undefined;
let bootPathCache: { file: string; home: string } | undefined;
let bootPathInheritedPath: string | undefined;

function validLoginPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 65_536 &&
    !/[\x00\r\n]/u.test(value) && value.split(path.delimiter).every((dir) => !dir || path.isAbsolute(dir));
}

async function readBootPathCache(file: string, home: string): Promise<string> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > 70_000) return '';
    const cached = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return cached?.platform === process.platform && cached.home === home && validLoginPath(cached.loginPath)
      ? cached.loginPath : '';
  } catch { return ''; }
}

/** Best-effort cache only; durable writes run after bootstrap, off the Main thread. */
async function saveBootPathCache(loginPath: string): Promise<void> {
  if (!bootPathCache || !validLoginPath(loginPath)) return;
  await writeFileAtomicAsync(bootPathCache.file, JSON.stringify({
    platform: process.platform, home: bootPathCache.home, loginPath,
  })).catch(() => undefined);
}

/**
 * Fold the login-shell PATH + common install dirs into process.env.PATH.
 * Idempotent; safe to call once during bootstrap BEFORE the adapter registry
 * probes for installed CLIs.
 */
export async function resolveUserPath(options: {
  cachePath?: string;
  home?: string;
  exec?: LoginShellPathExecutor;
} = {}): Promise<void> {
  if (folded) return;
  const home = options.home ?? realUserHome();
  const processPath = process.env.PATH ?? '';
  // F-1508: no Windows o boot não espera o PowerShell; o PATH do registro
  // entra pela releitura em segundo plano (`retryLoginShellPathIfMissed`).
  const probe = process.platform === 'win32'
    ? Promise.resolve('')
    : probeLoginShellPath(options.exec, home);
  bootPathCache = options.cachePath ? { file: options.cachePath, home } : undefined;
  const cached = options.cachePath ? await readBootPathCache(options.cachePath, home) : '';
  // A cache hit releases discovery immediately. The already-running shell is
  // consumed by the existing background retry/rescan after bootstrap.
  bootPathRevalidation = cached ? probe : undefined;
  bootPathInheritedPath = cached ? processPath : undefined;
  bootLoginProbe = cached ? '' : await probe;
  const effective = buildEffectivePath({ home, processPath, loginPath: cached || bootLoginProbe });
  process.env.PATH = effective;
  memoizedEffectivePath = effective;
  folded = true;
}

/** Login-shell PATH seen at boot; '' = missed or cache awaiting revalidation. */
let bootLoginProbe: string | null = null;
/** A slow profile (oh-my-zsh + nvm on a cold login) gets this much time. */
const LATE_RESOLVE_TIMEOUT_MS = 20_000;

/**
 * The boot probe has a short deadline so a slow shell never delays the first
 * window. When it missed, CLIs installed through nvm/fnm/custom PATH exports
 * looked "not installed" for the whole session. Retry once in the background
 * with a long deadline and fold the result; returns true when PATH changed so
 * the caller rescans adapters.
 */
export async function retryLoginShellPathIfMissed(
  exec: LoginShellPathExecutor = executeLoginShellForOutput,
  options: { home?: string; bootProbe?: string | null } = {},
): Promise<boolean> {
  const bootProbe = options.bootProbe !== undefined ? options.bootProbe : bootLoginProbe;
  if (bootProbe === null) return false;
  if (bootProbe !== '') {
    await saveBootPathCache(bootProbe);
    return false;
  }
  const home = options.home ?? realUserHome();
  const flight = options.bootProbe === undefined ? bootPathRevalidation : undefined;
  bootPathRevalidation = undefined;
  const loginPath = (await flight) || await probeLoginShellPath(exec, home, LATE_RESOLVE_TIMEOUT_MS);
  if (!loginPath) return false;
  // Drop the cached login dirs before rescan; otherwise a stale executable
  // can keep shadowing the freshly discovered login-shell installation.
  const processPath = options.bootProbe === undefined ? bootPathInheritedPath : undefined;
  const effective = buildEffectivePath({ home, processPath, loginPath });
  bootPathInheritedPath = undefined;
  // No Windows o PATH do registro costuma ser o mesmo herdado: sem mudança,
  // sem reexame de CLIs.
  const changed = effective !== process.env.PATH;
  process.env.PATH = effective;
  memoizedEffectivePath = effective;
  bootLoginProbe = loginPath;
  folded = true;
  await saveBootPathCache(loginPath);
  return changed;
}

/**
 * Re-fold PATH live (post `brew install`, external CLI installer, etc.).
 * Called by "Reexaminar CLIs" so discovery and spawn see newly installed tools.
 */
export async function refreshUserPath(): Promise<string> {
  // Clear memo so buildEffectivePath re-probes the login shell.
  memoizedEffectivePath = null;
  const effective = await resolveEffectivePath();
  process.env.PATH = effective;
  memoizedEffectivePath = effective;
  folded = true;
  return effective;
}

/**
 * Current effective PATH. Memoises the first build so repeated discovery
 * walks do not re-spawn the login shell for every adapter.
 */
export function getEffectivePath(): string {
  if (memoizedEffectivePath !== null) return memoizedEffectivePath;
  // Bootstrap awaits the login-shell probe before adapter discovery. This
  // fallback is process-only by design so an early caller can never reintroduce
  // a blocking subprocess on the Electron main thread.
  const effective = buildEffectivePath({ loginPath: '' });
  memoizedEffectivePath = effective;
  return effective;
}

/**
 * True when `candidate` is a regular file (or symlink resolving to one) with
 * an execute bit on POSIX. `statSync` follows symlinks; broken links throw.
 */
function isExecutableFile(candidate: string): boolean {
  try {
    const st = fs.statSync(candidate);
    if (!st.isFile()) return false;
    // node-pty sends the absolute file directly to ConPTY. A regular
    // extensionless file is not necessarily executable on Windows: npm puts a
    // POSIX `#!/bin/sh` shim next to its valid `.cmd` launcher. Selecting the
    // shim crashes the PTY utility process instead of reporting a spawn error.
    if (process.platform === 'win32') {
      return WINDOWS_PTY_EXECUTABLE_EXTENSIONS.has(
        path.extname(candidate).toLowerCase(),
      );
    }
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Memo of the running discovery pass; null = every lookup walks the PATH live. */
let lookupInPathPass: Map<string, string | null> | null = null;

/**
 * Runs one synchronous discovery pass with `lookupInPath` memoized: every
 * adapter sees one PATH snapshot and each (command, dir) pair is stat'ed once.
 * Outside a pass lookups stay live, so the pre-spawn resolve sees an install
 * or a removal immediately (`resolveAdapterBinary` contract).
 */
export function withLookupInPathPass<T>(run: () => T): T {
  if (lookupInPathPass) return run();
  lookupInPathPass = new Map();
  try {
    return run();
  } finally {
    lookupInPathPass = null;
  }
}

function lookupInSingleDir(
  command: string,
  dir: string,
  pathext: string,
): string | null {
  const candidate = path.join(dir, command);
  if (process.platform === 'win32') {
    // A caller may already name a native launcher (for example `npm.cmd` or
    // an explicitly configured `codex.cmd`). Keep that exact candidate, but
    // never treat an extensionless POSIX npm shim as executable through
    // ConPTY.
    if (
      WINDOWS_PTY_EXECUTABLE_EXTENSIONS.has(
        path.extname(command).toLowerCase(),
      ) &&
      isExecutableFile(candidate)
    ) {
      return candidate;
    }
    for (const ext of pathext.split(';')) {
      if (!ext) continue;
      const normalizedExt = ext.toLowerCase();
      if (!WINDOWS_PTY_EXECUTABLE_EXTENSIONS.has(normalizedExt)) continue;
      // Use the normalized spelling. NTFS lookup remains case-insensitive,
      // while callers get a stable path for persistence and tests.
      const withExt = candidate + normalizedExt;
      if (isExecutableFile(withExt)) return withExt;
    }
    return null;
  }
  return isExecutableFile(candidate) ? candidate : null;
}

/**
 * Walk a PATH string for `command`. Returns absolute path or null.
 * Pure enough for unit tests (injectable via path string).
 */
export function lookupInPath(
  command: string,
  pathString: string,
  pathSep = path.delimiter,
): string | null {
  if (!command || command.includes('/') || command.includes('\\')) {
    return null;
  }
  const pathext = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    : '';
  const memo = lookupInPathPass;
  const cacheKey = `${command}\0${pathSep}\0${pathext}\0${pathString}`;
  const memoized = memo?.get(cacheKey);
  if (memoized !== undefined) return memoized;
  for (const dir of pathString.split(pathSep)) {
    if (!dir) continue;
    const dirKey = `${command}\0${pathSep}\0${pathext}\0${dir}`;
    let hit = memo?.get(dirKey);
    if (hit === undefined) {
      hit = lookupInSingleDir(command, dir, pathext);
      memo?.set(dirKey, hit);
    }
    if (hit !== null) {
      memo?.set(cacheKey, hit);
      return hit;
    }
  }
  memo?.set(cacheKey, null);
  return null;
}

function classifySource(
  binPath: string,
  processPath: string,
  home: string,
): CliBinaryResolution['source'] {
  const parent = path.dirname(binPath);
  // Hit only exists under a curated fallback dir that process PATH did not have.
  const fallbackDirs = commonCliBinDirs(home);
  const inCurated = fallbackDirs.some(
    (dir) => parent === dir || binPath.startsWith(dir + path.sep),
  );
  if (inCurated) {
    const processParts = new Set(
      processPath.split(path.delimiter).filter(Boolean),
    );
    if (!processParts.has(parent)) return 'fallback-dir';
  }
  return 'login-path';
}

/** Native Claude keeps version-named executables, not a file named `claude`. */
function nativeClaudeVersionBinary(home: string): string | null {
  if (process.platform === 'win32') return null;
  const versions = path.join(home, '.local', 'share', 'claude', 'versions');
  try {
    const candidates = fs.readdirSync(versions, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isValidAppVersion(entry.name))
      .sort((a, b) => compareAppVersions(b.name, a.name));
    for (const entry of candidates) {
      const candidate = path.join(versions, entry.name);
      if (isExecutableFile(candidate)) return candidate;
    }
  } catch { /* Missing or unreadable native installation: remain unavailable. */ }
  return null;
}

// Only AI adapter commands compete by version; node/git/install runners keep PATH order.
const aiCliCommands = new Map<string, string>([
  ...BUILTIN_ADAPTERS.flatMap((raw) => {
    const adapter = raw as { kind?: string; bin?: string; id: string };
    return adapter.kind === 'cli-pty' && adapter.bin
      ? [[adapter.bin, adapter.bin === 'claude' ? 'claude' : adapter.id] as [string, string]] : [];
  }),
  ['cursor-agent', 'cursor-agent'], ['qodercli', 'qoder'],
  ['prime-agent', 'prime-agent'], ['omp', 'omp'], ['codex-fugu', 'sakana'],
]);
/** Versão por arquivo real + mtime; falhas transitórias expiram para nova sonda. */
const cliVersionCache = new Map<string, { mtimeMs: number; version: string | null; probedAt: number }>();
/** Sondas em voo, uma por arquivo real + mtime. */
const cliVersionProbes = new Map<string, Promise<string | null>>();
const cliVersionListeners = new Set<() => void>();
/** Sobe a cada reset de teste: sonda de geração antiga não grava no cache. */
let cliVersionGeneration = 0;
const CLI_VERSION_PROBE_TIMEOUT_MS = 1_500;
const CLI_VERSION_FAILURE_RETRY_MS = 60_000;

function aiAdapterIdFor(binPath: string): string | undefined {
  return aiCliCommands.get(path.basename(binPath).replace(/\.(?:exe|com|cmd|bat)$/iu, ''));
}

/** Arquivo real + mtime que identificam a instalação; null se ela sumiu. */
function cliVersionKey(
  binPath: string,
  adapterId: string,
): { realPath: string; mtimeMs: number } | null {
  try {
    const target = process.platform === 'win32'
      ? windowsNpmShimTarget(adapterId, binPath) ?? binPath : binPath;
    const realPath = fs.realpathSync(target);
    return { realPath, mtimeMs: fs.statSync(realPath).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Versão já sondada desta instalação (cache por caminho real + mtime,
 * inclusive falhas por um minuto). `undefined` = ainda não sondada: quem resolve mantém a
 * ordem do PATH e agenda a sonda assíncrona. Nunca executa a CLI.
 */
export function cachedCliBinaryVersion(
  binPath: string,
  adapterId = aiAdapterIdFor(binPath),
): string | null | undefined {
  if (!adapterId) return null;
  const key = cliVersionKey(binPath, adapterId);
  if (!key) return null;
  const cached = cliVersionCache.get(key.realPath);
  return cached?.mtimeMs === key.mtimeMs &&
    (cached.version !== null || Date.now() - cached.probedAt < CLI_VERSION_FAILURE_RETRY_MS)
    ? cached.version : undefined;
}

function runCliVersionProbe(
  binPath: string,
  adapterId: string,
  effectivePath: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const launch = process.platform === 'win32' && /\.cmd$/iu.test(binPath)
        ? windowsNpmShimSpawn(adapterId, binPath) : { file: binPath, argsPrefix: [] };
      if (!launch) {
        resolve(null);
        return;
      }
      execFile(launch.file, [...launch.argsPrefix, '--version'], {
        encoding: 'utf8', timeout: CLI_VERSION_PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024,
        windowsHide: true, env: { ...process.env, PATH: effectivePath },
      }, (error, stdout) => {
        // Unreadable version: retain PATH order, and memoise the failure.
        resolve(error ? null : /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(stdout)?.[0] ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Sonda `--version` FORA do event loop do Main (F-764): `execFile` assíncrono,
 * sem shell, 1,5 s, deduplicada por caminho real + mtime. Grava o resultado
 * no cache — falha também — e avisa quem escuta. Nunca rejeita.
 */
export function probeCliBinaryVersion(
  binPath: string,
  effectivePath = getEffectivePath(),
  adapterId = aiAdapterIdFor(binPath),
): Promise<string | null> {
  if (!adapterId) return Promise.resolve(null);
  // F-1004: o smoke do gate de release roda sem sandbox no HOME real — nunca
  // executa CLI de IA (nem `--version`) no boot.
  if (isCurrentProcessSmokeTest()) return Promise.resolve(null);
  const key = cliVersionKey(binPath, adapterId);
  if (!key) return Promise.resolve(null);
  const cached = cliVersionCache.get(key.realPath);
  if (cached?.mtimeMs === key.mtimeMs &&
      (cached.version !== null || Date.now() - cached.probedAt < CLI_VERSION_FAILURE_RETRY_MS)) {
    return Promise.resolve(cached.version);
  }
  const probeKey = `${key.realPath}\0${key.mtimeMs}`;
  const inFlight = cliVersionProbes.get(probeKey);
  if (inFlight) return inFlight;
  const generation = cliVersionGeneration;
  const probe = runCliVersionProbe(binPath, adapterId, effectivePath).then((version) => {
    if (generation !== cliVersionGeneration) return version;
    cliVersionProbes.delete(probeKey);
    cliVersionCache.set(key.realPath, { mtimeMs: key.mtimeMs, version, probedAt: Date.now() });
    for (const listener of cliVersionListeners) {
      try {
        listener();
      } catch { /* Quem escuta nunca derruba a sonda. */ }
    }
    return version;
  });
  cliVersionProbes.set(probeKey, probe);
  return probe;
}

/** Há alguma sonda `--version` em voo? Barato: só quem decide se vale esperar. */
export function hasCliVersionProbesInFlight(): boolean {
  return cliVersionProbes.size > 0;
}

/** Avisa quando uma sonda aprende uma versão: a escolha entre instalações pode mudar. */
export function onCliVersionLearned(listener: () => void): () => void {
  cliVersionListeners.add(listener);
  return () => {
    cliVersionListeners.delete(listener);
  };
}

/** Instalações reais distintas de uma CLI de IA no PATH, na ordem do PATH. */
function aiCliCandidates(
  command: string,
  adapterId: string,
  processPath: string,
  effective: string,
): string[] {
  const candidates = new Map<string, string>();
  for (const dir of new Set([...processPath.split(path.delimiter), ...effective.split(path.delimiter)])) {
    if (!dir) continue;
    const candidate = lookupInPath(command, dir);
    if (!candidate) continue;
    try {
      const target = process.platform === 'win32'
        ? windowsNpmShimTarget(adapterId, candidate) ?? candidate : candidate;
      const realPath = fs.realpathSync(target);
      if (!candidates.has(realPath)) candidates.set(realPath, candidate);
    } catch { /* Raced with removal: no candidate. */ }
  }
  return [...candidates.values()];
}

function resolutionEffectivePath(
  processPath: string,
  options: { processPath?: string; effectivePath?: string; home?: string },
): string {
  // Prefer memoised effective PATH (one login-shell probe per process lifetime
  // unless refreshUserPath clears it). Tests inject effectivePath directly.
  return options.effectivePath ??
    (options.processPath !== undefined || options.home !== undefined
      ? buildEffectivePath({
          processPath,
          home: options.home,
          loginPath: '',
        })
      : getEffectivePath());
}

/**
 * Aquecimento (boot, "Reexaminar CLIs"): sonda fora do Main as versões que a
 * resolução vai pedir — todas as instalações reais das CLIs de IA duplicadas
 * no PATH e, para os comandos em `alsoSingle`, também a instalação única (o
 * gate de versão do Codex lê o mesmo cache). Resolve quando as sondas
 * terminam e devolve quantas rodaram; nunca rejeita.
 */
export async function warmCliBinaryVersions(
  options: {
    commands?: readonly string[];
    alsoSingle?: readonly string[];
    processPath?: string;
    effectivePath?: string;
    home?: string;
  } = {},
): Promise<number> {
  const processPath = options.processPath ?? process.env.PATH ?? '';
  const effective = resolutionEffectivePath(processPath, options);
  const probes: Array<Promise<string | null>> = [];
  for (const command of options.commands ?? [...aiCliCommands.keys()]) {
    const adapterId = aiCliCommands.get(command);
    // node/git/instaladores nunca competem por versão nem são sondados.
    if (!adapterId) continue;
    const bins = aiCliCandidates(command, adapterId, processPath, effective);
    if (bins.length < 2 && !options.alsoSingle?.includes(command)) continue;
    for (const bin of bins) {
      if (cachedCliBinaryVersion(bin, adapterId) === undefined) {
        probes.push(probeCliBinaryVersion(bin, effective, adapterId));
      }
    }
  }
  await Promise.all(probes);
  return probes.length;
}

/**
 * Resolve a CLI command (or absolute path) to an absolute executable.
 * AI adapters with distinct installations use the newest readable version.
 * Other commands and unreadable versions preserve process/effective PATH order.
 *
 * F-764: síncrona, mas nunca executa uma CLI — só lê versões já em cache.
 * Enquanto a versão de algum candidato é desconhecida, mantém a ordem do PATH
 * e dispara a sonda assíncrona; a próxima resolução já escolhe a mais nova.
 */
export function resolveCliBinary(
  command: string,
  options: {
    processPath?: string;
    effectivePath?: string;
    home?: string;
  } = {},
): CliBinaryResolution | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (path.isAbsolute(trimmed) || trimmed.startsWith('~/')) {
    const absolute = trimmed.startsWith('~/')
      ? path.join(options.home ?? realUserHome(), trimmed.slice(2))
      : trimmed;
    if (!isExecutableFile(absolute)) return null;
    return {
      binPath: absolute,
      effectivePath: options.processPath ?? process.env.PATH ?? '',
      source: 'absolute',
    };
  }

  // Reject relative paths like ./bin/foo — spawn must be absolute or bare.
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;

  const processPath = options.processPath ?? process.env.PATH ?? '';
  const fromProcess = lookupInPath(trimmed, processPath);
  const aiCommand = trimmed.replace(/\.(?:exe|com|cmd|bat)$/iu, '');
  const isAiCli = aiCliCommands.has(aiCommand);
  if (fromProcess && !isAiCli) {
    return { binPath: fromProcess, effectivePath: processPath, source: 'process-path' };
  }

  const effective = resolutionEffectivePath(processPath, options);

  const home = options.home ?? realUserHome();
  const fromEffective = effective === processPath ? null : lookupInPath(trimmed, effective);
  // Only after PATH/explicit launchers lose: retain the operator's chosen
  // installation/channel. Recover a missing/broken native link without
  // overwriting that link or any custom launcher (F-210).
  let resolved = fromProcess ?? fromEffective ?? (trimmed === 'claude' ? nativeClaudeVersionBinary(home) : null);
  if (!resolved) return null;
  let installationWarning: string | undefined;
  if (isAiCli) {
    const adapterId = aiCliCommands.get(aiCommand)!;
    const bins = aiCliCandidates(trimmed, adapterId, processPath, effective);
    if (bins.length > 1) {
      const versions = bins.map((bin) => cachedCliBinaryVersion(bin, adapterId));
      if (versions.includes(undefined)) {
        // Ainda não sondada: nada de subprocesso no Main. Mantém a ordem do
        // PATH agora e sonda fora dele; a próxima resolução já escolhe a nova.
        bins.forEach((bin, index) => {
          if (versions[index] === undefined) void probeCliBinaryVersion(bin, effective, adapterId);
        });
      } else {
        if (versions.every((version) => version !== null)) {
          const newest = versions.reduce((best, version, index) =>
            compareAppVersions(version!, versions[best]!) > 0 ? index : best, 0);
          resolved = bins[newest];
        }
        if (new Set(versions).size > 1) {
          const chosen = versions[bins.indexOf(resolved)] ?? 'não identificada';
          installationWarning = `${bins.length} instalações: ${versions.map((v) => v ?? 'não identificada').join(' e ')}; usando ${chosen}`;
        }
      }
    }
  }
  return {
    binPath: resolved,
    effectivePath: effective,
    source: fromProcess === resolved ? 'process-path' : classifySource(resolved, processPath, home),
    ...(installationWarning ? { installationWarning } : {}),
  };
}

/** True when an absolute path still points at an executable (pre-spawn gate). */
export function revalidateExecutable(binPath: string): boolean {
  if (!binPath || !path.isAbsolute(binPath)) return false;
  return isExecutableFile(binPath);
}

/**
 * Resolve for spawn: prefer a known absolute path, else re-resolve the command.
 * Always returns an absolute path or null.
 */
export function resolveSpawnBinary(
  commandOrPath: string,
  preferredAbsolute?: string | null,
): CliBinaryResolution | null {
  if (preferredAbsolute && revalidateExecutable(preferredAbsolute)) {
    return {
      binPath: preferredAbsolute,
      effectivePath: getEffectivePath(),
      source: 'absolute',
    };
  }
  if (path.isAbsolute(commandOrPath) && revalidateExecutable(commandOrPath)) {
    return {
      binPath: commandOrPath,
      effectivePath: getEffectivePath(),
      source: 'absolute',
    };
  }
  return resolveCliBinary(commandOrPath);
}

export interface WindowsNpmShimLaunch {
  /** Native executable that can receive the npm package entry point directly. */
  readonly file: string;
  /** Prepended before the original CLI arguments. */
  readonly argsPrefix: readonly string[];
}

function isRegularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Bypass cmd.exe only for the standard npm-installed Codex launcher.
 *
 * `codex.cmd` is a batch file, so Windows routes its arguments through
 * cmd.exe's much smaller command-line limit. Nexus adds a structured Codex
 * hook configuration that can legitimately exceed that limit. Executing the
 * adjacent Node runtime with the verified package entry point preserves the
 * exact CLI invocation without invoking a batch interpreter.
 *
 * This deliberately rejects arbitrary .cmd files. The path, shim contents,
 * Node executable, and Codex entry point must all have npm's expected shape.
 */
export function resolveWindowsCodexNpmShimLaunch(
  shimPath: string,
): WindowsNpmShimLaunch | null {
  if (
    process.platform !== 'win32' ||
    !path.isAbsolute(shimPath) ||
    path.basename(shimPath).toLowerCase() !== 'codex.cmd' ||
    !isExecutableFile(shimPath)
  ) {
    return null;
  }

  const binDir = path.dirname(shimPath);
  const node = path.join(binDir, 'node.exe');
  const entry = path.join(
    binDir,
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  if (!isExecutableFile(node) || !isRegularFile(entry)) return null;

  try {
    const normalizedShim = fs
      .readFileSync(shimPath, 'utf8')
      .replaceAll('/', '\\')
      .toLowerCase();
    if (!normalizedShim.includes('node_modules\\@openai\\codex\\bin\\codex.js')) {
      return null;
    }
  } catch {
    return null;
  }

  return { file: node, argsPrefix: [entry] };
}

/** Test seam — clears fold memo so each suite starts clean. */
export function __resetPathResolverForTests(): void {
  folded = false;
  memoizedEffectivePath = null;
  bootLoginProbe = null;
  lookupInPathPass = null;
  bootPathRevalidation = undefined;
  bootPathCache = undefined;
  bootPathInheritedPath = undefined;
  cliVersionCache.clear();
  cliVersionProbes.clear();
  cliVersionGeneration += 1;
}
