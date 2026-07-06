import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { PTY_CHANNELS } from '../../shared/channels';
import type { SpawnRequest, PaneSessionState } from '../../shared/types';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import { resolvePlaceholders } from '../../shared/adapter-types';
import type {
  PtyHost,
  PtyProcHandle,
  PtySessionHandlers,
  PtySpawnSpec,
} from './pty-host-core';

/**
 * Owns every live PTY session — one per pane, addressed by an opaque id. The
 * native node-pty handles live in a separate utilityProcess (pty-host-*.ts); a
 * session's `proc` is a proxy that posts control messages there. All the
 * security-relevant work (env allowlist, argv, ownership, idle state machine,
 * orchestration taps) stays HERE, in trusted main-process code. Data streams
 * main -> renderer over IPC events; input flows renderer -> main.
 *
 * The concrete host is INJECTED (setPtyHost) rather than imported so this module
 * never pulls electron into its graph and stays unit-testable.
 */

interface Session {
  proc: PtyProcHandle;
  wc: WebContents;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleTimeoutMs: number;
  state: PaneSessionState;
}

const sessions = new Map<string, Session>();
let counter = 0;

let ptyHost: PtyHost | null = null;

/** Wire the utilityProcess-backed host (called once at IPC bootstrap). */
export function setPtyHost(host: PtyHost): void {
  ptyHost = host;
}

function requireHost(): PtyHost {
  if (!ptyHost) throw new Error('PTY host not initialized');
  return ptyHost;
}

/** node-pty accepts `string | undefined` values; the host protocol wants a
 * plain, structured-cloneable string map — drop undefined entries. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

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

/**
 * Sessão de provider DITADA pelo Nexus no spawn (adapter.spawn.sessionIdArg):
 * a camada de telemetria real usa este id para atribuir o transcript do CLI ao
 * pane deterministicamente. Hook injetado (mesmo padrão do agentSpawnHook)
 * para o pty-manager continuar livre de dependências de cima.
 */
export interface DictatedSessionInfo {
  providerSessionId: string;
  ptySessionId: string;
  adapterId: string;
  cwd: string;
}

export type SessionDictationHook = (info: DictatedSessionInfo) => void;

let sessionDictationHook: SessionDictationHook | null = null;

export function setSessionDictationHook(hook: SessionDictationHook | null): void {
  sessionDictationHook = hook;
}

/**
 * Lookup injetado de sessão de provider capturada (workspace, paneId) →
 * session id real — permite resume DIRECIONADO (`--resume <id>`) em vez do
 * genérico `--continue`. Injetado pelo usage-service (dono do store).
 */
export type ResumeSessionLookup = (cwd: string, paneId: string) => string | null;

let resumeSessionLookup: ResumeSessionLookup | null = null;

export function setResumeSessionLookup(lookup: ResumeSessionLookup | null): void {
  resumeSessionLookup = lookup;
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

/**
 * Handle one data chunk from the host: push to the renderer, feed the
 * orchestration taps, and drive the busy/idle state machine. Extracted from the
 * old attachProc so a spawn path can build the host session handlers without
 * ever holding a live node-pty handle.
 */
function onSessionData(session: Session, sessionId: string, data: string): void {
  if (canSend(session.wc)) {
    session.wc.send(PTY_CHANNELS.data, { sessionId, data });
  }
  fireTaps(dataTaps, sessionId, data);
  if (session.state !== 'busy') {
    session.state = 'busy';
    emitStateChange(session.wc, sessionId, 'busy');
  }
  if (session.idleTimeoutMs > 0) armIdleTimer(sessionId, session);
}

/** Session lifecycle callbacks handed to the host at spawn time. */
function sessionHandlers(
  sessionId: string,
  getSession: () => Session,
): PtySessionHandlers {
  return {
    onData: (data) => onSessionData(getSession(), sessionId, data),
    onExit: (exitCode, signal) => finalizeSession(sessionId, exitCode, signal),
  };
}

/**
 * Teardown idempotente: notifica renderer + exit taps EXATAMENTE uma vez.
 * destroySession removia a sessão do Map antes do onExit, que então retornava
 * cedo — pty:exit nunca chegava ao renderer, waitForIdle pendurava até o
 * timeout e artefatos do gate (~/.nexus/ephemeral, mcp-configs) vazavam.
 */
function finalizeSession(
  sessionId: string,
  exitCode: number,
  signal?: number,
): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  if (s.idleTimer) clearTimeout(s.idleTimer);
  if (canSend(s.wc)) {
    s.wc.send(PTY_CHANNELS.exit, { sessionId, exitCode, signal });
  }
  fireTaps(exitTaps, sessionId);
}

