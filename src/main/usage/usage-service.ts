import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  USAGE_CHANNELS,
  type AccountUsage,
  type PaneUsage,
  type UsageSnapshot,
} from '../../shared/usage-types';
import { requireGamificationService } from '../gamification/gamification-service';
import {
  executionScopeFor,
  getContextBySession,
  type AgentGateContext,
} from '../orch/gate';
import { getPaneAuthzInfo } from '../orch/pane-registry';
import { recordTokenSpeedUsage } from '../orch/token-speed-tracker';
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
import {
  getProviderPaneSession,
  saveProviderPaneSession,
} from '../persistence/provider-session-store';
import { ClaudeTranscriptWatcher } from './claude-transcript-watcher';
import { MimoUsageScanner, type MimoSessionBinding } from './mimo-scanner';
import { tapMimoSessionBindings } from '../agent-hooks/mimo-session-registry';
import type { UsageRecord } from './usage-store';
import type { UsageEvent } from './claude-transcript';
import {
  CodexUsageScanner,
  type CodexRolloutSource,
} from './codex-scanner';
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
  paneId: string;
  executionRoot: string;
  accountId?: string;
}

interface ScopeTelemetryState {
  readonly scope: ProjectExecutionScope;
  readonly stores: ProjectUsageStoreSuite;
  /** Main-authorized isolated checkouts observed for live agent sessions. */
  readonly executionRoots: Set<string>;
  readonly dictated: Map<string, DictatedAttribution>;
  readonly resumedSessions: Map<
    string,
    {
      readonly adapterId: string;
      readonly paneIds: Set<string>;
      readonly executionRoots: Set<string>;
    }
  >;
  readonly accountIdByProviderSession: Map<string, string>;
  readonly pendingLaunches: Map<
    string,
    {
      readonly adapterId: string;
      readonly startedAt: number;
      readonly executionRoot: string;
    }
  >;
  watcher: ClaudeTranscriptWatcher | null;
  broadcastTimer: ReturnType<typeof setTimeout> | null;
}

const SESSION_CLOCK_SKEW_MS = 5 * 60_000;
const SESSION_BIND_WINDOW_MS = 24 * 60 * 60_000;
const CODEX_ROLLOUT_SPAWN_SKEW_MS = 30_000;
const CODEX_ROLLOUT_START_WINDOW_MS = 5 * 60_000;

function scopeKey(scope: ProjectExecutionScope): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
  ].join('\0');
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

function isPhysicalRootAuthorized(
  configuredRoot: string,
  observedRoot: string,
): boolean {
  try {
    const physicalRoot = fs.realpathSync(configuredRoot);
    return (
      physicalRoot === configuredRoot &&
      isInside(physicalRoot, observedRoot)
    );
  } catch {
    return false;
  }
}

