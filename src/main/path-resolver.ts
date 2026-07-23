import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

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

export interface CliBinaryResolution {
  /** Absolute path to an executable file. */
  readonly binPath: string;
  /** PATH string that located the binary (process.env or login+fallbacks). */
  readonly effectivePath: string;
  /** How the binary was found. */
  readonly source: 'absolute' | 'process-path' | 'login-path' | 'fallback-dir';
}

/**
 * Curated install dirs unioned when shell resolution misses them.
 * Order matters when the login shell probe fails: vendor CLI installers
 * (Kimi Code, etc.) come before generic ~/.local/bin, which may hold a
 * different package with the same bare name (e.g. legacy kimi-cli via uv).
 */
export function commonCliBinDirs(home = os.homedir()): string[] {
  return [
    // Vendor-specific official installers first.
    path.join(home, '.kimi-code', 'bin'),
    // Package managers / version managers.
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.nvm', 'current', 'bin'),
    path.join(home, '.fnm', 'current', 'bin'),
    path.join(home, '.asdf', 'shims'),
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

/** Ask the user's login+interactive shell for its PATH. Empty string on failure. */
export function probeLoginShellPath(
  exec: typeof execFileSync = execFileSync,
): string {
  if (process.platform === 'win32') return process.env.PATH ?? '';
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    // -l login (sources .zprofile), -i interactive (sources .zshrc where users
    // usually export PATH), -c command. Sentinel-wrapped so we can extract the
    // value even if the interactive shell prints a banner/prompt.
    const out = exec(
      shell,
      ['-lic', `printf '%s%s%s' '${START}' "$PATH" '${END}'`],
      { encoding: 'utf8', timeout: RESOLVE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
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
 * When `loginPath` is omitted, the login shell is probed. Callers that already
 * hold a memoised PATH should pass it explicitly to avoid repeated shell spawns.
 */
export function buildEffectivePath(options: {
  processPath?: string;
  loginPath?: string;
  home?: string;
} = {}): string {
  const processPath = options.processPath ?? process.env.PATH ?? '';
  const loginPath =
    options.loginPath !== undefined ? options.loginPath : probeLoginShellPath();
  const parts = new Set<string>();
  for (const dir of processPath.split(path.delimiter)) {
    if (dir) parts.add(dir);
  }
  for (const dir of loginPath.split(path.delimiter)) {
    if (dir) parts.add(dir);
  }
  for (const dir of existingDirs(commonCliBinDirs(options.home))) {
    parts.add(dir);
  }
  return [...parts].join(path.delimiter);
}

let folded = false;
let memoizedEffectivePath: string | null = null;

/**
 * Fold the login-shell PATH + common install dirs into process.env.PATH.
 * Idempotent; safe to call once during bootstrap BEFORE the adapter registry
 * probes for installed CLIs.
 */
export function resolveUserPath(): void {
  if (folded) return;
  const effective = buildEffectivePath();
  process.env.PATH = effective;
  memoizedEffectivePath = effective;
  folded = true;
}

/**
 * Re-fold PATH live (post `brew install`, external CLI installer, etc.).
 * Called by "Reexaminar CLIs" so discovery and spawn see newly installed tools.
 */
export function refreshUserPath(): string {
  // Clear memo so buildEffectivePath re-probes the login shell.
  memoizedEffectivePath = null;
  const effective = buildEffectivePath();
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
  const effective = buildEffectivePath();
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
    // On Windows, existence of a file is enough for node-pty/cmd resolution.
    if (process.platform === 'win32') return true;
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
    if (isExecutableFile(candidate)) return candidate;
    if (process.platform === 'win32') {
      const pathext = process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
      for (const ext of pathext.split(';')) {
        if (!ext) continue;
        // Try both original case (PATHEXT is usually uppercase) and lower.
        const variants = [candidate + ext, candidate + ext.toLowerCase()];
        for (const withExt of variants) {
          if (isExecutableFile(withExt)) return withExt;
        }
      }
    }
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
      ? path.join(options.home ?? os.homedir(), trimmed.slice(2))
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
          // Avoid nested login probes when caller already set processPath for tests.
          loginPath: options.processPath !== undefined ? '' : undefined,
        })
      : getEffectivePath());

  if (effective === processPath) return null;

  const fromEffective = lookupInPath(trimmed, effective);
  if (!fromEffective) return null;

  const home = options.home ?? os.homedir();
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

/** Test seam — clears fold memo so each suite starts clean. */
export function __resetPathResolverForTests(): void {
  folded = false;
  memoizedEffectivePath = null;
}
