import {
  isRecoveryEligibleIntentState,
  resolveEffectiveIntentState,
} from '../../shared/mission-intent';
import {
  canMarkMilestoneDone,
  type MissionPaneSpec,
  type PaneSnapshot,
} from '../../shared/orch-types';
import {
  compactMissionContext,
  renderMissionCompact,
} from '../../shared/mission-context-compact';
import type { ProjectExecutionScope } from '../../shared/types';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { onHandoffSubmitted } from './idle-delivery';
import {
  hasMirroredWorkspaceScope,
  listPaneSnapshots,
  requestMissionPaneRecovery,
} from './pane-registry';
import {
  deriveDriveState,
  unusedTrustedEvidenceIds,
  type DriveState,
} from './mission-drive';
import { type ApplyActionPorts } from './mission-driver-apply';
import {
  createProductionPrevcPort,
  type PrevcAdvancePort,
} from './mission-driver-prevc';
import {
  configureMissionDriverRuntime,
  disposeMissionDriverRuntime,
  logDecisionActive,
  logDecisionShadow,
  startMissionDriverLoop,
  stopMissionDriverLoop,
  type DriveConfig,
  type DriveDeps,
  defaultDriveConfig,
  requestMissionDriverTick,
} from './mission-driver-runtime';
import {
  getProjectDomainStores,
  requireProjectDomainStoreRegistry,
} from './project-domain-store-registry';
import { sameProjectScope } from './project-scoped-broadcast';

/**
 * Camada IO do Mission Driver: monta DriveDeps a partir dos stores reais
 * (ScopedMissionStore + ScopedHandoffStore) e apply ports ativos.
 * Separada do runtime puro para unit-testabilidade sem DB.
 */

function driveKey(missionId: string, scope: ProjectExecutionScope): string {
  return `${scope.projectId}:${scope.checkoutId}/${missionId}`;
}

/** Memória em-processo do último signal-stall emitido pelo drive (debounce). */
const driveSignalMemory = new Map<string, number>();
/**
 * Shadow mode remains observation-only, so its debounce/start anchors stay in
 * memory. Active mode uses mission_drive_state and survives app restarts.
 */
const driveStartedAtMemory = new Map<string, number>();
let unsubscribeDriveStoreChanges: (() => void) | null = null;

function snapshotForPersistedPane(
  missionId: string,
  persisted: MissionPaneSpec,
  snapshots: readonly PaneSnapshot[],
): PaneSnapshot | undefined {
  return snapshots.find(
    (pane) =>
      pane.missionId === missionId &&
      pane.role === persisted.role &&
      pane.paneId === persisted.paneId,
  );
}

/** Stable identity makes a missing worker/orchestrator recoverable after exit. */
export function findDeadMissionPane(
  missionId: string,
  persisted: readonly MissionPaneSpec[],
  snapshots: readonly PaneSnapshot[],
): MissionPaneSpec | null {
  return (
    persisted.find((pane) => {
      if (!pane.paneId) return false;
      const snapshot = snapshotForPersistedPane(missionId, pane, snapshots);
      return !snapshot || snapshot.state === 'exited';
    }) ?? null
  );
}

/**
 * Pane absence is meaningful only after a renderer has mirrored the exact
 * workspace scope. Mission ids and pane ids are not cross-project authority.
 */
export function hasMirroredScope(
  scope: ProjectExecutionScope,
  snapshots: readonly PaneSnapshot[],
): boolean {
  return snapshots.some((snapshot) => {
    const paneScope = snapshot.scope ?? snapshot.executionScope;
    return paneScope ? sameProjectScope(paneScope, scope) : false;
  });
}

/**
 * Recovery decisions must never compare mission/pane identity against panes
 * of another project: ids repeat across workspaces, so every snapshot is
 * scope-filtered before findDeadMissionPane sees it. Snapshots without any
 * scope are excluded (fail-closed).
 */
