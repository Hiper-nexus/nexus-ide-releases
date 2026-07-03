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
 * Copy the environment, dropping the Electron-specific vars that would confuse
 * a child shell, and force a sensible TERM so ANSI/color output works.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
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
  const proc = nodePty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: req.cols,
    rows: req.rows,
    cwd: req.cwd && req.cwd.length > 0 ? req.cwd : os.homedir(),
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
    if (!wc.isDestroyed()) {
      wc.send(PTY_CHANNELS.exit, { sessionId, exitCode, signal });
    }
    sessions.delete(sessionId);
  });

  return { sessionId };
}

export function writeSession(sessionId: string, data: string): void {
  sessions.get(sessionId)?.proc.write(data);
}

export function resizeSession(sessionId: string, cols: number, rows: number): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    session.proc.resize(cols, rows);
  } catch {
    // A resize racing with process exit can throw; safe to ignore.
  }
}

export function killSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    session.proc.kill();
  } catch {
    // Already dead.
  }
  sessions.delete(sessionId);
}

/** Kill every session owned by a renderer (called when its window closes). */
export function killSessionsFor(wc: WebContents): void {
  for (const [id, session] of sessions) {
    if (session.wc === wc) {
      killSession(id);
    }
  }
}

/** Reap everything on app shutdown. */
export function killAllSessions(): void {
  for (const id of [...sessions.keys()]) {
    killSession(id);
  }
}
