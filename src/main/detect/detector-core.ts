import type { CompiledManifest } from './compiler';
import { evaluateManifest, type DetectedAgentState, type DetectionExplain } from './evaluator';
import { OscTracker } from './osc';
import type { DetectionInput } from './regions';
import { SessionScreenBuffer } from './screen-buffer';
export const PENDING_IDLE_RECHECK_MS = 100;
export const PENDING_IDLE_CONFIRMATIONS = 3;
export const PENDING_IDLE_CAP_MS = 700;
/** Stable visible blocker re-publish cadence (STABLE_VISIBLE_SIGNAL_REFRESH). */
const STABLE_VISIBLE_SIGNAL_REFRESH_MS = 800;
/** Max evaluation rate per session while output streams. */
const EVAL_INTERVAL_MS = 100;
/**
 * F-764 C.3: a avaliação olha só a janela final do buffer (a TELA — o Herdr
 * avalia a grade visível), não os 256 KB de histórico. Cabe com folga um
 * quadro inteiro de terminal grande.
 */
export const DETECTION_WINDOW_CHARS = 32_768;
/** Avaliação acima disto é cara demais para o main: a sessão espera. */
export const EVAL_BUDGET_MS = 25;
/** Espera de uma sessão cuja avaliação estourou o orçamento. */
export const EVAL_SLOW_BACKOFF_MS = 2_000;
/** No máximo um trace `detector-eval-slow` por sessão neste intervalo. */
const EVAL_SLOW_TRACE_INTERVAL_MS = 60_000;

export interface DetectionPublishState {
  state: DetectedAgentState;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
}

/** Port of Herdr's PendingIdleConfirmation (agent_detection.rs:23-78). */
export class PendingIdleConfirmation {
  private startedAt: number | null = null;
  private confirmations = 0;

  active(): boolean {
    return this.startedAt !== null;
  }

  clear(): void {
    this.startedAt = null;
    this.confirmations = 0;
  }

  shouldHoldWorkingToIdle(
    previous: DetectionPublishState,
    next: DetectionPublishState,
    agentChanged: boolean,
    processExited: boolean,
    now: number,
  ): boolean {
    const isWorkingToPlainIdle =
      previous.state === 'working' &&
      next.state === 'idle' &&
      !next.visibleIdle &&
      !next.visibleBlocker &&
      !agentChanged &&
      !processExited;

    if (!isWorkingToPlainIdle) {
      this.clear();
      return false;
    }

    if (this.startedAt === null) {
      this.startedAt = now;
      this.confirmations = 0;
      return true;
    }

    if (now - this.startedAt >= PENDING_IDLE_CAP_MS) {
      this.clear();
      return false;
    }

    this.confirmations += 1;
    if (this.confirmations >= PENDING_IDLE_CONFIRMATIONS) {
      this.clear();
      return false;
    }

    return true;
  }
}

export interface ScreenDetectionRecord {
  sessionId: string;
  paneId?: string;
  adapterId: string;
  manifestId: string;
  manifestVersion: string | null;
  state: DetectedAgentState;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
  matchedRuleId: string | null;
  fallbackReason: string | null;
  at: number;
}

export type ScreenDetectionTap = (record: ScreenDetectionRecord) => void;

interface SessionRuntime {
  adapterId: string | null;
  published: DetectionPublishState;
  pendingIdle: PendingIdleConfirmation;
  lastScannedSeq: number | null;
  lastVisibleSignalRefreshAt: number | null;
  lastEvalAt: number;
  evalTimer: ReturnType<typeof setTimeout> | null;
  pendingRecheckTimer: ReturnType<typeof setTimeout> | null;
  lastExplain: DetectionExplain | null;
  /** Avaliação estourou o orçamento: a próxima só depois disto (F-764). */
  slowUntil: number;
  lastSlowTraceAt: number | null;
}

export interface AgentScreenDetectorDeps {
  manifests: CompiledManifest[];
  beforeEvaluate?: (sessionId: string, manifestId: string) => void;
  afterEvaluate?: () => void;
  diagnostic?: (sessionId: string, adapterId: string, explain: DetectionExplain, state: DetectionPublishState) => void;
  /** Exact PTY-id agent lookup (pty-manager getAgentSessionInfo in prod). */
  getAgentInfo: (
    sessionId: string,
  ) => { adapterId: string; paneId?: string } | null;
  /** Publish sink for accepted transitions (agent-status in prod). */
  publish: (record: ScreenDetectionRecord) => void;
  now: () => number;
  /** Trace persistido do main (`detector-eval-slow`); opcional nos testes. */
  trace?: (event: Record<string, unknown>) => void;
}

/**
 * Manifest registry keyed by lowercase manifest id and every alias, so a
 * Nexus adapter id (`claude`, `codex`, …) resolves directly.
 */
