import fs from 'node:fs';
import os from 'node:os';
import type { WebContents } from 'electron';
import * as nodePty from '@lydell/node-pty';
import { PTY_CHANNELS } from '../../shared/channels';
import type { SpawnRequest, PaneSessionState } from '../../shared/types';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import { resolvePlaceholders } from '../../shared/adapter-types';

/**
 * Owns every live PTY. One session per pane, addressed by an opaque id. Data is
 * streamed main -> renderer over IPC events; input flows renderer -> main.
 */

interface Session {
  proc: nodePty.IPty;
  wc: WebContents;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleTimeoutMs: number;
  state: PaneSessionState;
}

const sessions = new Map<string, Session>();
let counter = 0;

/**
 * Orchestration taps. The orchestration layer (embedded MCP server, handoff
 * parser, idle delivery) observes every session without owning any: data
 * chunks feed ring buffers + the legacy handoff parser, state changes feed
 * pane_wait_idle and idle delivery, exits clean the registries up.
 */
export type SessionDataTap = (sessionId: string, data: string) => void;
export type SessionStateTap = (
  sessionId: string,
  state: PaneSessionState,
) => void;
export type SessionExitTap = (sessionId: string) => void;

const dataTaps = new Set<SessionDataTap>();
const stateTaps = new Set<SessionStateTap>();
const exitTaps = new Set<SessionExitTap>();

export function tapSessionData(cb: SessionDataTap): () => void {
  dataTaps.add(cb);
  return () => dataTaps.delete(cb);
}

export function tapSessionState(cb: SessionStateTap): () => void {
  stateTaps.add(cb);
  return () => stateTaps.delete(cb);
}

export function tapSessionExit(cb: SessionExitTap): () => void {
  exitTaps.add(cb);
  return () => exitTaps.delete(cb);
}

function fireTaps<T extends (...args: never[]) => void>(
  taps: Set<T>,
  ...args: Parameters<T>
): void {
  for (const tap of taps) {
    try {
      tap(...args);
    } catch (err) {
      console.warn('[pty-manager] orchestration tap threw:', err);
    }
  }
}

/**
 * Decoration applied to a cli-agent spawn by the orchestration layer: extra
 * env (MCP endpoint + auth token, ephemeral HOME), extra argv entries
 * (e.g. --mcp-config), and a callback binding the minted token to the
 * concrete sessionId once the PTY exists.
 */
export interface AgentSpawnDecoration {
  env: Record<string, string>;
  extraArgs: string[];
  onSpawned?: (sessionId: string) => void;
  /** Called if the PTY fails to spawn, so minted tokens/artifacts are freed. */
  onSpawnFailed?: () => void;
}

export type AgentSpawnHook = (
  adapter: CliPtyAdapter,
  req: SpawnRequest,
) => AgentSpawnDecoration | null;

let agentSpawnHook: AgentSpawnHook | null = null;

export function setAgentSpawnHook(hook: AgentSpawnHook | null): void {
  agentSpawnHook = hook;
}

