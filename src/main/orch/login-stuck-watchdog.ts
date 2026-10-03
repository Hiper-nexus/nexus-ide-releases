import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
import type { WebContents } from 'electron';
import {
  getAgentSessionInfo,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import {
  getOwnedPaneAuthzInfoBySession,
  readSessionOutput,
} from './pane-registry';
import { getAgentSemanticStatus } from './agent-status';
import { getAdapter } from '../adapters/adapter-registry';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import type { PaneLoginStuckEvent } from '../../shared/types';
import { getRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { getProjectDomainStores } from './project-domain-store-registry';
import { onHandoffSubmitted } from './idle-delivery';
import { sameProjectScope } from './project-scoped-broadcast';

/**
 * Login-stuck watchdog (peer ADE v1.2 harvest, fix F-256): marker + recheck
 * over the pane output tail. A CLI that falls onto its login screen after
 * spawn ("Select login method", a "Signing in…" spinner that never resolves)
 * otherwise reads as a pane that is busy forever — the mission waits on an
 * agent that will never start.
 *
 * Hard rules:
 *  - NEVER kill / auto-respawn / inject input. CLI-login stuck only reports a
 *    typed `login-stuck` state (renderer event + queryable getter + log) so
 *    the UI can offer the adapter's login flow.
 *  - MCP-auth stuck (ambient servers hung on boot) additionally submits a
 *    synthetic `failed` handoff — same non-destructive wake pattern as the
 *    stall-watchdog — so the Maestro can fail-fast instead of looping sleep.
 *  - Never on the hot path: PTY output is NOT scanned per chunk. Tails are
 *    read (from the ring buffer pane-registry already keeps) once per tick
 *    (5s), only for sessions that transitioned to busy, capped at
 *    LOGIN_STUCK_MAX_SESSIONS.
 *  - Clears on the first sign of progress: new significant output, the
 *    pattern leaving the tail, or (for CLI-login only) the wave-1 semantic
 *    hook reporting the pane as `working`.
 */

export const LOGIN_STUCK_TICK_MS = 5_000;
export const LOGIN_STUCK_WINDOW_MS = 15_000;
export const LOGIN_STUCK_REQUIRED_WINDOWS = 2;
export const LOGIN_STUCK_MAX_SESSIONS = 24;
/** Lines of plain-text tail inspected per tick. */
const TAIL_LINES = 40;

interface StuckPattern {
  /** Adapter id this pattern applies to; '*' matches every flavor. */
  flavor: string;
  re: RegExp;
  label: string;
  /**
   * `cli-login` = provider OAuth / device-flow screen (UI can offer login).
   * `mcp-auth` = third-party MCP server hung on boot (handoff fail-fast; do
   * not clear just because the semantic hook reports `working` — the CLI can
   * look "busy" while stuck in an MCP handshake loop).
   */
  kind: 'cli-login' | 'mcp-auth';
}

// Curated, deliberately short heuristics: every entry costs one RegExp.test
// per watched session per tick, and a false positive only costs a "login
// stuck?" surface — never a kill. Add a pattern only for a login screen a
// real CLI was seen stuck on; keep them specific (multi-word) to stay clear
// of ordinary agent output.
const STUCK_PATTERNS: StuckPattern[] = [
  // Claude Code OAuth menu shown when no readable session exists.
  { flavor: 'claude', re: /select login method/i, label: 'claude login menu', kind: 'cli-login' },
  { flavor: 'claude', re: /please run \/login/i, label: 'claude please-run-login', kind: 'cli-login' },
  { flavor: '*', re: /oauth access token has expired/i, label: 'oauth token expired login', kind: 'cli-login' },
  // Grok's OAuth spinner ("Signing in…") repaints forever on a dead flow.
  { flavor: 'grok', re: /signing in/i, label: 'grok signing-in spinner', kind: 'cli-login' },
  // Device-flow prompts that wait for a keypress nobody will send.
  { flavor: '*', re: /press enter to log ?in/i, label: 'press-enter-to-login prompt', kind: 'cli-login' },
  // Codex ChatGPT login screen.
  { flavor: 'codex', re: /sign in with chatgpt/i, label: 'codex ChatGPT login screen', kind: 'cli-login' },
  // AGY (Antigravity) Google OAuth screen.
  { flavor: 'agy', re: /sign in with google/i, label: 'agy Google OAuth screen', kind: 'cli-login' },
  // Kimi Code login-required screen.
  { flavor: 'kimi', re: /login required/i, label: 'kimi login-required screen', kind: 'cli-login' },
  // Generic "waiting for authentication/login" hold screens.
  { flavor: '*', re: /waiting for (authentication|login)/i, label: 'generic auth wait', kind: 'cli-login' },
  // Ambient MCP servers hanging boot (field: cloudflare-api / higgsfield /
  // figma). Fail-fast path — synthetic handoff, not a login UI offer.
  { flavor: '*', re: /\bnot logged in\b/i, label: 'mcp not logged in', kind: 'mcp-auth' },
  { flavor: '*', re: /handshake failed/i, label: 'mcp handshake failed', kind: 'mcp-auth' },
  {
    flavor: '*',
    re: /mcp(?:\s+server)?[^\n]{0,80}(?:unauthorized|authentication required|auth(?:entication)? (?:failed|error))/i,
    label: 'mcp auth failure',
    kind: 'mcp-auth',
  },
];

export function isMcpAuthStuckPattern(label: string): boolean {
  return STUCK_PATTERNS.some((p) => p.kind === 'mcp-auth' && p.label === label);
}

// Braille spinners (⠋⠙⠹…) and digit counters ("Signing in… 12s") repaint
// every frame WITHOUT meaning progress — strip both before comparing tails,
// so a live spinner still counts as "no significant new output".
function quietKeyOf(tail: string): string {
  return tail.replace(/\d+/g, '#').replace(/[⠀-⣿]/g, '');
}

function matchPattern(adapterId: string, plainTail: string): StuckPattern | null {
  if (!plainTail) return null;
  for (const pattern of STUCK_PATTERNS) {
    if (pattern.flavor !== '*' && pattern.flavor !== adapterId) continue;
    if (pattern.re.test(plainTail)) return pattern;
  }
  return null;
}

export interface LoginStuckWatchdogDeps {
  now(): number;
  /** Plain-text tail of a session's recent output (newest last). */
  readTail(sessionId: string): string;
  /** Wave-1 semantic hook status; 'working' is real agent progress. */
  getSemanticStatus(paneId: string): { status: string } | null;
  /** Whether the adapter has an interactive login flow the UI can offer. */
  canOpenLogin(adapterId: string): boolean;
  emit(event: PaneLoginStuckEvent): void;
  log?(message: string): void;
  /**
   * Optional side-effect for mission workers stuck on MCP auth (fail-fast
   * handoff). Never called for ordinary CLI login screens — those stay UI-only
   * so the operator can complete OAuth.
   */
  onMcpAuthStuck?(event: PaneLoginStuckEvent): void;
}

interface WatchedSession {
  sessionId: string;
  paneId: string;
  adapterId: string;
  matchedPattern: StuckPattern | null;
  lastQuietKey: string;
  windowStartedAt: number | null;
  quietWindows: number;
  stuck: boolean;
}

export interface LoginStuckWatchdog {
  /** Register a busy agent session. Idempotent; false when the cap is full. */
  trackSession(sessionId: string, paneId: string, adapterId: string): boolean;
  dropSession(sessionId: string): void;
  /** One evaluation pass over every watched session (clock comes from deps). */
  tick(context?: PeriodicTaskContext): void | Promise<void>;
  /** Current stuck event for a pane, or null when the pane is fine. */
  paneState(paneId: string): PaneLoginStuckEvent | null;
  watchedCount(): number;
}

export function createLoginStuckWatchdog(
  deps: LoginStuckWatchdogDeps,
): LoginStuckWatchdog {
  const sessions = new Map<string, WatchedSession>();
  const log = deps.log ?? ((message: string) => console.warn(message));

  function buildEvent(watch: WatchedSession, stuck: boolean): PaneLoginStuckEvent {
    return {
      paneId: watch.paneId,
      sessionId: watch.sessionId,
      adapterId: watch.adapterId,
      stuck,
      pattern: watch.matchedPattern?.label ?? '',
      // MCP-auth hangs are not cured by opening the CLI login flow.
      canOpenLogin:
        watch.matchedPattern?.kind === 'mcp-auth'
          ? false
          : deps.canOpenLogin(watch.adapterId),
      at: deps.now(),
    };
  }

  function declareStuck(watch: WatchedSession): void {
    watch.stuck = true;
    log(
      `[login-stuck] pane ${watch.paneId} (${watch.adapterId}) parado em ` +
        `"${watch.matchedPattern?.label ?? 'login'}" — sem saída nova por ` +
        `${LOGIN_STUCK_REQUIRED_WINDOWS}×${LOGIN_STUCK_WINDOW_MS / 1000}s`,
    );
    const event = buildEvent(watch, true);
    deps.emit(event);
    if (
      watch.matchedPattern?.kind === 'mcp-auth' &&
      deps.onMcpAuthStuck
    ) {
      try {
        deps.onMcpAuthStuck(event);
      } catch (err) {
        log(
          `[login-stuck] onMcpAuthStuck failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  function clearProgress(watch: WatchedSession): void {
    const wasStuck = watch.stuck;
    watch.matchedPattern = null;
    watch.lastQuietKey = '';
    watch.windowStartedAt = null;
    watch.quietWindows = 0;
    watch.stuck = false;
    if (wasStuck) deps.emit(buildEvent(watch, false));
  }

  const tickSession = (watch: WatchedSession, now: number): void => {
        const tail = deps.readTail(watch.sessionId);
        const pattern = matchPattern(watch.adapterId, tail);
        // Wave-1 hook: real work beats CLI-login heuristics. MCP-auth hangs
        // can keep the semantic status on `working` while the quietKey is
        // frozen (handshake loop), so those patterns are NOT cleared here.
        if (
          pattern?.kind !== 'mcp-auth' &&
          deps.getSemanticStatus(watch.paneId)?.status === 'working'
        ) {
          clearProgress(watch);
          return;
        }
        if (!pattern) {
          // No login/MCP screen in the tail → progress (or never stuck).
          clearProgress(watch);
          return;
        }
        const quietKey = quietKeyOf(tail);
        if (quietKey !== watch.lastQuietKey) {
          // New significant output: re-arm the quiet windows from this screen.
          const wasStuck = watch.stuck;
          watch.lastQuietKey = quietKey;
          watch.matchedPattern = pattern;
          watch.windowStartedAt = null;
          watch.quietWindows = 0;
          watch.stuck = false;
          if (wasStuck) deps.emit(buildEvent(watch, false));
          return;
        }
        // Same screen, no significant new output: accumulate quiet windows.
        if (watch.windowStartedAt === null) {
          watch.windowStartedAt = now;
          watch.matchedPattern = pattern;
          return;
        }
        if (now - watch.windowStartedAt >= LOGIN_STUCK_WINDOW_MS) {
          watch.quietWindows += 1;
          watch.windowStartedAt = now;
          watch.matchedPattern = pattern;
          if (watch.quietWindows >= LOGIN_STUCK_REQUIRED_WINDOWS && !watch.stuck) {
            declareStuck(watch);
          }
        }
  };

  return {
    trackSession(sessionId, paneId, adapterId) {
      const existing = sessions.get(sessionId);
      if (existing?.paneId === paneId && existing.adapterId === adapterId) return true;
      if (existing) sessions.delete(sessionId);
      if (sessions.size >= LOGIN_STUCK_MAX_SESSIONS) {
        log(
          `[login-stuck] cap de ${LOGIN_STUCK_MAX_SESSIONS} sessões atingido; ` +
            `sessão ${sessionId} não será monitorada`,
        );
        return false;
      }
      sessions.set(sessionId, {
        sessionId,
        paneId,
        adapterId,
        matchedPattern: null,
        lastQuietKey: '',
        windowStartedAt: null,
        quietWindows: 0,
        stuck: false,
      });
      return true;
    },

    dropSession(sessionId) {
      sessions.delete(sessionId);
    },

    tick(context) {
      const now = deps.now();
      const snapshot = [...sessions.entries()];
      if (!context) {
        for (const [, watch] of snapshot) tickSession(watch, now);
        return;
      }
      return (async () => {
        for (const [sessionId, watch] of snapshot) {
          await context.checkpoint();
          if (sessions.get(sessionId) !== watch) continue;
          tickSession(watch, now);
        }
      })();
    },

    paneState(paneId) {
      for (const watch of sessions.values()) {
        if (watch.paneId === paneId && watch.stuck) {
          return buildEvent(watch, true);
        }
      }
      return null;
    },

    watchedCount() {
      return sessions.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Production wiring (pty taps + renderer broadcast), bg-task-events pattern.
// ---------------------------------------------------------------------------

const listeners = new Set<(event: PaneLoginStuckEvent) => void>();
const webContents = new Set<WebContents>();
let activeWatchdog: LoginStuckWatchdog | null = null;

/** Main-process tap (tests / future IPC queries). */
export function onPaneLoginStuck(
  cb: (event: PaneLoginStuckEvent) => void,
): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function registerLoginStuckTarget(wc: WebContents): void {
  webContents.add(wc);
}

export function unregisterLoginStuckTarget(wc: WebContents): void {
  webContents.delete(wc);
}

function emitLoginStuck(event: PaneLoginStuckEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.warn('[login-stuck] listener failed:', err);
    }
  }
  for (const wc of webContents) {
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    try {
      wc.send(ORCH_CHANNELS.paneLoginStuck, event);
    } catch {
      // frame disposed
    }
  }
}

/**
 * `canOpenLogin`: the UI may offer "abrir login" only for adapters with an
 * interactive login flow (oauth / device_code / subscription); pure api_key
 * adapters are pointed at Settings › Providers instead. Note: codex, kimi and
 * grok declare api_key (env var works) but ALSO ship an interactive OAuth
 * login (`codex login`, `kimi login`, `grok login`) — the loginHint names it
 * as a backtick-quoted command, which is what we detect here.
 */
function canOpenLogin(adapterId: string): boolean {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty') return false;
  if (adapter.auth.method !== 'api_key' && adapter.auth.method !== 'none') {
    return true;
  }
  return /`[a-z][\w.-]* login`/i.test(adapter.auth.loginHint ?? '');
}

/**
 * Install the watchdog on the orchestration session taps. Called once from
 * the MCP server boot. Returns a disposer (tests / shutdown).
 */
export function installLoginStuckWatchdog(
  options: { readonly autoTick?: boolean } = {},
): () => Promise<void> {
  if (activeWatchdog) return async () => {};
  const controller = new AbortController();
  const mcpAuthHandoffSubmitted = new Set<string>();
  const watchdog = createLoginStuckWatchdog({
    now: () => Date.now(),
    readTail: (sessionId) => readSessionOutput(sessionId, TAIL_LINES),
    getSemanticStatus: (paneId) => getAgentSemanticStatus(paneId),
    canOpenLogin,
    emit: emitLoginStuck,
    onMcpAuthStuck: (event) => {
      // One synthetic handoff per session per stuck episode — declareStuck
      // already fires once, but guard against reinstall / re-emit races.
      if (mcpAuthHandoffSubmitted.has(event.sessionId)) return;
      const pane = getOwnedPaneAuthzInfoBySession(event.sessionId);
      const rendererScope = pane
        ? getRendererWorkspaceScope(pane.owner)
        : null;
      if (
        !pane ||
        pane.sessionId !== event.sessionId ||
        pane.paneId !== event.paneId ||
        pane.kind !== 'cli-agent' ||
        pane.role !== 'worker' ||
        !pane.workerIncarnationId ||
        !pane.missionId ||
        !pane.scope ||
        !rendererScope ||
        !sameProjectScope(rendererScope, pane.scope)
      ) {
        return;
      }
      mcpAuthHandoffSubmitted.add(event.sessionId);
      const handoff = getProjectDomainStores(pane.scope).handoffs.submit({
        status: 'failed',
        summary:
          `watchdog: o worker "${pane.agentName ?? pane.title}" (${pane.paneId}) ` +
          `travou no bootstrap de MCP ("${event.pattern}") sem progresso por ` +
          `${LOGIN_STUCK_REQUIRED_WINDOWS}×${LOGIN_STUCK_WINDOW_MS / 1000}s. ` +
          `Os servidores MCP ambient do perfil do CLI não estão autenticados ` +
          `ou falharam o handshake. Reautentique-os fora da missão, ou rode ` +
          `sem eles — o Nexus já isola MCP ambient em workers Codex gated.`,
        missionId: pane.missionId,
        sessionId: pane.sessionId,
        workerIncarnationId: pane.workerIncarnationId,
        fromAgent: 'nexus-watchdog',
      });
      onHandoffSubmitted(handoff, pane.scope);
      console.warn(
        `[login-stuck] mcp-auth fail-fast handoff: ${pane.paneId} (${event.pattern})`,
      );
    },
  });
  activeWatchdog = watchdog;
  const untapState = tapSessionState((sessionId, state) => {
    if (state !== 'busy') return;
    // Only agent sessions carry an adapter; shell / dumb-terminal panes are
    // never tracked.
    const info = getAgentSessionInfo(sessionId);
    if (!info?.paneId) return;
    watchdog.trackSession(sessionId, info.paneId, info.adapterId);
  });
  const untapExit = tapSessionExit((sessionId) => {
    mcpAuthHandoffSubmitted.delete(sessionId);
    watchdog.dropSession(sessionId);
  });
  const timer = options.autoTick === false
    ? null
    : setInterval(() => {
      void runPeriodicTask('login-stuck:legacy', (context) => watchdog.tick(context),
        { signal: controller.signal, cadenceMs: LOGIN_STUCK_TICK_MS }).catch(() => undefined);
    }, LOGIN_STUCK_TICK_MS);
  timer?.unref?.();
  return async () => {
    controller.abort(new Error('login stuck watcher disposed'));
    untapState();
    untapExit();
    if (timer) clearInterval(timer);
    if (activeWatchdog === watchdog) activeWatchdog = null;
    await stopPeriodicTask('login-stuck:legacy');
  };
}

/** One pass for the main-owned orchestration coordinator. */
export function reconcileLoginStuckWatchdog(context?: PeriodicTaskContext): void | Promise<void> {
  return activeWatchdog?.tick(context);
}

/** Queryable stuck state for a pane (null when fine or not installed). */
export function getLoginStuckPaneState(paneId: string): PaneLoginStuckEvent | null {
  return activeWatchdog?.paneState(paneId) ?? null;
}
