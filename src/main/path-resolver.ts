import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * macOS (and Linux) GUI apps launched from Finder/the dock inherit a MINIMAL
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — NOT the user's login-shell PATH where
 * `claude`, `codex`, `kimi`, `grok`, homebrew, npm-global and ~/.local/bin live.
 * So a packaged build reports every CLI as "not installed" even though the
 * terminal finds them fine.
 *
 * This resolves the real interactive login-shell PATH once at startup and folds
 * it into process.env.PATH, so both CLI detection (`which`) and the PTY spawn
 * env see the same tools the user does. Same fix VS Code / Hyper ship.
 */

const START = '__NEXUS_PATH_START__';
const END = '__NEXUS_PATH_END__';
const RESOLVE_TIMEOUT_MS = 4000;

/** Common install dirs to union in, in case shell resolution misses them. */
function fallbackDirs(): string[] {
  const home = os.homedir();
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.nvm', 'current', 'bin'),
    '/usr/local/go/bin',
  ].filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Ask the user's login+interactive shell for its PATH. Empty string on failure. */
function loginShellPath(): string {
  if (process.platform === 'win32') return '';
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    // -l login (sources .zprofile), -i interactive (sources .zshrc where users
    // usually export PATH), -c command. Sentinel-wrapped so we can extract the
    // value even if the interactive shell prints a banner/prompt.
    const out = execFileSync(
      shell,
      ['-lic', `printf '%s%s%s' '${START}' "$PATH" '${END}'`],
      { encoding: 'utf8', timeout: RESOLVE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const match = out.slice(out.indexOf(START) + START.length, out.indexOf(END));
    return out.includes(START) && out.includes(END) ? match : '';
  } catch {
    return '';
  }
}

let resolved = false;

/**
 * Fold the login-shell PATH + common install dirs into process.env.PATH.
 * Idempotent; safe to call once during bootstrap BEFORE the adapter registry
 * probes for installed CLIs.
 */
export function resolveUserPath(): void {
  if (resolved) return;
  resolved = true;

  const current = process.env.PATH ?? '';
  const parts = new Set(current.split(path.delimiter).filter(Boolean));

  // Shell PATH first (highest fidelity), then curated fallbacks.
  for (const dir of loginShellPath().split(path.delimiter)) {
    if (dir) parts.add(dir);
  }
  for (const dir of fallbackDirs()) parts.add(dir);

  process.env.PATH = [...parts].join(path.delimiter);
}
