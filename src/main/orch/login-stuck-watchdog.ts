import type { WebContents } from 'electron';
import {
  getAgentSessionInfo,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import { readSessionOutput } from './pane-registry';
import { getAgentSemanticStatus } from './agent-status';
import { getAdapter } from '../adapters/adapter-registry';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import type { PaneLoginStuckEvent } from '../../shared/types';

/**
 * Login-stuck watchdog (Overclock v1.2 harvest, fix F-256): marker + recheck
 * over the pane output tail. A CLI that falls onto its login screen after
 * spawn ("Select login method", a "Signing in…" spinner that never resolves)
 * otherwise reads as a pane that is busy forever — the mission waits on an
 * agent that will never start.
 *
 * Hard rules:
 *  - NEVER destructive: no kill, no auto-respawn, no input injection. The
 *    watchdog only reports a typed `login-stuck` state (renderer event +
 *    queryable getter + log) so the UI can offer the adapter's login flow.
 *  - Never on the hot path: PTY output is NOT scanned per chunk. Tails are
 *    read (from the ring buffer pane-registry already keeps) once per tick
 *    (5s), only for sessions that transitioned to busy, capped at
 *    LOGIN_STUCK_MAX_SESSIONS.
 *  - Clears on the first sign of progress: new significant output, the
 *    pattern leaving the tail, or the wave-1 semantic hook reporting the
 *    pane as `working` (getAgentSemanticStatus).
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
}

// Curated, deliberately short heuristics: every entry costs one RegExp.test
// per watched session per tick, and a false positive only costs a "login
// stuck?" surface — never a kill. Add a pattern only for a login screen a
// real CLI was seen stuck on; keep them specific (multi-word) to stay clear
// of ordinary agent output.
const STUCK_PATTERNS: StuckPattern[] = [
  // Claude Code OAuth menu shown when no readable session exists.
  { flavor: 'claude', re: /select login method/i, label: 'claude login menu' },
  // Grok's OAuth spinner ("Signing in…") repaints forever on a dead flow.
  { flavor: 'grok', re: /signing in/i, label: 'grok signing-in spinner' },
  // Device-flow prompts that wait for a keypress nobody will send.
  { flavor: '*', re: /press enter to log ?in/i, label: 'press-enter-to-login prompt' },
  // omp waits on its auth broker when no provider credential is wired.
  { flavor: 'omp', re: /auth-broker/i, label: 'omp auth-broker wait' },
  // Codex ChatGPT login screen.
  { flavor: 'codex', re: /sign in with chatgpt/i, label: 'codex ChatGPT login screen' },
  // AGY (Antigravity) Google OAuth screen.
  { flavor: 'agy', re: /sign in with google/i, label: 'agy Google OAuth screen' },
  // Kimi Code login-required screen.
  { flavor: 'kimi', re: /login required/i, label: 'kimi login-required screen' },
  // Generic "waiting for authentication/login" hold screens.
  { flavor: '*', re: /waiting for (authentication|login)/i, label: 'generic auth wait' },
];

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
  tick(): void;
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
      canOpenLogin: deps.canOpenLogin(watch.adapterId),
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
    deps.emit(buildEvent(watch, true));
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

  return {
    trackSession(sessionId, paneId, adapterId) {
      if (sessions.has(sessionId)) return true;
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

    tick() {
      const now = deps.now();
      for (const watch of sessions.values()) {
        // Wave-1 hook integration: hooks reporting real work beat tail
        // heuristics — the agent is progressing, never stuck.
        if (deps.getSemanticStatus(watch.paneId)?.status === 'working') {
          clearProgress(watch);
          continue;
        }
        const tail = deps.readTail(watch.sessionId);
        const pattern = matchPattern(watch.adapterId, tail);
        if (!pattern) {
          // No login screen in the tail → progress (or never stuck).
          clearProgress(watch);
          continue;
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
          continue;
        }
        // Same screen, no significant new output: accumulate quiet windows.
        if (watch.windowStartedAt === null) {
          watch.windowStartedAt = now;
          continue;
        }
        if (now - watch.windowStartedAt >= LOGIN_STUCK_WINDOW_MS) {
          watch.quietWindows += 1;
          watch.windowStartedAt = now;
          if (watch.quietWindows >= LOGIN_STUCK_REQUIRED_WINDOWS && !watch.stuck) {
            declareStuck(watch);
          }
        }
      }
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
 * adapters are pointed at Settings › Providers instead.
 */
function canOpenLogin(adapterId: string): boolean {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty') return false;
  return adapter.auth.method !== 'api_key' && adapter.auth.method !== 'none';
}

/**
 * Install the watchdog on the orchestration session taps. Called once from
 * the MCP server boot. Returns a disposer (tests / shutdown).
 */
export function installLoginStuckWatchdog(): () => void {
  if (activeWatchdog) return () => {};
  const watchdog = createLoginStuckWatchdog({
    now: () => Date.now(),
    readTail: (sessionId) => readSessionOutput(sessionId, TAIL_LINES),
    getSemanticStatus: (paneId) => getAgentSemanticStatus(paneId),
    canOpenLogin,
    emit: emitLoginStuck,
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
  const untapExit = tapSessionExit((sessionId) => watchdog.dropSession(sessionId));
  const timer = setInterval(() => watchdog.tick(), LOGIN_STUCK_TICK_MS);
  timer.unref?.();
  return () => {
    untapState();
    untapExit();
    clearInterval(timer);
    if (activeWatchdog === watchdog) activeWatchdog = null;
  };
}

/** Queryable stuck state for a pane (null when fine or not installed). */
export function getLoginStuckPaneState(paneId: string): PaneLoginStuckEvent | null {
  return activeWatchdog?.paneState(paneId) ?? null;
}