export class ManifestRegistry {
  private readonly byKey = new Map<string, CompiledManifest>();

  constructor(manifests: CompiledManifest[]) {
    for (const compiled of manifests) {
      this.byKey.set(compiled.manifest.id.toLowerCase(), compiled);
      for (const alias of compiled.manifest.aliases) {
        const key = alias.toLowerCase();
        if (!this.byKey.has(key)) this.byKey.set(key, compiled);
      }
    }
  }

  forAdapter(adapterId: string): CompiledManifest | null {
    return this.byKey.get(adapterId.trim().toLowerCase()) ?? null;
  }

  get size(): number {
    return this.byKey.size;
  }
}

export class AgentScreenDetector {
  private readonly registry: ManifestRegistry;
  private readonly buffers = new SessionScreenBuffer();
  private readonly osc = new OscTracker();
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly taps = new Set<ScreenDetectionTap>();

  constructor(private readonly deps: AgentScreenDetectorDeps) {
    this.registry = new ManifestRegistry(deps.manifests);
  }

  tapDetections(cb: ScreenDetectionTap): () => void {
    this.taps.add(cb);
    return () => this.taps.delete(cb);
  }

  /** Raw PTY data tap entry point. */
  onData(sessionId: string, data: string): void {
    this.osc.feed(sessionId, data);
    const seq = this.buffers.append(sessionId, data);
    if (seq === this.runtime(sessionId).lastScannedSeq) return;
    this.scheduleEval(sessionId);
  }

