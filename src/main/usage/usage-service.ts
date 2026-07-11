import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  USAGE_CHANNELS,
  type PaneUsage,
  type UsageSnapshot,
} from '../../shared/usage-types';
import { requireGamificationService } from '../gamification/gamification-service';
import { getContextBySession } from '../orch/gate';
import { getPaneAuthzInfo } from '../orch/pane-registry';
import {
  broadcastToProject,
  sameProjectScope,
} from '../orch/project-scoped-broadcast';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import {
  setResumeSessionLookup,
  setSessionDictationHook,
  type DictatedSessionInfo,
} from '../pty/pty-manager';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ClaudeTranscriptWatcher } from './claude-transcript-watcher';
import type { UsageEvent } from './claude-transcript';
import { CodexUsageScanner } from './codex-scanner';
import {
  configureProjectUsageStoreRegistry,
  disposeProjectUsageStoreRegistry,
  type ProjectUsageStoreSuite,
  type ProjectUsageStoreRegistry,
} from './usage-store-registry';

/**
 * Real usage telemetry routed through immutable project/checkout authority.
 * Process resources live inside this service and each watcher/timer/attribution
 * belongs to exactly one scope. Every snapshot is rebuilt from scoped SQLite.
 */

interface DictatedAttribution {
  ptySessionId: string;
  adapterId: string;
}

interface ScopeTelemetryState {
  readonly scope: ProjectExecutionScope;
  readonly stores: ProjectUsageStoreSuite;
  readonly dictated: Map<string, DictatedAttribution>;
  readonly resumedPaneIds: Map<string, Set<string>>;
  readonly pendingResumePanes: Map<string, number>;
  readonly pendingLaunches: Map<
    string,
    { readonly adapterId: string; readonly startedAt: number }
  >;
  watcher: ClaudeTranscriptWatcher | null;
  broadcastTimer: ReturnType<typeof setTimeout> | null;
}

const SESSION_CLOCK_SKEW_MS = 5 * 60_000;
const SESSION_BIND_WINDOW_MS = 24 * 60 * 60_000;