export function isUsageCwdAuthorized(
  ctx: Pick<AgentGateContext, 'scope' | 'executionScope'>,
  cwd: string,
): boolean {
  return isInside(executionScopeFor(ctx).rootRealPath, cwd);
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

function accountUsage(
  row: ReturnType<ProjectUsageStoreSuite['usage']['totalsByAccount']>[number],
): AccountUsage {
  return {
    accountId: row.accountId,
    provider: row.provider,
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
  #mimoScanner: MimoUsageScanner | null = null;
  #stopMimoBindings: (() => void) | null = null;
  #stopped = false;

  constructor(registry: ProjectUsageStoreRegistry) {
    this.#registry = registry;
  }

  start(): void {
    if (this.#stopped) throw new Error('usage telemetry service is stopped');
    setSessionDictationHook((info) => this.#onSessionDictated(info));
    if (!this.#mimoScanner) {
      this.#mimoScanner = new MimoUsageScanner((binding, event) => this.#onMimoEvent(binding, event));
      this.#stopMimoBindings = tapMimoSessionBindings((id, binding) => {
        if (binding) this.#mimoScanner?.bind(binding);
        else this.#mimoScanner?.remove(id);
      });
      this.#mimoScanner.start();
    }
    // O lookup só existe para acrescentar `--resume <id>` ao spawn. Falhar aqui
    // não é motivo para matar o pane: sem id o pane nasce com sessão nova, que
    // é o resultado estritamente MAIS restrito. Uma exceção vazando daqui
    // atravessava o pty-manager e virava
    // `[nexus] falha ao iniciar o processo: usage telemetry scope identity
    // collision` — telemetria abortando o nascimento do processo.
    setResumeSessionLookup((scope, paneId, adapterId, accountId) => {
      try {
        return this.#resumeSessionForPane(scope, paneId, adapterId, accountId);
      } catch (error) {
        console.warn(
          '[usage] resume lookup indisponível; pane nasce com sessão nova',
          JSON.stringify({
            paneId,
            adapterId,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
        return null;
      }
    });
  }

  snapshot(scope: ProjectExecutionScope): UsageSnapshot | null {
    try {
      const state = this.#ensureScope(scope);
      const global = state.stores.usage.totals();
      const byPane = Object.fromEntries(
        state.stores.usage
          .totalsByPane()
          .map((row) => [row.paneId, paneUsage(row)]),
      );
      const byAccount = Object.fromEntries(
        state.stores.usage
          .totalsByAccount()
          .map((row) => [row.accountId, accountUsage(row)]),
      );
      return {
        byPane,
        byAccount,
        global: {
          costUsd: global.costUsd,
          inputTokens: global.inputTokens,
          outputTokens: global.outputTokens,
          turns: global.turns,
        },
        media: state.stores.media.totals(),
      };
    } catch (error) {
      console.warn(
        '[usage] snapshot failed; skipping telemetry broadcast',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  notifyMediaGenerated(scope: ProjectExecutionScope): void {
    try {
      this.#scheduleBroadcast(this.#ensureScope(scope));
    } catch (error) {
      console.warn(
        '[usage] notifyMediaGenerated failed; skipping telemetry broadcast',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #watchProvider(
    scope: ProjectExecutionScope,
    provider: 'claude' | 'codex',
  ): void {
    const state = this.#ensureScope(scope);
    if (provider === 'claude' && !state.watcher) {
      const watcher = new ClaudeTranscriptWatcher({
        workspacePath: state.scope.rootRealPath,
        workspacePaths: () => state.executionRoots,
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
      state.executionRoots.clear();
      state.dictated.clear();
      state.resumedSessions.clear();
      state.accountIdByProviderSession.clear();
      state.pendingLaunches.clear();
    }
    this.#states.clear();
    this.#rootOwners.clear();
    this.#codexScanner?.stop();
    this.#codexScanner = null;
    this.#stopMimoBindings?.();
    this.#stopMimoBindings = null;
    this.#mimoScanner?.stop();
    this.#mimoScanner = null;
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
      executionRoots: new Set([immutableScope.rootRealPath]),
      dictated: new Map(),
      resumedSessions: new Map(),
      accountIdByProviderSession: new Map(),
      pendingLaunches: new Map(),
      watcher: null,
      broadcastTimer: null,
    };
    this.#states.set(key, state);
    this.#rootOwners.set(root, key);
    return state;
  }

  #registerExecutionRoot(
    state: ScopeTelemetryState,
    executionRoot: string,
  ): void {
    const key = scopeKey(state.scope);
    const rootOwner = this.#rootOwners.get(executionRoot);
    if (rootOwner && rootOwner !== key) {
      throw new Error(
        'one execution root resolved to multiple project scopes',
      );
    }
    this.#rootOwners.set(executionRoot, key);
    state.executionRoots.add(executionRoot);
  }

  #onSessionDictated(info: DictatedSessionInfo): void {
    if (info.adapterId !== 'claude' && info.adapterId !== 'codex') return;
    const ctx = getContextBySession(info.ptySessionId);
    if (!ctx) {
      console.warn('[usage] agent session has no bound project authority');
      return;
    }
    let state: ScopeTelemetryState;
    try {
      state = this.#ensureScope(ctx.scope);
    } catch (error) {
      console.warn(
        '[usage] dictated session scope rejected; skipping telemetry attribution',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const cwd = fs.realpathSync(info.cwd);
    const executionRoot = fs.realpathSync(
      executionScopeFor(ctx).rootRealPath,
    );
    if (
      executionRoot !== executionScopeFor(ctx).rootRealPath ||
      !isUsageCwdAuthorized(ctx, cwd)
    ) {
      throw new Error('dictated session cwd escapes its execution scope');
    }
    this.#registerExecutionRoot(state, executionRoot);
    if (info.providerSessionId && info.paneId) {
      saveProviderPaneSession(
        state.scope,
        info.paneId,
        info.adapterId,
        {
          key: 'session_id',
          id: info.providerSessionId,
        },
        info.accountId,
      );
      const existing = state.dictated.get(info.providerSessionId);
      if (existing && existing.ptySessionId !== info.ptySessionId) {
        throw new Error('provider session is attributed to multiple PTYs');
      }
      state.dictated.set(info.providerSessionId, {
        ptySessionId: info.ptySessionId,
        adapterId: info.adapterId,
        paneId: info.paneId,
        executionRoot,
        ...(info.accountId ? { accountId: info.accountId } : {}),
      });
      if (info.accountId) {
        state.accountIdByProviderSession.set(
          info.providerSessionId,
          info.accountId,
        );
      }
    } else {
      state.pendingLaunches.set(info.ptySessionId, {
        adapterId: info.adapterId,
        startedAt: Date.now(),
        executionRoot,
      });
    }
    this.#watchProvider(state.scope, info.adapterId);
  }

  #resumeSessionForPane(
    scope: ProjectExecutionScope,
    paneId: string,
    adapterId: string,
    accountId?: string,
  ): string | null {
    const state = this.#ensureScope(scope);
    // Exact resume is account-bound. When accountId is set, SQLite row must match.
    const persisted = getProviderPaneSession(
      scope,
      paneId,
      adapterId,
      accountId,
    );
    if (persisted) {
      const executionRoot = this.#registerResumePaneRoot(state, paneId);
      if (!executionRoot) return null;
      const existing = state.resumedSessions.get(persisted.id);
      if (existing && existing.adapterId !== adapterId) {
        throw new Error('provider session resume changed adapter identity');
      }
      const paneIds = existing?.paneIds ?? new Set<string>();
      const executionRoots =
        existing?.executionRoots ?? new Set<string>();
      paneIds.add(paneId);
      executionRoots.add(executionRoot);
      state.resumedSessions.set(persisted.id, {
        adapterId,
        paneIds,
        executionRoots,
      });
      if (accountId) {
        state.accountIdByProviderSession.set(persisted.id, accountId);
      }
      if (adapterId === 'claude' || adapterId === 'codex') {
        this.#watchProvider(scope, adapterId);
      }
      return persisted.id;
    }
    // Telemetry fallback also skips when we have an explicit account pin:
    // in-memory latest session has no account ownership metadata.
    if (accountId) return null;
    if (adapterId !== 'claude' && adapterId !== 'codex') return null;
    const captured = state.stores.usage.latestProviderSessionByPane(paneId);
    if (!captured) return null;
    if (captured.provider !== adapterId) return null;
    const executionRoot = this.#registerResumePaneRoot(state, paneId);
    if (!executionRoot) return null;
    const existing = state.resumedSessions.get(captured.sessionId);
    if (existing && existing.adapterId !== adapterId) {
      throw new Error('provider session resume changed adapter identity');
    }
    const paneIds = existing?.paneIds ?? new Set<string>();
    const executionRoots = existing?.executionRoots ?? new Set<string>();
    paneIds.add(paneId);
    executionRoots.add(executionRoot);
    state.resumedSessions.set(captured.sessionId, {
      adapterId,
      paneIds,
      executionRoots,
    });
    if (captured.accountId) {
      state.accountIdByProviderSession.set(captured.sessionId, captured.accountId);
    }
    this.#watchProvider(scope, adapterId);
    return captured.sessionId;
  }

  #registerResumePaneRoot(
    state: ScopeTelemetryState,
    paneId: string,
  ): string | null {
    const pane = getPaneAuthzInfo(paneId);
    if (!pane?.scope || !sameProjectScope(pane.scope, state.scope)) {
      return null;
    }
    const configuredRoot =
      pane.executionScope?.rootRealPath ?? pane.scope.rootRealPath;
    let executionRoot: string;
    try {
      executionRoot = fs.realpathSync(configuredRoot);
    } catch {
      return null;
    }
    if (executionRoot !== configuredRoot) return null;
    this.#registerExecutionRoot(state, executionRoot);
    return executionRoot;
  }

  #onMimoEvent(binding: MimoSessionBinding, event: UsageRecord): void {
    const state = this.#ensureScope(binding.scope);
    state.stores.usage.record('mimo-code', {
      ...event, paneId: binding.paneId, accountId: binding.accountId ?? null,
      missionId: binding.missionId ?? null,
    });
    this.#feedTokenSpeed('mimo-code', event, binding.paneId);
    this.#scheduleBroadcast(state);
  }

  #onClaudeEvent(state: ScopeTelemetryState, event: UsageEvent): void {
    if (!this.#acceptProviderEvent(state, 'claude', event)) return;
    const attribution = this.#attributionForEvent(
      state,
      'claude',
      event.sessionId,
    );
    const isNew = state.stores.usage.record('claude', {
      ...event,
      paneId: attribution?.paneId ?? null,
      missionId: attribution?.missionId ?? null,
      accountId: attribution?.accountId ?? null,
    });
    if (isNew) this.#awardAgentTurn(state, 'claude', event);
    this.#feedTokenSpeed('claude', event, attribution?.paneId ?? null);
    this.#scheduleBroadcast(state);
  }

  #onCodexEvent(
    state: ScopeTelemetryState,
    event: UsageEvent,
    observedCwd: string,
    source: CodexRolloutSource,
  ): void {
    if (
      source.providerSessionId !== event.sessionId ||
      !source.rolloutSessionId ||
      source.rolloutSessionId !== source.threadId
    ) {
      return;
    }
    let observedRoot: string;
    try {
      observedRoot = fs.realpathSync(observedCwd);
    } catch {
      return;
    }
    if (
      !this.#acceptProviderEvent(
        state,
        'codex',
        event,
        observedRoot,
        source,
      )
    ) {
      return;
    }
    const attribution = this.#attributionForEvent(
      state,
      'codex',
      event.sessionId,
    );
    const isNew = state.stores.usage.record('codex', {
      ...event,
      paneId: attribution?.paneId ?? null,
      missionId: attribution?.missionId ?? null,
      accountId: attribution?.accountId ?? null,
    });
    if (isNew) this.#awardAgentTurn(state, 'codex', event);
    this.#feedTokenSpeed('codex', event, attribution?.paneId ?? null);
    this.#scheduleBroadcast(state);
  }

  /**
   * Corrige a amostra de velocidade do pane com a contagem EXATA do
   * transcript. A chave carrega o messageId porque o provider reescreve a
   * mesma mensagem enquanto ela transmite — a correção precisa atualizar a
   * amostra existente, não criar outra.
   *
   * À prova de falhas: cronômetro é acessório; ele não pode derrubar a
   * telemetria de uso nem a UI de custo/quota.
   */
  #feedTokenSpeed(
    provider: string,
    event: UsageEvent,
    paneId: string | null,
  ): void {
    if (!paneId || event.outputTokens <= 0) return;
    try {
      recordTokenSpeedUsage(paneId, {
        key: `${provider}:${event.sessionId}:${event.messageId ?? event.timestamp ?? 'sem-id'}`,
        outputTokens: event.outputTokens,
        model: event.model,
        timestamp: event.timestamp,
      });
    } catch (error) {
      console.warn('[usage] token speed correction failed:', error);
    }
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
    provider: 'claude' | 'codex',
    providerSessionId: string,
  ): { paneId: string | null; missionId: string | null; accountId: string | null } | null {
    const dictated = state.dictated.get(providerSessionId);
    const accountId =
      dictated?.accountId ??
      state.accountIdByProviderSession.get(providerSessionId) ??
      state.stores.usage.accountIdForProviderSession(
        provider,
        providerSessionId,
      );
    let paneId: string | null = null;
    if (dictated) {
      // The pane registry is renderer-lifecycle state and can disappear during
      // a reload before a provider transcript is observed. The spawn hook is
      // already scoped/trusted, so retain its stable pane id directly.
      paneId = dictated.paneId;
    } else {
      const resumed = state.resumedSessions.get(providerSessionId);
      if (resumed?.adapterId === provider && resumed.paneIds.size === 1) {
        paneId = [...resumed.paneIds][0];
      }
    }
    if (!paneId) {
      return accountId
        ? { paneId: null, missionId: null, accountId }
        : null;
    }
    const pane = getPaneAuthzInfo(paneId);
    if (pane?.scope && !sameProjectScope(pane.scope, state.scope)) return null;
    return { paneId, missionId: pane?.missionId ?? null, accountId };
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
    observedCwd?: string,
    codexSource?: CodexRolloutSource,
  ): boolean {
    const dictated = state.dictated.get(event.sessionId);
    if (dictated?.adapterId === provider) {
      if (provider !== 'codex') return true;
      return Boolean(
        observedCwd &&
          isPhysicalRootAuthorized(
            dictated.executionRoot,
            observedCwd,
          ),
      );
    }

    const resumed = state.resumedSessions.get(event.sessionId);
    if (resumed?.adapterId === provider && resumed.paneIds.size === 1) {
      if (provider !== 'codex') return true;
      if (!observedCwd || resumed.executionRoots.size !== 1) return false;
      return isPhysicalRootAuthorized(
        [...resumed.executionRoots][0],
        observedCwd,
      );
    }

    if (provider === 'codex') {
      const authority = state.stores.usage.codexSessionAuthority(
        event.sessionId,
      );
      if (authority) {
        if (
          !observedCwd ||
          !isPhysicalRootAuthorized(
            authority.executionRoot,
            observedCwd,
          )
        ) {
          return false;
        }
        if (authority.paneId) {
          state.resumedSessions.set(event.sessionId, {
            adapterId: provider,
            paneIds: new Set([authority.paneId]),
            executionRoots: new Set([authority.executionRoot]),
          });
        }
        return true;
      }
      if (state.stores.usage.hasProviderSession(provider, event.sessionId)) {
        return false;
      }
    } else if (
      state.stores.usage.hasProviderSession(provider, event.sessionId)
    ) {
      return true;
    }

    const timestamp = event.timestamp;
    const now = Date.now();
    if (timestamp === null || timestamp > now + SESSION_CLOCK_SKEW_MS) {
      return false;
    }

    const observedRoot = provider === 'codex' ? observedCwd ?? null : null;
    const candidatePaneIds = new Set<string>();
    const candidateExecutionRoots = new Set<string>();
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
      if (
        provider === 'codex' &&
        (!observedRoot ||
          !isInside(launch.executionRoot, observedRoot) ||
          codexSource?.providerSessionId !== event.sessionId ||
          codexSource.threadId !== codexSource.providerSessionId ||
          codexSource.rolloutSessionId !== codexSource.threadId ||
          codexSource.sessionStartedAt === null ||
          codexSource.sessionStartedAt <
            launch.startedAt - CODEX_ROLLOUT_SPAWN_SKEW_MS ||
          codexSource.sessionStartedAt >
            launch.startedAt + CODEX_ROLLOUT_START_WINDOW_MS)
      ) {
        continue;
      }
      const pane = getPaneAuthzInfo(ptySessionId);
      if (!pane?.scope || !sameProjectScope(pane.scope, state.scope)) continue;
      const authorizedRoot =
        pane.executionScope?.rootRealPath ?? pane.scope.rootRealPath;
      if (authorizedRoot !== launch.executionRoot) continue;
      recentLaunches.add(ptySessionId);
      candidatePaneIds.add(pane.paneId);
      candidateExecutionRoots.add(launch.executionRoot);
    }
    if (recentLaunches.size === 0) return false;
    if (
      candidatePaneIds.size !== 1 ||
      candidateExecutionRoots.size !== 1
    ) {
      return false;
    }
    state.resumedSessions.set(event.sessionId, {
      adapterId: provider,
      paneIds: candidatePaneIds,
      executionRoots: candidateExecutionRoots,
    });
    for (const ptySessionId of recentLaunches) {
      state.pendingLaunches.delete(ptySessionId);
    }
    return true;
  }

  #ensureCodexScanner(): void {
    if (this.#codexScanner) return;
    this.#codexScanner = new CodexUsageScanner({
      isWatched: (cwd) => this.#scopeForCwd(cwd) !== null,
      onEvent: (event, cwd, source) => {
        // Fresh Codex sessions are main-dictated before their transcript is
        // scanned. Prefer that exact provider-session binding: isolated task
        // worktrees intentionally live outside the coordination checkout and
        // therefore cannot be attributed safely from cwd alone.
        const exact = [...this.#states.values()].filter(
          (candidate) => {
            if (
              candidate.dictated.get(event.sessionId)?.adapterId === 'codex'
            ) {
              return true;
            }
            const resumed = candidate.resumedSessions.get(event.sessionId);
            return (
              resumed?.adapterId === 'codex' &&
              resumed.paneIds.size === 1 &&
              resumed.executionRoots.size === 1
            );
          },
        );
        const state =
          exact.length === 1 ? exact[0] : this.#scopeForCwd(cwd);
        if (!state) return;
        this.#onCodexEvent(state, event, cwd, source);
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
    const matches = [...this.#states.values()].flatMap((state) =>
      [...state.executionRoots]
        .filter((root) => isInside(root, real))
        .map((root) => ({ state, root })),
    );
    if (matches.length === 0) return null;
    matches.sort(
      (left, right) =>
        right.root.length - left.root.length,
    );
    if (
      matches.length > 1 &&
      matches[0].root.length === matches[1].root.length &&
      matches[0].state !== matches[1].state
    ) {
      return null;
    }
    return matches[0].state;
  }

  #scheduleBroadcast(state: ScopeTelemetryState): void {
    if (state.broadcastTimer) return;
    state.broadcastTimer = setTimeout(() => {
      state.broadcastTimer = null;
      const snapshot = this.snapshot(state.scope);
      if (!snapshot) return;
      for (const listener of usageSnapshotListeners) {
        try {
          listener(state.scope, snapshot);
        } catch (error) {
          console.warn('[usage] snapshot tap falhou:', error);
        }
      }
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

/**
 * Tap de snapshot para consumidores fora do broadcast por escopo (o HUD do
 * pet precisa dos totais cumulativos de TODOS os escopos). Recebe o mesmo
 * snapshot que o broadcast — nunca um recálculo separado.
 */
export type UsageSnapshotListener = (
  scope: ProjectExecutionScope,
  snapshot: UsageSnapshot,
) => void;

const usageSnapshotListeners = new Set<UsageSnapshotListener>();

export function tapUsageSnapshot(listener: UsageSnapshotListener): () => void {
  usageSnapshotListeners.add(listener);
  return () => usageSnapshotListeners.delete(listener);
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
  ipcMain.handle(USAGE_CHANNELS.snapshot, (event): UsageSnapshot | null => {
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
