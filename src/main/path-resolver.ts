import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

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
  return [
    path.join(appData, 'npm'),
    path.join(localAppData, 'pnpm'),
    path.join(localAppData, 'Volta', 'bin'),
    path.join(home, 'scoop', 'shims'),
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
    execFile(file, [...args], options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
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
  if (process.platform === 'win32') return process.env.PATH ?? '';
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

/**
 * Fold the login-shell PATH + common install dirs into process.env.PATH.
 * Idempotent; safe to call once during bootstrap BEFORE the adapter registry
 * probes for installed CLIs.
 */
export async function resolveUserPath(): Promise<void> {
  if (folded) return;
  const home = realUserHome();
  bootLoginProbe = await probeLoginShellPath(undefined, home);
  const effective = buildEffectivePath({ home, loginPath: bootLoginProbe });
  process.env.PATH = effective;
  memoizedEffectivePath = effective;
  folded = true;
}

/** Login-shell PATH seen at boot; '' = probe failed or timed out. */
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
  if (process.platform === 'win32') return false;
  const bootProbe = options.bootProbe !== undefined ? options.bootProbe : bootLoginProbe;
  if (bootProbe === null || bootProbe !== '') return false;
  const home = options.home ?? realUserHome();
  const loginPath = await probeLoginShellPath(exec, home, LATE_RESOLVE_TIMEOUT_MS);
  if (!loginPath) return false;
  const effective = buildEffectivePath({ home, loginPath });
  process.env.PATH = effective;
  memoizedEffectivePath = effective;
  bootLoginProbe = loginPath;
  folded = true;
  return true;
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
  for (const dir of pathString.split(pathSep)) {
    if (!dir) continue;
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
      const pathext = process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
      for (const ext of pathext.split(';')) {
        if (!ext) continue;
        const normalizedExt = ext.toLowerCase();
        if (!WINDOWS_PTY_EXECUTABLE_EXTENSIONS.has(normalizedExt)) continue;
        // Use the normalized spelling. NTFS lookup remains case-insensitive,
        // while callers get a stable path for persistence and tests.
        const withExt = candidate + normalizedExt;
        if (isExecutableFile(withExt)) return withExt;
      }
      continue;
    }
    if (isExecutableFile(candidate)) return candidate;
  }
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

/**
 * Resolve a CLI command (or absolute path) to an absolute executable.
 * Uses process PATH first, then the memoised effective PATH (login + fallbacks).
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
  if (fromProcess) {
    return {
      binPath: fromProcess,
      effectivePath: processPath,
      source: 'process-path',
    };
  }

  // Prefer memoised effective PATH (one login-shell probe per process lifetime
  // unless refreshUserPath clears it). Tests inject effectivePath directly.
  const effective =
    options.effectivePath ??
    (options.processPath !== undefined || options.home !== undefined
      ? buildEffectivePath({
          processPath,
          home: options.home,
          loginPath: '',
        })
      : getEffectivePath());

  if (effective === processPath) return null;

  const fromEffective = lookupInPath(trimmed, effective);
  if (!fromEffective) return null;

  const home = options.home ?? realUserHome();
  return {
    binPath: fromEffective,
    effectivePath: effective,
    source: classifySource(fromEffective, processPath, home),
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
}
