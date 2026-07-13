import { canMarkMilestoneDone } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { onHandoffSubmitted } from './idle-delivery';
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
} from './mission-driver-runtime';
import { getProjectDomainStores } from './project-domain-store-registry';

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
/** Memória em-processo do contador de iterações (budget). */
const driveIterationMemory = new Map<string, number>();
/** Memória em-processo do lastActionAt (exponential backoff). */
const driveLastActionMemory = new Map<string, number>();
/**
 * Wall-clock budget anchor: first time the driver observed this mission as
 * running. Using mission.createdAt would exhaust maxWallClockMs for old rows.
 */
const driveStartedAtMemory = new Map<string, number>();

/**
 * Loader IO: monta DriveState a partir dos stores reais (mission + handoffs,
 * com steps + evidence trust). Sem mutação; o IO é só leitura scoped.
 * Current step inherits *unused* mission-level nexus-trusted evidence when
 * its own evidenceIds is empty (see deriveDriveState/toDriveStep).
 */
export function loadDriveState(
  missionId: string,
  scope: ProjectExecutionScope,
): DriveState | null {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) return null;
  const handoffs = stores.handoffs.list({
    missionId,
    includeDelivered: true,
  });
  const key = driveKey(missionId, scope);
  const iteration = driveIterationMemory.get(key) ?? 0;
  const lastActionAt = driveLastActionMemory.get(key);
  let startedAt = driveStartedAtMemory.get(key);
  if (startedAt === undefined) {
    // First observation of this running mission in this process.
    startedAt = Date.now();
    driveStartedAtMemory.set(key, startedAt);
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
      console.info(
        `[mission-driver:active] respawn-fresh-context mission=${missionId} ` +
          `reason="${reason}" (learning recorded; no kill)`,
      );
      getStores(scope).missions.appendLearning(
        missionId,
        `respawn-fresh-context requested: ${reason}`,
      );
    },
    reRoute: async (missionId, scope, reason) => {
      console.info(
        `[mission-driver:active] re-route mission=${missionId} reason="${reason}"`,
      );
      getStores(scope).missions.appendLearning(
        missionId,
        `re-route requested: ${reason}`,
      );
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
        step.evidenceIds.length > 0 ? [...step.evidenceIds] : [...unused];
      if (!canMarkMilestoneDone({ evidenceIds: evidenceForStep }, trustSet)) {
        throw new Error(
          `advance rejected: step ${stepId} lacks nexus-trusted evidence`,
        );
      }
      if (step.evidenceIds.length === 0 && evidenceForStep.length > 0) {
        const nextMilestones = mission.milestones.map((item) =>
          item.id === stepId
            ? {
                ...item,
                status:
                  item.status === 'pending'
                    ? ('in-progress' as const)
                    : item.status,
                evidenceIds: evidenceForStep,
              }
            : item,
        );
        stores.missions.update(missionId, { milestones: nextMilestones });
      }

      // Trusted-evidence gate first: mark step done before PREVC so a PREVC
      // failure cannot leave the workflow advanced with the step non-done.
      const updated = stores.missions.markMilestoneDone(
        missionId,
        stepId,
        trustedIds,
      );
      if (!updated) {
        throw new Error(
          `advance rejected: markMilestoneDone failed for ${stepId}`,
        );
      }
      const still = updated.milestones.find((item) => item.id === stepId);
      if (still?.status !== 'done') {
        throw new Error(
          `advance rejected: step ${stepId} remains non-done (untrusted)`,
        );
      }

      // PREVC path: soft-fail — step checkpoint already secured. A frozen
      // workflow that is not yet ready for the next stage must not roll back
      // the mission step; next ticks / complete gate will re-check PREVC.
      try {
        prevc.advanceWorkflowStage(missionId, scope);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[mission-driver:active] PREVC advance soft-failed after step ` +
            `${stepId} done on ${missionId}: ${message}`,
        );
        stores.missions.appendLearning(
          missionId,
          `prevc advance soft-failed after step ${stepId} done: ${message}`,
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
      // PREVC gate: if a workflow is frozen and not yet complete, refuse to
      // flip mission status outside advanceWorkflow.
      if (!prevc.isWorkflowCompleteOrAbsent(missionId, scope)) {
        try {
          prevc.advanceWorkflowStage(missionId, scope);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `complete rejected: PREVC advance failed (${message})`,
          );
        }
        if (!prevc.isWorkflowCompleteOrAbsent(missionId, scope)) {
          throw new Error(
            'complete rejected: PREVC workflow not complete (advanceWorkflow required)',
          );
        }
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
  const applyPorts =
    options.applyPorts ??
    (config.mode === 'active' ? createProductionApplyPorts() : undefined);
  return {
    listScopes: options.listScopes,
    listRunningMissions: (scope) =>
      getProjectDomainStores(scope)
        .missions.list('running')
        .map((mission) => ({ id: mission.id })),
    loadDriveState,
    now: () => Date.now(),
    onDecision:
      config.mode === 'active' ? logDecisionActive : logDecisionShadow,
    getDriveSignalAt: (missionId, scope) =>
      driveSignalMemory.get(driveKey(missionId, scope)),
    recordDriveSignal: (missionId, scope, at) => {
      driveSignalMemory.set(driveKey(missionId, scope), at);
    },
    getIteration: (missionId, scope) =>
      driveIterationMemory.get(driveKey(missionId, scope)) ?? 0,
    recordIteration: (missionId, scope, next) => {
      driveIterationMemory.set(driveKey(missionId, scope), next);
    },
    getLastActionAt: (missionId, scope) =>
      driveLastActionMemory.get(driveKey(missionId, scope)),
    recordLastActionAt: (missionId, scope, at) => {
      driveLastActionMemory.set(driveKey(missionId, scope), at);
    },
    ...(applyPorts ? { applyPorts } : {}),
  };
}

/**
 * Conveniência de wiring: monta deps padrão e registra no runtime.
 * Default mode is active (Fase C). Pass config.mode: 'shadow' to observe only.
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
}

export {
  disposeMissionDriverRuntime,
  startMissionDriverLoop,
  stopMissionDriverLoop,
};

/** Clear in-process budget/signal/backoff/start memory (tests + dispose). */
export function resetDriveIoMemoryForTests(): void {
  driveSignalMemory.clear();
  driveIterationMemory.clear();
  driveLastActionMemory.clear();
  driveStartedAtMemory.clear();
}

/** Called from dispose path so multi-session restarts don't leak maps. */
export function disposeMissionDriverIo(): void {
  resetDriveIoMemoryForTests();
  disposeMissionDriverRuntime();
}
