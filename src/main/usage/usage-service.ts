import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
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
  setResumeSessionForget,
  setResumeSessionLookup,
  setSessionDictationHook,
  type DictatedSessionInfo,
} from '../pty/pty-manager';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  forgetProviderSessionById,
  getProviderPaneSession,
  saveProviderPaneSession,
} from '../persistence/provider-session-store';
import { ClaudeTranscriptWatcher } from './claude-transcript-watcher';
import { ClaudeTranscriptResumeStore } from './claude-transcript-resume-store';
import { MimoUsageScanner, type MimoSessionBinding } from './mimo-scanner';
import { tapMimoSessionBindings, resolveMimoUsageBinding, releaseMimoUsageBinding, isMimoUsageBindingProved } from '../agent-hooks/mimo-session-registry';
import { stopMimoValidationReader } from './mimo-worker-reader';
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
      readonly accountId?: string;
    }
  >;
  watcher: ClaudeTranscriptWatcher | null;
  broadcastTimer: ReturnType<typeof setTimeout> | null;
}

const SESSION_CLOCK_SKEW_MS = 5 * 60_000;
const SESSION_BIND_WINDOW_MS = 24 * 60 * 60_000;
const CODEX_ROLLOUT_SPAWN_SKEW_MS = 30_000;
const CODEX_ROLLOUT_START_WINDOW_MS = 5 * 60_000;

/**
 * Where the Claude watcher of one scope left each transcript, across
 * restarts (`<userData>/usage/claude-resume-<scope>.json`). Outside Electron
 * (tests without an app) the watcher keeps offsets in memory only.
 */
function claudeResumeStoreFor(
  scope: ProjectExecutionScope,
): ClaudeTranscriptResumeStore | null {
  let userData: string;
  try {
    userData = app.getPath('userData');
  } catch {
    return null;
  }
  if (!userData) return null;
  const scopeId = createHash('sha256')
    .update(`${scope.installationId}\0${scope.projectId}\0${scope.checkoutId}`)
    .digest('hex')
    .slice(0, 16);
  return new ClaudeTranscriptResumeStore(
    path.join(userData, 'usage', `claude-resume-${scopeId}.json`),
  );
}

/**
 * Roots de config do Claude onde as sessões deste checkout gravam transcript.
 * Panes Claude rodam com HOME privado e as conversas moram no estado por
 * checkout (`linkProviderSessionState`): `<userData>/provider-state/claude/
 * <checkoutId>/claude/projects`. Olhar só `~/.claude` deixava todo pane sem
 * uso real desde a mudança — o badge caía na heurística por bytes ($120.59
 * para ~$48 reais) e o tok/s na estimativa da tela (27/09).
 */
export function claudeConfigDirsFor(
  scope: ProjectExecutionScope,
  userData: string | null,
  home = os.homedir(),
): string[] {
  const dirs = [path.join(home, '.claude')];
  if (userData && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(scope.checkoutId)) {
    dirs.push(
      path.join(userData, 'provider-state', 'claude', scope.checkoutId, 'claude'),
    );
  }
  return dirs;
}

/**
 * Raízes `sessions/` dos CODEX_HOME privados por checkout (F-566/F-211).
 * Panes Codex rodam com `CODEX_HOME=<userData>/provider-state/codex/
 * <checkoutId>` — sem esta raiz o scanner só lia ~/.codex/sessions e nenhum
 * rollout Nexus era visto: zero uso real, zero vínculo, todo relive/respawn
 * abria conversa nova.
 */
export function codexSessionsDirsFor(
  scope: ProjectExecutionScope,
  userData: string | null,
): string[] {
  if (!userData || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(scope.checkoutId)) {
    return [];
  }
  return [
    path.join(
      userData,
      'provider-state',
      'codex',
      scope.checkoutId,
      'sessions',
    ),
  ];
}