export interface SpawnedSession {
  sessionId: string;
}

/** Spawn a shell PTY. */
export function spawnSession(wc: WebContents, req: SpawnRequest): SpawnedSession {
  const shell = resolveShell(req.shell);
  const cwd = resolveCwd(req.cwd);
  const sessionId = makeSessionId();
  const spec: PtySpawnSpec = {
    sessionId,
    file: shell,
    args: [],
    cwd,
    cols: req.cols,
    rows: req.rows,
    env: cleanEnv(baseChildEnv()),
  };
  let session!: Session;
  const proc = requireHost().spawn(
    spec,
    sessionHandlers(sessionId, () => session),
  );
  session = {
    proc,
    wc,
    idleTimer: null,
    idleTimeoutMs: 0,
    state: 'spawning',
  };
  sessions.set(sessionId, session);
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
  // Adapters whose interactive argv has no {{MODEL}} placeholder would
  // silently DROP the requested model (route_task picks grok-code-fast-1,
  // grok boots on its default). When a model was explicitly requested and the
  // adapter declares a model flag, append it.
  const explicitModel = req.model ?? overrides.defaultModel;
  const templateHasModel = adapter.spawn.interactive.some((a) =>
    a.includes('{{MODEL}}'),
  );
  if (explicitModel && !templateHasModel && adapter.models.flag) {
    args.push(adapter.models.flag, explicitModel);
  }
  // Failover re-spawn: retoma a conversa anterior. Com session id CAPTURADO
  // para este pane, o resume é direcionado (`--resume <id>` — cada pane volta
  // para a SUA conversa); sem captura, cai no genérico (`--continue`).
  if (req.resume) {
    const captured =
      req.paneId && adapter.spawn.resumeIdArgs?.length
        ? resumeSessionLookup?.(cwd, req.paneId) ?? null
        : null;
    if (captured) {
      args.push(...adapter.spawn.resumeIdArgs!, captured);
    } else if (adapter.spawn.resumeArgs.length > 0) {
      args.push(...adapter.spawn.resumeArgs);
    }
  }
  // Telemetria real: dita o session id do provider em spawns FRESCOS (num
  // resume o CLI decide o id — a atribuição fica com o watcher de transcript).
  let dictatedSessionId: string | null = null;
  if (adapter.spawn.sessionIdArg && !req.resume) {
    dictatedSessionId = randomUUID();
    args.push(adapter.spawn.sessionIdArg, dictatedSessionId);
  }
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
  // Adapter-enforced argv goes last so user/provider settings cannot soften
  // security invariants such as Claude's hidden-subagent Task deny.
  if (adapter.spawn.extraArgs.length > 0) {
    args.push(...adapter.spawn.extraArgs);
  }

  const idleMs =
    adapter.stateParsing.idle.type === 'timeout'
      ? adapter.stateParsing.idle.ms
      : 800;

  const sessionId = makeSessionId();
  const spec: PtySpawnSpec = {
    sessionId,
    file: bin,
    args,
    cwd,
    cols: req.cols,
    rows: req.rows,
    env: cleanEnv(env),
  };
  let session!: Session;
  let proc: PtyProcHandle;
  try {
    proc = requireHost().spawn(
      spec,
      sessionHandlers(sessionId, () => session),
    );
  } catch (err) {
    // The host itself is unavailable (never initialized / failed to fork), so
    // no session will exist — free the minted token + on-disk artifacts here,
    // otherwise a valid bearer token leaks in memory and on disk. A spawn that
    // fails INSIDE the host instead arrives as an async exit, and the exit tap
    // runs the very same cleanup.
    decoration?.onSpawnFailed?.();
    throw err;
  }
  session = {
    proc,
    wc,
    idleTimer: null,
    idleTimeoutMs: idleMs,
    state: 'spawning',
  };
  sessions.set(sessionId, session);
  emitStateChange(wc, sessionId, 'spawning');
  decoration?.onSpawned?.(sessionId);
  if (dictatedSessionId && sessionDictationHook) {
    try {
      sessionDictationHook({
        providerSessionId: dictatedSessionId,
        ptySessionId: sessionId,
        adapterId: adapter.id,
        cwd,
      });
    } catch (err) {
      console.warn('[pty-manager] session dictation hook threw:', err);
    }
  }
  return { sessionId };
}

function ownedSession(wc: WebContents, sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session || session.wc !== wc) return null;
  return session;
}

function destroySession(sessionId: string, session: Session): void {
  finalizeSession(sessionId, 0);
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

export function getLiveSessionCount(): number {
  return sessions.size;
}