export function snapshotsForScope(
  scope: ProjectExecutionScope,
  snapshots: readonly PaneSnapshot[],
): PaneSnapshot[] {
  return snapshots.filter((snapshot) => {
    const paneScope = snapshot.scope ?? snapshot.executionScope;
    return paneScope ? sameProjectScope(paneScope, scope) : false;
  });
}

/**
 * Loader IO: monta DriveState a partir dos stores reais (mission + handoffs,
 * com steps + evidence trust). Sem mutação; o IO é só leitura scoped.
 * Current step inherits *unused* mission-level nexus-trusted evidence when
 * its own evidenceIds is empty (see deriveDriveState/toDriveStep).
 */
export function loadDriveState(
  missionId: string,
  scope: ProjectExecutionScope,
  options: { readonly persistRuntime?: boolean } = {},
): DriveState | null {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) return null;
  const handoffs = stores.handoffs.list({
    missionId,
    includeDelivered: true,
  });
  const key = driveKey(missionId, scope);
  const runtime = options.persistRuntime
    ? stores.missions.ensureDriveRuntimeState(missionId, Date.now())
    : null;
  const iteration = runtime?.attemptCount ?? 0;
  const lastActionAt = runtime?.lastAttemptAt;
  let startedAt = runtime?.runStartedAt ?? driveStartedAtMemory.get(key);
  if (startedAt === undefined) {
    startedAt = Date.now();
    driveStartedAtMemory.set(key, startedAt);
  }
  const persistedPanes = stores.missionPanes
    .list(missionId)
    .filter((pane) => pane.paneId);
  const snapshots = listPaneSnapshots();
  // Absence is actionable only after the exact workspace has been mirrored.
  // Readiness comes from the renderer sync heartbeat (covers an empty layout
  // after crash) with the snapshot scan as fallback; dead-pane identity is
  // compared exclusively against snapshots of this scope.
  const mirrored =
    hasMirroredWorkspaceScope(scope) || hasMirroredScope(scope, snapshots);
  const paneDead =
    mirrored &&
    findDeadMissionPane(
      missionId,
      persistedPanes,
      snapshotsForScope(scope, snapshots),
    ) !== null;
  const workflowService = getContextWorkflowService(scope);
  const missionWorkflow = workflowService.getMissionWorkflow(missionId);
  const completionVerified = workflowService.isMissionDriverComplete(
    missionId,
    mission.milestones.map((milestone) => milestone.id),
  );
  let contextRot = false;
  if (missionWorkflow.contract) {
    try {
      const readiness = workflowService.inspectReadiness();
      contextRot =
        !readiness.ready ||
        !readiness.contextRevision ||
        readiness.contextRevision !==
          missionWorkflow.contract.contract.contextRevision;
    } catch {
      // A frozen mission whose current context cannot be inspected must recover
      // into a fresh context, never keep executing against stale authority.
      contextRot = true;
    }
  }
  return deriveDriveState({
    mission: {
      id: mission.id,
      status: mission.status,
      updatedAt: mission.updatedAt,
      milestones: mission.milestones,
      createdAt: mission.createdAt,
    },
    handoffs: handoffs.map((handoff) => ({
      status: handoff.status,
      createdAt: handoff.createdAt,
      evidenceTrust: handoff.evidenceTrust,
      evidenceIds: handoff.evidenceIds,
    })),
    signals: {
      iteration,
      startedAt,
      paneDead,
      contextRot,
      completionVerified,
      ...(lastActionAt !== undefined ? { lastActionAt } : {}),
    },
  });
}

type DomainStores = ReturnType<typeof getProjectDomainStores>;

/**
 * Production apply ports: real handoff stall signal, PREVC advanceWorkflow via
 * ContextWorkflowService, trusted-evidence markMilestoneDone, status changes.
 * `getStores` is injectable so tests can drive the real port logic with fakes.
 */