  onExit(sessionId: string): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      if (runtime.evalTimer) clearTimeout(runtime.evalTimer);
      if (runtime.pendingRecheckTimer) clearTimeout(runtime.pendingRecheckTimer);
    }
    this.sessions.delete(sessionId);
    this.buffers.drop(sessionId);
    this.osc.drop(sessionId);
  }

  /** Tail of the buffered stripped screen text; null when nothing buffered. */
  getScreenText(sessionId: string, maxChars = 6_000): string | null {
    const text = this.buffers.text(sessionId);
    if (!text) return null;
    return text.length > maxChars ? text.slice(-maxChars) : text;
  }

  /** Latest accepted record for a session (debug/tooling). */
  lastExplain(sessionId: string): DetectionExplain | null {
    return this.sessions.get(sessionId)?.lastExplain ?? null;
  }

  currentState(sessionId: string): DetectionPublishState | null {
    return this.sessions.get(sessionId)?.published ?? null;
  }

  private runtime(sessionId: string): SessionRuntime {
    let runtime = this.sessions.get(sessionId);
    if (!runtime) {
      runtime = {
        adapterId: null,
        published: {
          state: 'unknown',
          visibleIdle: false,
          visibleBlocker: false,
          visibleWorking: false,
        },
        pendingIdle: new PendingIdleConfirmation(),
        lastScannedSeq: null,
        lastVisibleSignalRefreshAt: null,
        lastEvalAt: 0,
        evalTimer: null,
        pendingRecheckTimer: null,
        lastExplain: null,
        slowUntil: 0,
        lastSlowTraceAt: null,
      };
      this.sessions.set(sessionId, runtime);
    }
    return runtime;
  }

  private scheduleEval(sessionId: string): void {
    const runtime = this.runtime(sessionId);
    if (runtime.evalTimer) return;
    const now = this.deps.now();
    const wait = Math.max(
      0,
      EVAL_INTERVAL_MS - (now - runtime.lastEvalAt),
      runtime.slowUntil - now,
    );
    runtime.evalTimer = setTimeout(() => {
      runtime.evalTimer = null;
      this.evaluateSession(sessionId);
    }, wait);
    runtime.evalTimer.unref?.();
  }

  /**
   * F-764 C.3: manifesto é dado (TOML do Herdr) e pode trazer uma regex cara
   * para tela de TUI. Estourou o orçamento: a sessão só volta a ser avaliada
   * depois do backoff — o texto segue no buffer e a próxima avaliação cobre
   * tudo — e o trace registra qual manifesto, uma vez por minuto por sessão.
   */
  private noteSlowEvaluation(
    sessionId: string,
    runtime: SessionRuntime,
    compiled: CompiledManifest,
    evalMs: number,
    screenChars: number,
    now: number,
  ): void {
    runtime.slowUntil = now + EVAL_SLOW_BACKOFF_MS;
    if (
      runtime.lastSlowTraceAt !== null &&
      now - runtime.lastSlowTraceAt < EVAL_SLOW_TRACE_INTERVAL_MS
    ) {
      return;
    }
    runtime.lastSlowTraceAt = now;
    try {
      this.deps.trace?.({
        kind: 'detector-eval-slow',
        sessionId,
        manifestId: compiled.manifest.id,
        evalMs: Math.round(evalMs),
        screenChars,
        backoffMs: EVAL_SLOW_BACKOFF_MS,
      });
    } catch {
      // Instrumentação nunca derruba a detecção.
    }
  }

  /** One evaluation pass; exported shape kept synchronous for tests. */
  evaluateSession(sessionId: string): ScreenDetectionRecord | null {
    const runtime = this.runtime(sessionId);
    runtime.lastEvalAt = this.deps.now();
    const now = this.deps.now();

    const info = this.deps.getAgentInfo(sessionId);
    if (!info || !info.adapterId) return null;
    const adapterId = info.adapterId.trim().toLowerCase();
    const compiled = this.registry.forAdapter(adapterId);
    if (!compiled) return null;

    const agentChanged =
      runtime.adapterId !== null && runtime.adapterId !== adapterId;
    if (agentChanged) {
      runtime.pendingIdle.clear();
      this.osc.drop(sessionId);
    }
    runtime.adapterId = adapterId;

    // Port of should_skip_idle_screen_scan: an idle pane whose visible
    // content did not move is not re-scanned.
    const contentSeq = this.buffers.contentSeq(sessionId);
    if (
      runtime.published.state === 'idle' &&
      !runtime.pendingIdle.active() &&
      !agentChanged &&
      runtime.lastScannedSeq !== null &&
      runtime.lastScannedSeq === contentSeq
    ) {
      return null;
    }
    runtime.lastScannedSeq = contentSeq;

    const input: DetectionInput = {
      screen: this.buffers.tail(sessionId, DETECTION_WINDOW_CHARS),
      oscTitle: this.osc.title(sessionId),
      oscProgress: this.osc.progress(sessionId),
    };
    const evalStartedAt = performance.now();
    this.deps.beforeEvaluate?.(sessionId, compiled.manifest.id);
    let explain: DetectionExplain;
    try { explain = evaluateManifest(compiled, input); } finally { this.deps.afterEvaluate?.(); }
    const evalMs = performance.now() - evalStartedAt;
    if (evalMs > EVAL_BUDGET_MS) {
      this.noteSlowEvaluation(sessionId, runtime, compiled, evalMs, input.screen.length, now);
    }
    runtime.lastExplain = explain;
    this.deps.diagnostic?.(sessionId, adapterId, explain, runtime.published);
    // detection_update_for_publish: skip_state_update rules never publish.
    if (explain.skipStateUpdate) return null;

    const next: DetectionPublishState = {
      state: explain.state,
      visibleIdle: explain.visibleIdle && explain.state === 'idle',
      visibleBlocker: explain.visibleBlocker && explain.state === 'blocked',
      visibleWorking: explain.visibleWorking && explain.state === 'working',
    };

    if (
      runtime.pendingIdle.shouldHoldWorkingToIdle(
        runtime.published,
        next,
        agentChanged,
        false,
        now,
      )
    ) {
      if (!runtime.pendingRecheckTimer) {
        runtime.pendingRecheckTimer = setTimeout(() => {
          runtime.pendingRecheckTimer = null;
          this.evaluateSession(sessionId);
        }, PENDING_IDLE_RECHECK_MS);
        runtime.pendingRecheckTimer.unref?.();
      }
      return null;
    }

    const stableRefreshDue =
      next.visibleBlocker &&
      runtime.published.visibleBlocker &&
      (runtime.lastVisibleSignalRefreshAt === null ||
        now - runtime.lastVisibleSignalRefreshAt >=
          STABLE_VISIBLE_SIGNAL_REFRESH_MS);

    const shouldPublish =
      next.state !== runtime.published.state ||
      next.visibleIdle !== runtime.published.visibleIdle ||
      next.visibleBlocker !== runtime.published.visibleBlocker ||
      next.visibleWorking !== runtime.published.visibleWorking ||
      agentChanged ||
      stableRefreshDue;
    if (!shouldPublish) return null;

    runtime.published = next;
    if (next.visibleBlocker) runtime.lastVisibleSignalRefreshAt = now;

    const record: ScreenDetectionRecord = {
      sessionId,
      paneId: info.paneId,
      adapterId,
      manifestId: compiled.manifest.id,
      manifestVersion: compiled.manifest.version ?? null,
      state: next.state,
      visibleIdle: next.visibleIdle,
      visibleBlocker: next.visibleBlocker,
      visibleWorking: next.visibleWorking,
      matchedRuleId: explain.matchedRule?.id ?? null,
      fallbackReason: explain.fallbackReason,
      at: now,
    };
    this.deps.publish(record);
    for (const tap of this.taps) {
      try {
        tap(record);
      } catch (err) {
        console.warn('[detect] screen detection tap threw:', err);
      }
    }
    return record;
  }
}