function electronUserData(): string | null {
  try {
    return app.getPath('userData') || null;
  } catch {
    return null;
  }
}

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
  #stopFlight: Promise<void> | null = null;

  constructor(registry: ProjectUsageStoreRegistry) {
    this.#registry = registry;
  }

  start(): void {
    if (this.#stopped) throw new Error('usage telemetry service is stopped');
    setSessionDictationHook((info) => this.#onSessionDictated(info));
    if (!this.#mimoScanner) {
      this.#mimoScanner = new MimoUsageScanner((binding, event) => this.#onMimoEvent(binding, event),
        resolveMimoUsageBinding, releaseMimoUsageBinding);
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
    // F-721: um `--resume <id>` que falha duas vezes seguidas no boot é um id que nunca
    // virou transcrito — o vínculo é esquecido e a próxima restauração nasce limpa.
    setResumeSessionForget((scope, adapterId, sessionId) => {
      this.#rememberForgottenResumeId(scope, adapterId, sessionId);
      return forgetProviderSessionById(scope, adapterId, sessionId);
    });
    setResumeSessionLookup((scope, paneId, adapterId, accountId, spawn) => {
      try {
        return this.#resumeSessionForPane(
          scope,
          paneId,
          adapterId,
          accountId,
          spawn?.executionScope,
        );
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
      const resumeStore = claudeResumeStoreFor(state.scope);
      const watcher = new ClaudeTranscriptWatcher({
        workspacePath: state.scope.rootRealPath,
        workspacePaths: () => state.executionRoots,
        configDirs: claudeConfigDirsFor(state.scope, electronUserData()),
        onEvent: (event, _file, timing) =>
          this.#onClaudeEvent(state, event, timing.requestStartedAt),
        ...(resumeStore ? { resumeStore } : {}),
      });
      watcher.start();
      state.watcher = watcher;
    }
    if (provider === 'codex') this.#ensureCodexScanner();
  }

  stop(): Promise<void> {
    if (this.#stopFlight) return this.#stopFlight;
    this.#stopped = true;
    setSessionDictationHook(null);
    setResumeSessionLookup(null);
    setResumeSessionForget(null);
    this.#stopMimoBindings?.();
    this.#stopMimoBindings = null;
    const stops: Promise<void>[] = [];
    const stop = (run: () => void | Promise<void>) => {
      try { stops.push(Promise.resolve(run())); } catch (error) { stops.push(Promise.reject(error)); }
    };
    for (const state of this.#states.values()) {
      if (state.broadcastTimer) clearTimeout(state.broadcastTimer);
      state.broadcastTimer = null;
      if (state.watcher) stop(() => state.watcher!.stop());
    }
    if (this.#codexScanner) stop(() => this.#codexScanner!.stop());
    if (this.#mimoScanner) stop(() => this.#mimoScanner!.stop());
    stop(stopMimoValidationReader);
    this.#stopFlight = Promise.allSettled(stops).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      for (const state of this.#states.values()) {
        state.watcher = null;
        state.executionRoots.clear(); state.dictated.clear(); state.resumedSessions.clear();
        state.accountIdByProviderSession.clear(); state.pendingLaunches.clear();
      }
      this.#states.clear(); this.#rootOwners.clear(); this.#forgottenResumeIds.clear();
      this.#codexScanner = null; this.#mimoScanner = null;
    });
    return this.#stopFlight;
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
    if (this.#stopped) return;
    if (info.adapterId !== 'claude' && info.adapterId !== 'codex') {
      // F-1353: sem telemetria de uso para este adapter, mas o id DITADO
      // (`--session-id` do glm, deepseek, qwen…) é a conversa do pane. Sem a
      // linha, retomar o writer fechado recusava com
      // `resume_context_unavailable` — e o transcrito estava no provider-state.
      const owner = getContextBySession(info.ptySessionId);
      if (owner && info.providerSessionId && info.paneId) {
        saveProviderPaneSession(
          owner.scope,
          info.paneId,
          info.adapterId,
          { key: 'session_id', id: info.providerSessionId },
          info.accountId,
        );
      }
      return;
    }
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
        ...(info.accountId ? { accountId: info.accountId } : {}),
      });
    }
    this.#watchProvider(state.scope, info.adapterId);
  }

  /** Ids de conversa esquecidos nesta sessão do app (F-721), limitados. */
  readonly #forgottenResumeIds = new Set<string>();

  #forgottenKey(
    scope: Readonly<{ installationId: string; projectId: string; checkoutId: string }>,
    adapterId: string,
    sessionId: string,
  ): string {
    return JSON.stringify([scope.installationId, scope.projectId, scope.checkoutId, adapterId, sessionId]);
  }

  #rememberForgottenResumeId(
    scope: Readonly<{ installationId: string; projectId: string; checkoutId: string }>,
    adapterId: string,
    sessionId: string,
  ): void {
    this.#forgottenResumeIds.add(this.#forgottenKey(scope, adapterId, sessionId));
    while (this.#forgottenResumeIds.size > 256) {
      const oldest = this.#forgottenResumeIds.values().next().value;
      if (oldest === undefined) break;
      this.#forgottenResumeIds.delete(oldest);
    }
  }

  #isForgottenResumeId(
    scope: Readonly<{ installationId: string; projectId: string; checkoutId: string }>,
    adapterId: string,
    sessionId: string,
  ): boolean {
    return this.#forgottenResumeIds.has(this.#forgottenKey(scope, adapterId, sessionId));
  }

  #resumeSessionForPane(
    scope: ProjectExecutionScope,
    paneId: string,
    adapterId: string,
    accountId?: string,
    spawnExecutionScope?: Readonly<ProjectExecutionScope>,
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
      const executionRoot = this.#registerResumePaneRoot(
        state,
        paneId,
        spawnExecutionScope,
      );
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
    // F-721: um id que o pty-manager já julgou inutilizável não volta pela telemetria.
    if (this.#isForgottenResumeId(scope, adapterId, captured.sessionId)) return null;
    const executionRoot = this.#registerResumePaneRoot(
      state,
      paneId,
      spawnExecutionScope,
    );
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
    spawnExecutionScope?: Readonly<ProjectExecutionScope>,
  ): string | null {
    const pane = getPaneAuthzInfo(paneId);
    let paneScope = pane?.scope;
    let executionScope = pane?.executionScope;
    if (!paneScope && spawnExecutionScope) {
      // F-721: no primeiro spawn do pane neste processo (restauração depois de
      // reiniciar o app, pane novo da retomada da aba) o registro ainda não tem
      // meta nem sessão dele. A raiz vem da autoridade do spawn, selada pelo
      // Main — sem ela o resume exato caía em sessão nova.
      if (
        spawnExecutionScope.installationId !== state.scope.installationId ||
        spawnExecutionScope.projectId !== state.scope.projectId ||
        spawnExecutionScope.checkoutId !== state.scope.checkoutId
      ) {
        return null;
      }
      paneScope = state.scope;
      executionScope = spawnExecutionScope;
    }
    if (!paneScope || !sameProjectScope(paneScope, state.scope)) {
      return null;
    }
    const configuredRoot =
      executionScope?.rootRealPath ?? paneScope.rootRealPath;
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
    if (this.#stopped || !isMimoUsageBindingProved(binding)) return;
    const state = this.#ensureScope(binding.scope);
    state.stores.usage.record('mimo-code', {
      ...event, paneId: binding.historicalUnowned ? null : binding.paneId, accountId: binding.accountId ?? null,
      missionId: binding.missionId ?? null,
    }, binding.historicalUnowned ? {} : { exactNativeAttribution: true });
    if (!binding.historicalUnowned) this.#feedTokenSpeed('mimo-code', event, binding.paneId);
    this.#scheduleBroadcast(state);
  }

  #onClaudeEvent(
    state: ScopeTelemetryState,
    event: UsageEvent,
    requestStartedAt: number | null = null,
  ): void {
    if (this.#stopped) return;
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
    this.#feedTokenSpeed(
      'claude',
      event,
      attribution?.paneId ?? null,
      requestStartedAt,
    );
    this.#scheduleBroadcast(state);
  }

  #onCodexEvent(
    state: ScopeTelemetryState,
    event: UsageEvent,
    observedCwd: string,
    source: CodexRolloutSource,
  ): void {
    if (this.#stopped) return;
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
    startedAt: number | null = null,
  ): void {
    if (!paneId || event.outputTokens <= 0) return;
    try {
      recordTokenSpeedUsage(paneId, {
        key: `${provider}:${event.sessionId}:${event.messageId ?? event.timestamp ?? 'sem-id'}`,
        outputTokens: event.outputTokens,
        model: event.model,
        timestamp: event.timestamp,
        startedAt,
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
    // F-211: rollout Codex fresco ligado a EXATAMENTE um launch persiste o
    // provider_pane_session (com a conta do launch) — sem a linha o resume
    // exato nunca fecha para pane pinado em conta e todo relive/respawn
    // nascia com conversa nova (campo 28/09).
    if (provider === 'codex') {
      const launchAccountIds = new Set(
        [...recentLaunches]
          .map((ptySessionId) => state.pendingLaunches.get(ptySessionId)?.accountId)
          .filter((accountId): accountId is string => Boolean(accountId)),
      );
      try {
        saveProviderPaneSession(
          state.scope,
          [...candidatePaneIds][0],
          provider,
          { key: 'session_id', id: event.sessionId },
          launchAccountIds.size === 1 ? [...launchAccountIds][0] : undefined,
        );
      } catch (error) {
        // Telemetria nunca derruba o vínculo já provado — o pane continua
        // atribuído; só o resume exato da próxima vida fica sem a linha.
        console.warn(
          '[usage] provider_pane_session não persistiu:',
          error instanceof Error ? error.message : error,
        );
      }
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
      // F-211: varre também as raízes provider-state dos checkouts em uso —
      // thunk porque o conjunto de escopos cresce depois do scanner subir.
      sessionsDirs: () => {
        const userData = electronUserData();
        const roots = new Set<string>();
        for (const state of this.#states.values()) {
          for (const dir of codexSessionsDirsFor(state.scope, userData)) {
            roots.add(dir);
          }
        }
        return [...roots];
      },
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
    if (this.#stopped) return;
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

let usageLifecycle: Promise<void> = Promise.resolve();
let usageLifecycleEpoch = 0;

export function initUsageTelemetry(runtimeManager: ProjectRuntimeManager): Promise<UsageTelemetryService | null> {
  const epoch = ++usageLifecycleEpoch;
  const previous = configuredService; configuredService = null;
  ipcMain.removeHandler(USAGE_CHANNELS.snapshot);
  const stopping = previous?.stop(); // closes admission before the first await
  const init = usageLifecycle.then(async () => {
    await stopping;
    if (epoch !== usageLifecycleEpoch) return null;
    const registry = configureProjectUsageStoreRegistry(runtimeManager);
    const service = new UsageTelemetryService(registry);
    configuredService = service; service.start();
    ipcMain.handle(USAGE_CHANNELS.snapshot, (event): UsageSnapshot | null =>
      service.snapshot(requireRendererWorkspaceScope(event.sender)));
    return service;
  });
  usageLifecycle = init.then(() => undefined);
  void usageLifecycle.catch(() => {}); // returned init retains the failure; no store fallback
  return init;
}

export function notifyMediaGenerated(scope: ProjectExecutionScope): void {
  if (!configuredService) {
    throw new Error('project-scoped usage telemetry is not initialized');
  }
  configuredService.notifyMediaGenerated(scope);
}

export function shutdownUsageTelemetry(): Promise<void> {
  usageLifecycleEpoch++;
  ipcMain.removeHandler(USAGE_CHANNELS.snapshot);
  const service = configuredService; configuredService = null;
  const stopping = service?.stop();
  usageLifecycle = usageLifecycle.then(async () => {
    await stopping;
    disposeProjectUsageStoreRegistry();
  });
  void usageLifecycle.catch(() => {});
  return usageLifecycle;
}