export function createProductionApplyPorts(
  prevc: PrevcAdvancePort = createProductionPrevcPort(getContextWorkflowService),
  getStores: (
    scope: ProjectExecutionScope,
  ) => DomainStores = getProjectDomainStores,
  recoverPane = requestMissionPaneRecovery,
  paneSnapshots = listPaneSnapshots,
): ApplyActionPorts {
  const collectTrusted = (
    scope: ProjectExecutionScope,
    missionId: string,
  ): string[] => {
    const trustedIds: string[] = [];
    for (const handoff of getStores(scope).handoffs.list({
      missionId,
      includeDelivered: true,
    })) {
      if (handoff.evidenceTrust !== 'nexus-trusted') continue;
      for (const evidenceId of handoff.evidenceIds) {
        trustedIds.push(evidenceId);
      }
    }
    return trustedIds;
  };

  return {
    submitStalledHandoff: (missionId, scope, action) => {
      const stores = getStores(scope);
      const minutes = Math.round(action.silentForMs / 60_000);
      const handoff = stores.handoffs.submit({
        status: 'stalled',
        summary:
          `mission-driver: missão sem progresso há ${minutes} min ` +
          `(${action.reason}). Sinal não-destrutivo — leia o pane para ` +
          `diagnosticar; o driver não mata workers silenciosos.`,
        missionId,
        fromAgent: 'nexus-mission-driver',
      });
      onHandoffSubmitted(handoff, scope);
    },
    respawnFreshContext: async (missionId, scope, reason) => {
      const stores = getStores(scope);
      const mission = stores.missions.get(missionId);
      const persisted = stores.missionPanes
        .list(missionId)
        .filter((pane) => pane.paneId);
      const snapshots = snapshotsForScope(scope, paneSnapshots());
      const dead = findDeadMissionPane(missionId, persisted, snapshots);
      const target =
        dead ?? persisted.find((pane) => pane.role === 'orchestrator');
      if (!mission || !target?.paneId) {
        throw new Error('fresh-context rejected: persisted mission pane missing');
      }
      const snapshot = snapshotForPersistedPane(missionId, target, snapshots);
      const expectedSessionId =
        snapshot?.sessionId ??
        (target.role === 'orchestrator'
          ? mission.orchestratorSessionId
          : undefined);
      const compactMemory = renderMissionCompact(
        compactMissionContext({
          mission,
          handoffs: stores.handoffs.list({
            missionId,
            includeDelivered: true,
          }),
        }),
      );
      const recap = [
        compactMemory,
        `Recovered role: ${target.role}${target.agentName ? ` (${target.agentName})` : ''}`,
        `Recovery reason: ${reason}`,
        'Continue this mission from a fresh context. Inspect current repository and pane state before changing files.',
      ]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 65_536);
      const result = await recoverPane({
        missionId,
        paneId: target.paneId,
        role: target.role,
        expectedSessionId,
        pane: target,
        scope,
        recap,
      });
      if (!result.ok || !result.sessionId) {
        throw new Error(
          `fresh-context failed: ${result.error ?? 'renderer did not acknowledge'}`,
        );
      }
      stores.missions.appendLearning(
        missionId,
        `respawn-fresh-context completed (${result.sessionId}): ${reason}`,
      );
    },
    reRoute: async () => {
      // Account failover owns provider/account switching. Never report a fake
      // success from the Ralph driver if that subsystem did not acknowledge it.
      throw new Error('re-route is owned by the account failover controller');
    },
    advanceStep: (missionId, scope, stepId) => {
      const stores = getStores(scope);
      const mission = stores.missions.get(missionId);
      if (!mission) {
        throw new Error(`advance rejected: mission ${missionId} not found`);
      }
      const step = mission.milestones.find((item) => item.id === stepId);
      if (!step) {
        throw new Error(`advance rejected: step ${stepId} not found`);
      }
      const trustedIds = collectTrusted(scope, missionId);
      const trustSet = new Set(trustedIds);
      // Only unused trusted evidence may be inherited (no reuse across steps).
      const unused = unusedTrustedEvidenceIds(mission.milestones, trustSet);
      const evidenceForStep =
        step.evidenceIds.length > 0 ? [...step.evidenceIds] : unused.slice(0, 1);
      if (!canMarkMilestoneDone({ evidenceIds: evidenceForStep }, trustSet)) {
        throw new Error(
          `advance rejected: step ${stepId} lacks nexus-trusted evidence`,
        );
      }
      // The PREVC port owns the SQLite transaction that advances the workflow,
      // binds evidence, inserts a receipt and marks the milestone done.
      prevc.advanceMissionStep(missionId, scope, stepId, evidenceForStep);

      const updated = stores.missions.get(missionId);
      if (!updated) throw new Error(`advance rejected: mission ${missionId} vanished`);
      const still = updated.milestones.find((item) => item.id === stepId);
      if (still?.status !== 'done') {
        throw new Error(
          `advance rejected: step ${stepId} remains non-done (untrusted)`,
        );
      }

    },
    setMissionStatus: (missionId, scope, status) => {
      const updated = getStores(scope).missions.setStatus(missionId, status);
      if (!updated) {
        throw new Error(`setStatus failed for mission ${missionId}`);
      }
    },
    completeMission: (missionId, scope) => {
      const stores = getStores(scope);
      const mission = stores.missions.get(missionId);
      if (!mission) {
        throw new Error(`complete rejected: mission ${missionId} not found`);
      }
      if (mission.milestones.length === 0) {
        throw new Error(
          'complete rejected: no steps (cannot complete without PREVC steps)',
        );
      }
      if (!mission.milestones.every((step) => step.status === 'done')) {
        throw new Error(
          'complete rejected: not all steps done via trusted evidence',
        );
      }
      for (const step of mission.milestones) {
        if (step.evidenceIds.length === 0) {
          throw new Error(
            `complete rejected: step ${step.id} done without evidenceIds`,
          );
        }
      }
      // Completion is verification-only. It never advances PREVC as a side
      // effect and it never treats registry errors/absence as success.
      if (
        !prevc.isMissionComplete(
          missionId,
          scope,
          mission.milestones.map((step) => step.id),
        )
      ) {
        throw new Error(
          'complete rejected: PREVC workflow or step receipts incomplete',
        );
      }
      const current = stores.missions.get(missionId);
      if (current?.status === 'done') return;
      const updated = stores.missions.setStatus(missionId, 'done');
      if (!updated) {
        throw new Error(`complete rejected: setStatus failed for ${missionId}`);
      }
    },
    appendLearning: (missionId, scope, entry) => {
      getStores(scope).missions.appendLearning(missionId, entry);
    },
  };
}