function resolveShell(requested?: string): string {
  if (requested) return requested;
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

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
 * *allowlist*, not a denylist: the main process may hold API keys for CLI-agent
 * adapters in its own `process.env`, and those must never be inherited by every
 * child shell. Only names matched here — plus the `LC_*` locale prefix — are
 * forwarded to shell panes.
 */
const ENV_ALLOWLIST = new Set<string>([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'TMPDIR', 'TZ',
  'LANG', 'LANGUAGE', 'LC_ALL', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'COLORTERM', 'EDITOR', 'VISUAL', 'PAGER', 'MANPATH', 'INFOPATH',
  'LSCOLORS', 'LS_COLORS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
  'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  'SystemRoot', 'SystemDrive', 'windir', 'WINDIR', 'COMSPEC', 'ComSpec',
  'PATHEXT', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ALLUSERSPROFILE', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles',
  'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]);

const ENV_ALLOW_PREFIXES = ['LC_'];

function baseChildEnv(): NodeJS.ProcessEnv {
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

/**
 * Dynamic-linker injection vars. An adapter is loaded from the user plugin dir
 * (`~/.nexus/plugins/adapters`), which is a TRUST BOUNDARY: a malicious or
 * compromised plugin must not be able to set `DYLD_INSERT_LIBRARIES` (macOS) or
 * `LD_PRELOAD`/`LD_LIBRARY_PATH` (Linux) on the child PTY to load arbitrary code
 * into the agent process. Any adapter-declared env key matching these prefixes is
 * dropped, regardless of whether it came from `static` or `passthrough`.
 */
const DANGEROUS_ENV_PREFIXES = ['DYLD_', 'LD_'];

function isDangerousEnvKey(key: string): boolean {
  return DANGEROUS_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Build the env for a cli-agent session. Starts from the base allowlist, then
 * adds adapter-declared passthrough vars and static vars. Auth env vars enter
 * ONLY this specific PTY — not all shells. Linker-injection keys from the plugin
 * are refused as a trust-boundary control (see DANGEROUS_ENV_PREFIXES).
 */
export function agentEnv(adapter: CliPtyAdapter): NodeJS.ProcessEnv {
  const env = baseChildEnv();
  for (const key of adapter.env.passthrough) {
    if (isDangerousEnvKey(key)) {
      console.warn(`[pty-manager] refusing linker-injection passthrough env "${key}" from adapter "${adapter.id}"`);
      continue;
    }
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(adapter.env.static)) {
    if (isDangerousEnvKey(key)) {
      console.warn(`[pty-manager] refusing linker-injection static env "${key}" from adapter "${adapter.id}"`);
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * Whether it is safe to push an IPC event to this webContents. Guards against a
 * PTY event (data/exit/state) arriving after the owning window closed or its
 * renderer crashed. `isDestroyed()` alone is insufficient: a freshly crashed
 * renderer still reports false, and send() would then log "Render frame was
 * disposed". Such late events are silently dropped, never crash the main process.
 */
function canSend(wc: WebContents): boolean {
  return !wc.isDestroyed() && !wc.isCrashed();
}

function emitStateChange(
  wc: WebContents,
  sessionId: string,
  state: PaneSessionState,
): void {
  if (canSend(wc)) {
    wc.send(PTY_CHANNELS.stateChange, { sessionId, state });
  }
  fireTaps(stateTaps, sessionId, state);
}

function armIdleTimer(sessionId: string, session: Session): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.idleTimeoutMs <= 0) return;
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (!sessions.has(sessionId)) return;
    session.state = 'idle';
    emitStateChange(session.wc, sessionId, 'idle');
  }, session.idleTimeoutMs);
}

function makeSessionId(): string {
  return `pty-${Date.now().toString(36)}-${++counter}`;
}

function attachProc(
  proc: nodePty.IPty,
  sessionId: string,
  session: Session,
): void {
  proc.onData((data) => {
    if (canSend(session.wc)) {
      session.wc.send(PTY_CHANNELS.data, { sessionId, data });
    }
    fireTaps(dataTaps, sessionId, data);
    if (session.state !== 'busy') {
      session.state = 'busy';
      emitStateChange(session.wc, sessionId, 'busy');
    }
    if (session.idleTimeoutMs > 0) armIdleTimer(sessionId, session);
  });

  proc.onExit(({ exitCode, signal }) => {
    if (!sessions.has(sessionId)) return;
    const s = sessions.get(sessionId)!;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    sessions.delete(sessionId);
    if (canSend(session.wc)) {
      session.wc.send(PTY_CHANNELS.exit, { sessionId, exitCode, signal });
    }
    fireTaps(exitTaps, sessionId);
  });
}

export interface SpawnedSession {
  sessionId: string;
}

/** Spawn a shell PTY. */
export function spawnSession(wc: WebContents, req: SpawnRequest): SpawnedSession {
  const shell = resolveShell(req.shell);
  const cwd = resolveCwd(req.cwd);
  const proc = nodePty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: req.cols,
    rows: req.rows,
    cwd,
    env: baseChildEnv(),
  });

  const sessionId = makeSessionId();
  const session: Session = {
    proc,
    wc,
    idleTimer: null,
    idleTimeoutMs: 0,
    state: 'spawning',
  };
  sessions.set(sessionId, session);
  attachProc(proc, sessionId, session);
  return { sessionId };
}

/** User overrides from the provider settings hub, applied at spawn time. */
export interface AgentSpawnOverrides {
  binPath?: string | null;
  defaultModel?: string | null;
  extraArgs?: string[];
  keyEnv?: Record<string, string>;
  /**
   * Env vars stripped AFTER the adapter env is built — an authenticated
   * subscription CLI must not inherit e.g. ANTHROPIC_API_KEY, which would
   * silently divert billing from the plan to the API.
   */
  suppressEnv?: string[];
}

/** Spawn a cli-agent PTY from a validated adapter. */
export function spawnAgentSession(
  wc: WebContents,
  req: SpawnRequest,
  adapter: CliPtyAdapter,
  overrides: AgentSpawnOverrides = {},
): SpawnedSession {
  const cwd = resolveCwd(req.cwd);
  const model =
    req.model ?? overrides.defaultModel ?? adapter.models.default;
  const argv = resolvePlaceholders(adapter.spawn.interactive, {
    MODEL: model,
    CWD: cwd,
    SESSION_ID: '',
    PROMPT: '',
  }).filter((a) => a.length > 0);

  // A user-set absolute binary path overrides the adapter's declared command.
  const bin = overrides.binPath || argv[0];
  const args = argv.slice(1);
  if (overrides.extraArgs && overrides.extraArgs.length > 0) {
    args.push(...overrides.extraArgs);
  }
  const env = agentEnv(adapter);
  // Subscription-first: strip inherited key/token vars before any injection.
  for (const name of overrides.suppressEnv ?? []) {
    delete env[name];
  }
  // Inject the keychain-stored API key as the adapter's auth env var. Linker
  // vars are still refused (isDangerousEnvKey) as a defense-in-depth check.
  for (const [key, value] of Object.entries(overrides.keyEnv ?? {})) {
    if (!isDangerousEnvKey(key)) env[key] = value;
  }

  // Orchestration decoration: MCP endpoint env, skill-gate ephemeral HOME and
  // extra argv (e.g. --mcp-config). The hook is trusted main-process code.
  const decoration = agentSpawnHook ? agentSpawnHook(adapter, req) : null;
  if (decoration) {
    Object.assign(env, decoration.env);
    args.push(...decoration.extraArgs);
  }

  let proc: nodePty.IPty;
  try {
    proc = nodePty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: req.cols,
      rows: req.rows,
      cwd,
      env,
    });
  } catch (err) {
    // Spawn failed → onSpawned never runs, so free the minted token + files
    // here (otherwise a valid bearer token leaks in memory and on disk).
    decoration?.onSpawnFailed?.();
    throw err;
  }

  const idleMs =
    adapter.stateParsing.idle.type === 'timeout'
      ? adapter.stateParsing.idle.ms
      : 800;

  const sessionId = makeSessionId();
  const session: Session = {
    proc,
    wc,
    idleTimer: null,
    idleTimeoutMs: idleMs,
    state: 'spawning',
  };
  sessions.set(sessionId, session);
  emitStateChange(wc, sessionId, 'spawning');
  attachProc(proc, sessionId, session);
  decoration?.onSpawned?.(sessionId);
  return { sessionId };
}