function scopeKey(scope: ProjectExecutionScope): string {
  return `${scope.projectId}\0${scope.checkoutId}`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function paneUsage(row: ReturnType<ProjectUsageStoreSuite['usage']['totalsByPane']>[number]): PaneUsage {
  return {
    paneId: row.paneId,
    costUsd: row.costUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    turns: row.turns,
    source: 'real',
  };
}

export class UsageTelemetryService {
  readonly #registry: ProjectUsageStoreRegistry;
  readonly #states = new Map<string, ScopeTelemetryState>();
  readonly #rootOwners = new Map<string, string>();
  #codexScanner: CodexUsageScanner | null = null;
  #stopped = false;

  constructor(registry: ProjectUsageStoreRegistry) {
    this.#registry = registry;
  }

  start(): void {
    if (this.#stopped) throw new Error('usage telemetry service is stopped');
    setSessionDictationHook((info) => this.#onSessionDictated(info));
    setResumeSessionLookup((scope, paneId, adapterId) =>
      this.#resumeSessionForPane(scope, paneId, adapterId),
    );
  }

  snapshot(scope: ProjectExecutionScope): UsageSnapshot {
    const state = this.#ensureScope(scope);
    const global = state.stores.usage.totals();
    const byPane = Object.fromEntries(
      state.stores.usage
        .totalsByPane()
        .map((row) => [row.paneId, paneUsage(row)]),
    );
    return {
      byPane,
      global: {
        costUsd: global.costUsd,
        inputTokens: global.inputTokens,
        outputTokens: global.outputTokens,
        turns: global.turns,
      },
      media: state.stores.media.totals(),
    };
  }

  notifyMediaGenerated(scope: ProjectExecutionScope): void {
    this.#scheduleBroadcast(this.#ensureScope(scope));
  }

  #watchProvider(
    scope: ProjectExecutionScope,
    provider: 'claude' | 'codex',
  ): void {
    const state = this.#ensureScope(scope);
    if (provider === 'claude' && !state.watcher) {
      const watcher = new ClaudeTranscriptWatcher({
        workspacePath: state.scope.rootRealPath,
        onEvent: (event) => this.#onClaudeEvent(state, event),
      });
      watcher.start();
      state.watcher = watcher;
    }
    if (provider === 'codex') this.#ensureCodexScanner();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    setSessionDictationHook(null);
    setResumeSessionLookup(null);
    for (const state of this.#states.values()) {
      state.watcher?.stop();
      state.watcher = null;
      if (state.broadcastTimer) clearTimeout(state.broadcastTimer);
      state.broadcastTimer = null;
      state.dictated.clear();
      state.resumedPaneIds.clear();
      state.pendingResumePanes.clear();
      state.pendingLaunches.clear();
    }
    this.#states.clear();
    this.#rootOwners.clear();
    this.#codexScanner?.stop();
    this.#codexScanner = null;
  }

  #ensureScope(scope: ProjectExecutionScope): ScopeTelemetryState {
    if (this.#stopped) throw new Error('usage telemetry service is stopped');
    const key = scopeKey(scope);
    const existing = this.#states.get(key);
    if (existing) {
      if (!sameProjectScope(existing.scope, scope)) {
        throw new Error('usage telemetry scope identity collision');
      }
      return existing;
    }
    const root = fs.realpathSync(scope.rootRealPath);
    if (root !== scope.rootRealPath) {
      throw new Error('usage telemetry project root identity changed');
    }
    const rootOwner = this.#rootOwners.get(root);
    if (rootOwner && rootOwner !== key) {
      throw new Error('one checkout path resolved to multiple project scopes');
    }
    const immutableScope = Object.freeze({ ...scope });
    const state: ScopeTelemetryState = {
      scope: immutableScope,
      stores: this.#registry.forScope(immutableScope),
      dictated: new Map(),
      resumedPaneIds: new Map(),
      pendingResumePanes: new Map(),
      pendingLaunches: new Map(),
      watcher: null,
      broadcastTimer: null,
    };
    this.#states.set(key, state);
    this.#rootOwners.set(root, key);
    return state;
  }

  #onSessionDictated(info: DictatedSessionInfo): void {
    if (info.adapterId !== 'claude' && info.adapterId !== 'codex') return;
    const ctx = getContextBySession(info.ptySessionId);
    if (!ctx) {
      console.warn('[usage] agent session has no bound project authority');
      return;
    }
    const state = this.#ensureScope(ctx.scope);
    const cwd = fs.realpathSync(info.cwd);
    if (!isInside(state.scope.rootRealPath, cwd)) {
      throw new Error('dictated session cwd escapes its project scope');
    }
    if (info.providerSessionId) {
      const existing = state.dictated.get(info.providerSessionId);
      if (existing && existing.ptySessionId !== info.ptySessionId) {
        throw new Error('provider session is attributed to multiple PTYs');
      }
      state.dictated.set(info.providerSessionId, {
        ptySessionId: info.ptySessionId,
        adapterId: info.adapterId,
      });
    } else {
      state.pendingLaunches.set(info.ptySessionId, {
        adapterId: info.adapterId,
        startedAt: Date.now(),
      });
    }
    this.#watchProvider(state.scope, info.adapterId);
  }

  #resumeSessionForPane(
    scope: ProjectExecutionScope,
    paneId: string,
    adapterId: string,
  ): string | null {
    if (adapterId !== 'claude' && adapterId !== 'codex') return null;
    const state = this.#ensureScope(scope);
    const captured = state.stores.usage.latestProviderSessionByPane(paneId);
    if (!captured) return null;
    if (captured.provider !== adapterId) return null;
    state.pendingResumePanes.set(paneId, Date.now());
    const paneIds = state.resumedPaneIds.get(captured.sessionId) ?? new Set();
    paneIds.add(paneId);
    state.resumedPaneIds.set(captured.sessionId, paneIds);
    this.#watchProvider(scope, adapterId);
    return captured.sessionId;
  }

  #onClaudeEvent(state: ScopeTelemetryState, event: UsageEvent): void {
    if (!this.#acceptProviderEvent(state, 'claude', event)) return;
    const attribution = this.#attributionForEvent(state, event.sessionId);
    state.stores.usage.record('claude', {
      ...event,
      paneId: attribution?.paneId ?? null,
      missionId: attribution?.missionId ?? null,
    });
    this.#awardAgentTurn(state, 'claude', event);
    this.#scheduleBroadcast(state);
  }

  #onCodexEvent(state: ScopeTelemetryState, event: UsageEvent): void {
    if (!this.#acceptProviderEvent(state, 'codex', event)) return;
    const attribution = this.#attributionForEvent(state, event.sessionId);
    state.stores.usage.record('codex', {
      ...event,
      paneId: attribution?.paneId ?? null,
      missionId: attribution?.missionId ?? null,
    });
    this.#awardAgentTurn(state, 'codex', event);
    this.#scheduleBroadcast(state);
  }

  /**
   * Concede XP de gamificação por um turno de agente que entregou saída real.
   * Gate em outputTokens > 0 (turno vazio/erro não pontua) e à prova de falhas:
   * se o serviço não estiver configurado (boot/testes) ou a gravação falhar, a
   * telemetria de uso NÃO pode quebrar.
   */
  #awardAgentTurn(
    state: ScopeTelemetryState,
    provider: 'claude' | 'codex',
    event: UsageEvent,
  ): void {
    if (!(event.outputTokens > 0)) return;
    try {
      requireGamificationService().recordAgentTurn(state.scope, provider);
    } catch {
      // Serviço ausente ou falha de gravação — nunca propaga para a telemetria.
    }
  }

  #attributionForEvent(
    state: ScopeTelemetryState,
    providerSessionId: string,
  ): { paneId: string; missionId: string | null } | null {
    const dictated = state.dictated.get(providerSessionId);
    let paneId: string | null = null;
    if (dictated) {
      paneId = getPaneAuthzInfo(dictated.ptySessionId)?.paneId ?? null;
    } else {
      const resumed = state.resumedPaneIds.get(providerSessionId);
      if (resumed?.size === 1) paneId = [...resumed][0];
    }
    if (!paneId) return null;
    const pane = getPaneAuthzInfo(paneId);
    if (!pane?.scope || !sameProjectScope(pane.scope, state.scope)) {
      return null;
    }
    return { paneId, missionId: pane.missionId ?? null };
  }

  /**
   * Provider transcript locations are path-based and can outlive a checkout.
   * Accept only sessions already proven in this scoped DB, explicitly dictated
   * by this process, or freshly observed after a scoped launch/resume.
   */
  #acceptProviderEvent(
    state: ScopeTelemetryState,
    provider: 'claude' | 'codex',
    event: UsageEvent,
  ): boolean {
    const dictated = state.dictated.get(event.sessionId);
    if (
      dictated?.adapterId === provider ||
      state.stores.usage.hasProviderSession(provider, event.sessionId)
    ) {
      return true;
    }
    const timestamp = event.timestamp;
    const now = Date.now();
    if (timestamp === null || timestamp > now + SESSION_CLOCK_SKEW_MS) {
      return false;
    }

    const candidatePaneIds = new Set<string>();
    const recentResumePanes = new Set<string>();
    for (const [paneId, startedAt] of state.pendingResumePanes) {
      if (
        now - startedAt <= SESSION_BIND_WINDOW_MS &&
        timestamp >= startedAt - SESSION_CLOCK_SKEW_MS
      ) {
        recentResumePanes.add(paneId);
        candidatePaneIds.add(paneId);
      } else if (now - startedAt > SESSION_BIND_WINDOW_MS) {
        state.pendingResumePanes.delete(paneId);
      }
    }
    const recentLaunches = new Set<string>();
    for (const [ptySessionId, launch] of state.pendingLaunches) {
      if (
        launch.adapterId !== provider ||
        timestamp < launch.startedAt - SESSION_CLOCK_SKEW_MS ||
        now - launch.startedAt > SESSION_BIND_WINDOW_MS
      ) {
        if (now - launch.startedAt > SESSION_BIND_WINDOW_MS) {
          state.pendingLaunches.delete(ptySessionId);
        }
        continue;
      }
      recentLaunches.add(ptySessionId);
      const pane = getPaneAuthzInfo(ptySessionId);
      if (pane?.scope && sameProjectScope(pane.scope, state.scope)) {
        candidatePaneIds.add(pane.paneId);
      }
    }
    if (recentResumePanes.size === 0 && recentLaunches.size === 0) return false;
    if (candidatePaneIds.size === 1) {
      state.resumedPaneIds.set(event.sessionId, candidatePaneIds);
    }
    for (const paneId of recentResumePanes) {
      state.pendingResumePanes.delete(paneId);
    }
    for (const ptySessionId of recentLaunches) {
      state.pendingLaunches.delete(ptySessionId);
    }
    return true;
  }

  #ensureCodexScanner(): void {
    if (this.#codexScanner) return;
    this.#codexScanner = new CodexUsageScanner({
      isWatched: (cwd) => this.#scopeForCwd(cwd) !== null,
      onEvent: (event, cwd) => {
        const state = this.#scopeForCwd(cwd);
        if (!state) return;
        this.#onCodexEvent(state, event);
      },
    });
    this.#codexScanner.start();
  }

  #scopeForCwd(cwd: string): ScopeTelemetryState | null {
    let real: string;
    try {
      real = fs.realpathSync(cwd);
    } catch {
      return null;
    }
    const matches = [...this.#states.values()].filter((state) =>
      isInside(state.scope.rootRealPath, real),
    );
    if (matches.length === 0) return null;
    matches.sort(
      (left, right) =>
        right.scope.rootRealPath.length - left.scope.rootRealPath.length,
    );
    if (
      matches.length > 1 &&
      matches[0].scope.rootRealPath.length ===
        matches[1].scope.rootRealPath.length
    ) {
      return null;
    }
    return matches[0];
  }

  #scheduleBroadcast(state: ScopeTelemetryState): void {
    if (state.broadcastTimer) return;
    state.broadcastTimer = setTimeout(() => {
      state.broadcastTimer = null;
      const snapshot = this.snapshot(state.scope);
      broadcastToProject(
        BrowserWindow.getAllWindows().map((window) => window.webContents),
        state.scope,
        USAGE_CHANNELS.changed,
        snapshot,
      );
    }, 1_000);
    state.broadcastTimer.unref?.();
  }
}

let configuredService: UsageTelemetryService | null = null;

export function initUsageTelemetry(
  runtimeManager: ProjectRuntimeManager,
): UsageTelemetryService {
  configuredService?.stop();
  const registry = configureProjectUsageStoreRegistry(runtimeManager);
  configuredService = new UsageTelemetryService(registry);
  configuredService.start();
  ipcMain.removeHandler(USAGE_CHANNELS.snapshot);
  ipcMain.handle(USAGE_CHANNELS.snapshot, (event): UsageSnapshot => {
    return configuredService!.snapshot(
      requireRendererWorkspaceScope(event.sender),
    );
  });
  return configuredService;
}

export function notifyMediaGenerated(scope: ProjectExecutionScope): void {
  if (!configuredService) {
    throw new Error('project-scoped usage telemetry is not initialized');
  }
  configuredService.notifyMediaGenerated(scope);
}

export function shutdownUsageTelemetry(): void {
  ipcMain.removeHandler(USAGE_CHANNELS.snapshot);
  configuredService?.stop();
  configuredService = null;
  disposeProjectUsageStoreRegistry();
}