export function createDefaultDriveDeps(options: {
  listScopes: () => readonly ProjectExecutionScope[];
  config?: DriveConfig;
  applyPorts?: ApplyActionPorts;
}): DriveDeps {
  const config = options.config ?? defaultDriveConfig;
  const isActive = config.mode === 'active';
  const applyPorts =
    options.applyPorts ??
    (config.mode === 'active' ? createProductionApplyPorts() : undefined);
  return {
    listScopes: options.listScopes,
    listRunningMissions: (scope) => {
      const suite = getProjectDomainStores(scope);
      return suite.missions
        .list('running')
        .filter((mission) => {
          // Intent-first: driver only scans authorized execution, never human waits.
          const intent = resolveEffectiveIntentState({
            mission,
            taskCount: suite.tasks.list(mission.id).length,
            workerPaneCount: suite.missionPanes
              .list(mission.id)
              .filter((pane) => pane.role === 'worker').length,
          });
          return isRecoveryEligibleIntentState(intent);
        })
        .map((mission) => ({ id: mission.id }));
    },
    loadDriveState: (missionId, scope) =>
      loadDriveState(missionId, scope, { persistRuntime: isActive }),
    now: () => Date.now(),
    onDecision: async (snapshot) => {
      if (config.mode === 'active') {
        logDecisionActive(snapshot);
      } else {
        logDecisionShadow(snapshot);
      }
      // Lateral journal (flag fail-closed). Never replaces budgets/receipts.
      try {
        const { emitDriverDecision } = await import('./mission-event-emit');
        if (snapshot.action.kind !== 'wait') {
          // Stable tick: iteration + lastStallSignalAt so retries dedupe.
          const logicalTick =
            `${snapshot.state.iteration}:${snapshot.state.lastStallSignalAt ?? 0}:${snapshot.action.kind}`;
          emitDriverDecision(
            snapshot.scope,
            snapshot.missionId,
            snapshot.action.kind,
            snapshot.action.reason,
            config.mode,
            logicalTick,
          );
        }
      } catch {
        // Journal is optional observability — driver must not fail closed here.
      }
    },
    getDriveSignalAt: (missionId, scope) =>
      isActive
        ? getProjectDomainStores(scope).missions.getDriveRuntimeState(missionId)
            ?.lastSignalAt
        : driveSignalMemory.get(driveKey(missionId, scope)),
    recordDriveSignal: (missionId, scope, at) => {
      if (isActive) {
        getProjectDomainStores(scope).missions.recordDriveSignal(missionId, at);
      } else {
        driveSignalMemory.set(driveKey(missionId, scope), at);
      }
    },
    getIteration: (missionId, scope) =>
      isActive
        ? getProjectDomainStores(scope).missions.getDriveRuntimeState(missionId)
            ?.attemptCount ?? 0
        : 0,
    reserveAttempt: (missionId, scope, actionKind, at) => {
      if (!isActive) return;
      getProjectDomainStores(scope).missions.reserveDriveAttempt(
        missionId,
        actionKind,
        at,
      );
    },
    getLastActionAt: (missionId, scope) =>
      isActive
        ? getProjectDomainStores(scope).missions.getDriveRuntimeState(missionId)
            ?.lastAttemptAt
        : undefined,
    finishAttempt: (missionId, scope, outcome, at, error) => {
      if (!isActive) return;
      getProjectDomainStores(scope).missions.finishDriveAttempt(
        missionId,
        outcome,
        at,
        error,
      );
    },
    ...(applyPorts ? { applyPorts } : {}),
  };
}