function ownedSession(wc: WebContents, sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session || session.wc !== wc) return null;
  return session;
}

function destroySession(sessionId: string, session: Session): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  sessions.delete(sessionId);
  try {
    session.proc.kill();
  } catch {
    // Already dead.
  }
}

export function writeSession(wc: WebContents, sessionId: string, data: string): void {
  const session = ownedSession(wc, sessionId);
  if (!session) return;
  // User wrote input → re-arm the idle timer if applicable.
  if (session.state === 'idle') {
    session.state = 'busy';
    emitStateChange(wc, sessionId, 'busy');
  }
  if (session.idleTimeoutMs > 0) armIdleTimer(sessionId, session);
  session.proc.write(data);
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

export function killSessionsFor(wc: WebContents): void {
  for (const [id, session] of sessions) {
    if (session.wc === wc) destroySession(id, session);
  }
}

export function killAllSessions(): void {
  for (const [id, session] of [...sessions]) {
    destroySession(id, session);
  }
}

/**
 * Trusted main-process write used by the orchestration layer (MCP pane_write,
 * idle handoff delivery, voice→orchestrator routing). Bypasses WebContents
 * ownership — the caller is the main process itself, not a renderer.
 */
export function orchWriteSession(sessionId: string, data: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.state === 'idle') {
    session.state = 'busy';
    emitStateChange(session.wc, sessionId, 'busy');
  }
  if (session.idleTimeoutMs > 0) armIdleTimer(sessionId, session);
  session.proc.write(data);
  return true;
}

/** Trusted main-process kill (MCP pane_close on a session-only target). */
export function orchKillSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  destroySession(sessionId, session);
  return true;
}

/** Current lifecycle state of a session, or null if it is gone. */
export function getSessionState(sessionId: string): PaneSessionState | null {
  return sessions.get(sessionId)?.state ?? null;
}
