import fs from 'node:fs';
import os from 'node:os';
import type { WebContents } from 'electron';
import * as nodePty from '@lydell/node-pty';
import { PTY_CHANNELS } from '../../shared/channels';
import type { SpawnRequest } from '../../shared/types';

/**
 * Owns every live PTY. One session per pane, addressed by an opaque id. Data is
 * streamed main -> renderer over IPC events; input flows renderer -> main.
 *
 * Runs in the main process (VS Code style "pty host" split is deferred to a
 * later phase — documented in the handoff). All process handles live here so
 * shutdown can reliably reap them.
 */

interface Session {
  proc: nodePty.IPty;
  wc: WebContents;
}

const sessions = new Map<string, Session>();
let counter = 0;

/** Resolve the user's shell with sane cross-platform fallbacks. */
function resolveShell(requested?: string): string {
  if (requested) return requested;
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

/**
 * Resolve the working directory, falling back to the home dir when the requested
 * path is missing or not a directory. A persisted layout can point at a folder
 * that has since been deleted — that must never fail the spawn.
 */
function resolveCwd(requested?: string): string {
  if (requested && requested.length > 0) {
    try {
      if (fs.statSync(requested).isDirectory()) return requested;
    } catch {
      // Missing or inaccessible — fall through to the home directory.
    }
  }
  return os.homedir();
}

/**
 * Env vars that are safe (and expected) for an interactive dev shell. This is an
 * *allowlist*, not a denylist: the main process may hold secrets (API keys for
 * CLI-agent adapters landing in phase 2b) in its own `process.env`, and those
 * must never be inherited by every child shell. Only names matched here — plus
 * the `LC_*` locale prefix — are forwarded.
 */
const ENV_ALLOWLIST = new Set<string>([
  // POSIX / shell essentials
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  'TMPDIR',
  'TZ',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'COLORTERM',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'MANPATH',
  'INFOPATH',
  'LSCOLORS',
  'LS_COLORS',
  // X11 / Wayland + ssh-agent so GUI/git-over-ssh keep working (paths, not secrets)
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  // Windows shell essentials
  'SystemRoot',
  'SystemDrive',
  'windir',
  'WINDIR',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ALLUSERSPROFILE',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'TEMP',
  'TMP',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);

const ENV_ALLOW_PREFIXES = ['LC_'];

/**
 * Build a minimal child environment from the allowlist and force a sensible TERM
 * so ANSI/color output works. Anything not explicitly permitted (including
 * secrets and Electron-specific vars) is dropped.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const allowed =
      ENV_ALLOWLIST.has(key) ||
      ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (allowed) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

export interface SpawnedSession {
  sessionId: string;
}

/**
 * Spawn a shell PTY for the given renderer. Throws if the shell binary cannot
 * be launched (missing/invalid shell) — callers must translate that into a
 * structured IPC error.
 */
export function spawnSession(wc: WebContents, req: SpawnRequest): SpawnedSession {
  const shell = resolveShell(req.shell);
  const cwd = resolveCwd(req.cwd);
  const proc = nodePty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: req.cols,
    rows: req.rows,
    cwd,
    env: childEnv(),
  });

  const sessionId = `pty-${Date.now().toString(36)}-${++counter}`;
  sessions.set(sessionId, { proc, wc });

  proc.onData((data) => {
    if (!wc.isDestroyed()) {
      wc.send(PTY_CHANNELS.data, { sessionId, data });
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    // An explicit kill deletes the session from the map *before* proc.kill(), so
    // a still-present entry here means the process exited on its own — only then
    // do we surface the exit to the renderer (no ghost message after kill).
    if (!sessions.has(sessionId)) return;
    sessions.delete(sessionId);
    if (!wc.isDestroyed()) {
      wc.send(PTY_CHANNELS.exit, { sessionId, exitCode, signal });
    }
  });

  return { sessionId };
}

/**
 * Look up a session, enforcing that `wc` is the renderer that owns it. Session
 * ids are guessable (`pty-<time>-<counter>`), so without this an untrusted or
 * compromised renderer could drive another window's PTY. Returns null when the
 * session is missing or owned by a different sender.
 */
function ownedSession(wc: WebContents, sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session || session.wc !== wc) return null;
  return session;
}

/** Delete from the map *before* killing so the onExit handler stays silent. */
function destroySession(sessionId: string, session: Session): void {
  sessions.delete(sessionId);
  try {
    session.proc.kill();
  } catch {
    // Already dead.
  }
}

export function writeSession(wc: WebContents, sessionId: string, data: string): void {
  ownedSession(wc, sessionId)?.proc.write(data);
}

export function resizeSession(
  wc: WebContents,
  sessionId: string,
  cols: number,
  rows: number,
): void {
  const session = ownedSession(wc, sessionId);
  if (!session) return;
  try {
    session.proc.resize(cols, rows);
  } catch {
    // A resize racing with process exit can throw; safe to ignore.
  }
}

export function killSession(wc: WebContents, sessionId: string): void {
  const session = ownedSession(wc, sessionId);
  if (!session) return;
  destroySession(sessionId, session);
}

/** Kill every session owned by a renderer (called when its window closes). */
export function killSessionsFor(wc: WebContents): void {
  for (const [id, session] of sessions) {
    if (session.wc === wc) {
      destroySession(id, session);
    }
  }
}

/** Reap everything on app shutdown. */
export function killAllSessions(): void {
  for (const [id, session] of [...sessions]) {
    destroySession(id, session);
  }
}