/**
 * Conveniência de wiring: monta deps padrão e registra no runtime.
 * Default mode is SHADOW (observe-only). Enable active (Fase C, aplica efeitos)
 * via settings `missionDriverActiveMode` ou passando config.mode: 'active'.
 */
export function configureMissionDriver(options: {
  listScopes: () => readonly ProjectExecutionScope[];
  config?: DriveConfig;
  applyPorts?: ApplyActionPorts;
}): void {
  const config = options.config ?? defaultDriveConfig;
  configureMissionDriverRuntime({
    deps: createDefaultDriveDeps({
      listScopes: options.listScopes,
      config,
      ...(options.applyPorts ? { applyPorts: options.applyPorts } : {}),
    }),
    config,
  });
  unsubscribeDriveStoreChanges?.();
  unsubscribeDriveStoreChanges = requireProjectDomainStoreRegistry().onChange(
    (_scope, store) => {
      // Todos do usuário não alteram a autoridade de execução. As demais
      // fontes duráveis alimentam imediatamente a reconciliação do Ralph.
      if (store !== 'todos') requestMissionDriverTick();
    },
  );
}

export {
  defaultDriveConfig,
  disposeMissionDriverRuntime,
  startMissionDriverLoop,
  stopMissionDriverLoop,
};

/** Clear in-process budget/signal/backoff/start memory (tests + dispose). */
export function resetDriveIoMemoryForTests(): void {
  driveSignalMemory.clear();
  driveStartedAtMemory.clear();
}

/** Called from dispose path so multi-session restarts don't leak maps. */
export function disposeMissionDriverIo(): void {
  unsubscribeDriveStoreChanges?.();
  unsubscribeDriveStoreChanges = null;
  resetDriveIoMemoryForTests();
  disposeMissionDriverRuntime();
}
