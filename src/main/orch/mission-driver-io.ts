import { appendMissionVerdict } from '../../shared/mission-block-cause';
import { missionBlockPatch } from '../../shared/mission-blocking';
import {
  isRecoveryEligibleIntentState,
  resolveEffectiveIntentState,
} from '../../shared/mission-intent';
import {
  canMarkMilestoneDone,
  type Handoff,
  type MissionPaneSpec,
  type PaneSnapshot,
} from '../../shared/orch-types';
import {
  compactMissionContext,
  renderMissionCompact,
} from '../../shared/mission-context-compact';
import type { ProjectExecutionScope } from '../../shared/types';
import { milestoneValidationEvidenceId } from '../context/context-workflow-service';
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
import { inspectGuidedPrevcPostMergeAuthority } from './prevc-autopilot-coordinator';
import { sameProjectScope } from './project-scoped-broadcast';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { missionHasSchedulerProgress } from './mission-scheduler-authority';

/** Production Mission Driver IO over scoped stores and active apply ports. */

function driveKey(missionId: string, scope: ProjectExecutionScope): string {
  return `${scope.projectId}:${scope.checkoutId}/${missionId}`;
}

/** In-process debounce for the latest driver stall signal. */
const driveSignalMemory = new Map<string, number>();
/** Shadow start anchors stay in memory; active mode persists its runtime. */
const driveStartedAtMemory = new Map<string, number>();
let unsubscribeDriveStoreChanges: (() => void) | null = null;

const DEAD_ORCHESTRATOR_RECOVERY_MARKER =
  '[NEXUS_DEAD_ORCHESTRATOR_RECOVERY_BLOCKED]';
const DEAD_ORCHESTRATOR_RECOVERY_CTA = 'Retomar missão';

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

/** Workers belong to the durable dispatcher; only Maestro is driver-owned. */
export function actionableMissionPanes(
  persisted: readonly MissionPaneSpec[],
): MissionPaneSpec[] {
  return persisted.filter((pane) => pane.role === 'orchestrator');
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
 * Slots de maxWorkers realmente ocupados: linhas worker de mission_panes cujo
 * pane NÃO está comprovadamente morto. As linhas duráveis nunca são podadas
 * (são histórico + identidade de respawn), então contar linhas cruas fazia o
 * gate contar "quantos workers já EXISTIRAM" — worker morto/fechado segurava
 * o slot para sempre e a missão ficava permanentemente sem spawn (deadlock
 * de campo: "limite de 3 estourou" com todos os panes mortos, sem cura nem
 * por restart). Fail-safe herdada do driver: sem workspace espelhado ninguém
 * é dado como morto (worker recém-spawnado sem snapshot ainda conta), e linha
 * sem paneId (pré-bind) também conta.
 */
export function countLiveMissionWorkerSlots(
  scope: ProjectExecutionScope,
  missionId: string,
  rows: readonly MissionPaneSpec[],
  snapshots: readonly PaneSnapshot[] = listPaneSnapshots(),
): { live: number; deadPaneIds: readonly string[] } {
  const workers = rows.filter((row) => row.role === 'worker');
  const mirrored =
    hasMirroredWorkspaceScope(scope) || hasMirroredScope(scope, snapshots);
  if (!mirrored) return { live: workers.length, deadPaneIds: [] };
  const scoped = snapshotsForScope(scope, snapshots);
  const deadPaneIds: string[] = [];
  for (const worker of workers) {
    if (!worker.paneId) continue;
    const snapshot = snapshotForPersistedPane(missionId, worker, scoped);
    if (!snapshot || snapshot.state === 'exited') deadPaneIds.push(worker.paneId);
  }
  return {
    live: workers.length - deadPaneIds.length,
    deadPaneIds: Object.freeze(deadPaneIds),
  };
}

/**
 * Recovery decisions must never compare mission/pane identity against panes
 * of another project: ids repeat across workspaces, so snapshots that
 * definitively belong to a different scope are dropped before
 * findDeadMissionPane sees them. Snapshots with unknown scope stay: treating
 * a possibly-ours live pane as foreign would fabricate "dead pane" signals
 * and trigger spurious respawns, which is the more destructive failure.
 */
export function snapshotsForScope(
  scope: ProjectExecutionScope,
  snapshots: readonly PaneSnapshot[],
): PaneSnapshot[] {
  return snapshots.filter((snapshot) => {
    const paneScope = snapshot.scope ?? snapshot.executionScope;
    return paneScope ? sameProjectScope(paneScope, scope) : true;
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
  const lastActionKind = runtime?.lastActionKind;
  let startedAt = runtime?.runStartedAt ?? driveStartedAtMemory.get(key);
  if (startedAt === undefined) {
    startedAt = Date.now();
    driveStartedAtMemory.set(key, startedAt);
  }
  const persistedPanes = actionableMissionPanes(
    stores.missionPanes.list(missionId).filter((pane) => pane.paneId),
  );
  const snapshots = listPaneSnapshots();
  // Pane absence is actionable only after this exact workspace was mirrored.
  const mirrored =
    hasMirroredWorkspaceScope(scope) || hasMirroredScope(scope, snapshots);
  const paneDead =
    mirrored &&
    findDeadMissionPane(
      missionId,
      persistedPanes,
      snapshotsForScope(scope, snapshots),
    ) !== null &&
    !missionHasSchedulerProgress(
      mission,
      stores.missions.hasCurrentKickoffAcceptance(missionId),
      stores.taskDispatches.list(missionId),
    );
  const workflowService = getContextWorkflowService(scope);
  const missionWorkflow = workflowService.getMissionWorkflow(missionId);
  const currentStep = mission.milestones.find(
    (milestone) => milestone.status !== 'done',
  );
  const expectedEvidenceId =
    currentStep && missionWorkflow.workflow
      ? milestoneValidationEvidenceId(
          missionId,
          currentStep.id,
          missionWorkflow.workflow.binding,
        )
      : null;
  const trustedEvidenceIds = new Set(
    collectFinalPrevcEvidenceIds(
      missionId,
      missionWorkflow.workflow?.revision ?? null,
      expectedEvidenceId,
      handoffs,
    ),
  );
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
    trustedEvidenceIds,
    signals: {
      iteration,
      startedAt,
      paneDead,
      contextRot,
      completionVerified,
      ...(lastActionAt !== undefined ? { lastActionAt } : {}),
      ...(lastActionKind !== undefined && lastActionKind !== null
        ? { lastActionKind }
        : {}),
    },
  });
}

type DomainStores = ReturnType<typeof getProjectDomainStores>;
interface FinalPrevcStepAuthority {
  readonly workflowRevision: number;
  readonly evidenceId: string;
}
type FinalPrevcHandoffAuthority = (
  scope: ProjectExecutionScope,
  missionId: string,
  stepId: string,
) => FinalPrevcStepAuthority | null;

function currentFinalPrevcStepAuthority(
  scope: ProjectExecutionScope,
  missionId: string,
  stepId: string,
): FinalPrevcStepAuthority | null {
  const inspection = inspectGuidedPrevcPostMergeAuthority(scope, missionId);
  if (!inspection.ready) return null;
  inspection.assertCurrentAuthority();
  const workflow =
    getContextWorkflowService(scope).getMissionWorkflow(missionId).workflow;
  if (!workflow) return null;
  return Object.freeze({
    workflowRevision: workflow.revision,
    evidenceId: milestoneValidationEvidenceId(
      missionId,
      stepId,
      workflow.binding,
    ),
  });
}

const MILESTONE_ATTESTATION_ID = /^milestone:[0-9a-f]{64}$/;

function collectFinalPrevcEvidenceIds(
  missionId: string,
  workflowRevision: number | null,
  expectedEvidenceId: string | null,
  handoffs: readonly Handoff[],
): string[] {
  if (workflowRevision === null || expectedEvidenceId === null) return [];
  for (const handoff of handoffs) {
    if (
      handoff.fromAgent !== 'nexus-prevc-autopilot' ||
      handoff.sessionId !== undefined ||
      handoff.workerIncarnationId !== undefined ||
      handoff.mcpProvenance !== undefined ||
      handoff.status !== 'success' ||
      handoff.evidenceTrust !== 'nexus-trusted' ||
      handoff.evidenceBinding?.missionId !== missionId ||
      handoff.evidenceBinding.workflowRevision !== workflowRevision ||
      handoff.evidenceIds.length === 0 ||
      !handoff.evidenceIds.includes(expectedEvidenceId) ||
      handoff.evidenceIds.some(
        (evidenceId) => !MILESTONE_ATTESTATION_ID.test(evidenceId),
      )
    ) {
      continue;
    }
    return [expectedEvidenceId];
  }
  return [];
}

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
  hasFinalPrevcAuthority: FinalPrevcHandoffAuthority =
    currentFinalPrevcStepAuthority,
): ApplyActionPorts {
  const collectTrusted = (
    scope: ProjectExecutionScope,
    missionId: string,
    stepId: string,
  ): string[] => {
    // Worker/agent handoffs may legitimately resolve current Nexus evidence,
    // but they are not completion authority. Only the Main-owned final PREVC
    // receipt, after the exact sealed plan is terminal, may feed Ralph steps.
    const authority = hasFinalPrevcAuthority(scope, missionId, stepId);
    if (!authority) return [];
    return collectFinalPrevcEvidenceIds(
      missionId,
      authority.workflowRevision,
      authority.evidenceId,
      getStores(scope).handoffs.list({
        missionId,
        includeDelivered: true,
      }),
    );
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
      const persisted = actionableMissionPanes(
        stores.missionPanes.list(missionId).filter((pane) => pane.paneId),
      );
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
      if (
        target.role === 'orchestrator' &&
        (!snapshot || snapshot.state === 'exited')
      ) {
        const detail =
          `${DEAD_ORCHESTRATOR_RECOVERY_MARKER}\n` +
          '## Orquestrador encerrou\n' +
          'O provider do orquestrador saiu. O Nexus preservou a missão e não ' +
          'repetiu o kickoff nem pediu ao renderer para inventar uma nova ' +
          `sessão. CTA: ${DEAD_ORCHESTRATOR_RECOVERY_CTA}.`;
        const description = mission.description.includes(
          DEAD_ORCHESTRATOR_RECOVERY_MARKER,
        )
          ? mission.description
          : [mission.description.trim(), detail]
              .filter(Boolean)
              .join('\n\n')
              .slice(0, 65_536);
        stores.missions.update(missionId, {
          status: 'blocked',
          intentState: 'blocked_technical',
          description,
        });
        throw new Error(
          'fresh-context blocked: orchestrator provider exited; ' +
            `CTA: ${DEAD_ORCHESTRATOR_RECOVERY_CTA}`,
        );
      }
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
      const trustedIds = collectTrusted(scope, missionId, stepId);
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
    blockHuman: (missionId, scope, reason) => {
      const stores = getStores(scope);
      const current = stores.missions.get(missionId);
      if (!current) {
        throw new Error(`blockHuman failed for mission ${missionId}: not found`);
      }
      const updated = stores.missions.update(missionId, {
        ...missionBlockPatch('user'),
        description: appendMissionVerdict(
          current.description,
          '<!-- nexus:driver-block-human -->',
          '[NEXUS_DRIVER_BLOCK_HUMAN]',
          reason,
        ),
      });
      if (!updated) {
        throw new Error(`blockHuman failed for mission ${missionId}`);
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
      if (!current) {
        throw new Error(`complete rejected: mission ${missionId} vanished`);
      }
      if (current.status === 'done') {
        if (current.intentState === 'done') return;
        throw new Error(
          'complete rejected: terminal mission has inconsistent intent state',
        );
      }
      if (
        current.milestones.length !== mission.milestones.length ||
        current.milestones.some(
          (step, index) =>
            step.id !== mission.milestones[index]?.id ||
            step.status !== 'done' ||
            step.evidenceIds.length === 0,
        )
      ) {
        throw new Error(
          'complete rejected: milestone authority changed after PREVC proof',
        );
      }
      const updated = stores.missions.completeFromMissionDriver(missionId, {
        expectedUpdatedAt: current.updatedAt,
        expectedIntentVersion: current.intentVersion ?? 0,
      });
      if (!updated) {
        throw new Error(
          `complete rejected: mission completion CAS changed for ${missionId}`,
        );
      }
      if (updated.status !== 'done' || updated.intentState !== 'done') {
        throw new Error(
          `complete rejected: terminal projection failed for ${missionId}`,
        );
      }
    },
    appendLearning: (missionId, scope, entry) => {
      getStores(scope).missions.appendLearning(missionId, entry);
    },
  };
}

/**
 * Missões antigas NÃO ressuscitam sozinhas no boot (achado de operador: "do
 * nada o Nexus recuperou uma missão antiga e iniciou"). O reconcile de boot +
 * modo ativo dava respawn-fresh-context em qualquer missão elegível parada de
 * sessões passadas. Mesma filosofia do restore-agents-gate: o driver só
 * dirige missão com ATIVIDADE nesta sessão do app; retomar uma antiga é
 * decisão explícita do usuário (reabrir/retomar atualiza updatedAt e ela
 * volta a ser elegível).
 */
const driverSessionStartedAt = Date.now();
const driverSkippedStaleLogged = new Set<string>();

export function isMissionDriverSessionEligible(
  mission: { id: string; updatedAt: number },
  sessionStartedAt = driverSessionStartedAt,
): boolean {
  return mission.updatedAt >= sessionStartedAt;
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
    // O driver é o loop com prova de vida nos incidentes; o watchdog de merge
    // estagnado pega carona no batimento dele (além do tick do scheduler).
    reconcileStalledMergeForScope: (scope) => {
      requireWorktreeRuntimeRegistry().reconcileMergeIfStalled(scope);
    },
    recordStallReason: (missionId, scope, reason, at) => {
      getProjectDomainStores(scope).missions.recordDriveStallReason(
        missionId,
        'driver-wait',
        reason,
        at,
      );
    },
    listRunningMissions: (scope) => {
      const suite = getProjectDomainStores(scope);
      return suite.missions
        .list('running')
        .filter((mission) => {
          if (!isMissionDriverSessionEligible(mission)) {
            const key = driveKey(mission.id, scope);
            if (!driverSkippedStaleLogged.has(key)) {
              driverSkippedStaleLogged.add(key);
              console.info(
                `[mission-driver] missão ${mission.id} parada de sessão ` +
                  'anterior — não dirigida; retome-a explicitamente para reativar',
              );
            }
            return false;
          }
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
