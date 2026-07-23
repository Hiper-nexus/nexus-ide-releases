import { app } from 'electron';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  FEATURE_FLAG_IDS,
} from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { listProviderSettings } from '../persistence/provider-config-store';
import {
  hasAvailableAccount,
  listAccounts,
  pickAvailable,
} from '../persistence/account-store';
import { requireQuotaService } from '../quota/quota-service';
import { quotaAvailabilityScore } from '../quota/quota-policy';
import type { ProviderQuotaEntry } from '../../shared/quota-types';
import {
  getContextWorkflowService,
} from '../context/context-workflow-registry';
import { MergeValidationCoordinator } from '../context/merge-validation-coordinator';
import {
  getProjectDomainStores,
  requireProjectDomainStoreRegistry,
} from './project-domain-store-registry';
import {
  requireWorktreeRuntimeRegistry,
  type WorktreeRuntimeRegistry,
} from '../runtime/worktree-runtime-registry';
import {
  INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER,
} from '../runtime/worktree-manager';
import { trustRealMissionCodexProjectPath } from '../real-mission-codex-trust';
import {
  setRealMissionE2ESchedulerReconcile,
  setRealMissionE2ESchedulerTick,
} from '../real-mission-e2e-scheduler-tick';
import {
  spawnPaneAndMaybePrompt,
} from './tool-util';
import { reserveWorkerSpawnSlot } from './tools-panes';
import { countLiveMissionWorkerSlots } from './mission-driver-io';
import {
  createSchedulerRuntimeState,
  runSchedulerTick,
  type SchedulerDispatchRequest,
  type SchedulerRuntimeTask,
} from './mission-scheduler-runtime';
import {
  taskRecordToSchedulerTask,
} from './mission-scheduler-io';
import {
  decodeTaskScheduleDetail,
} from './mission-scheduler-meta';
import {
  assertSealedTaskSchedule,
  resolveSealedWorkerRoute,
  supportsMechanicallyReadOnlyCli,
} from './mission-scheduler-plan';
import {
  TASK_DISPATCH_HEARTBEAT_LEASE_MS,
} from './task-dispatch-lifecycle';
import type { ScopedMissionStore } from './mission-store';
import type { TaskDispatchStore } from './task-dispatch-store';
import {
  MISSION_SCHEDULER_CONCURRENCY_LIMITS,
  runBoundedMissionSchedulerPass,
} from './mission-scheduler-concurrency';

export const MISSION_SCHEDULER_TICK_MS = 5_000;
export const MISSION_SCHEDULER_WORKER_LEASE_POLICY = Object.freeze({
  claimLeaseMs: TASK_DISPATCH_HEARTBEAT_LEASE_MS,
  heartbeatIntervalMs: 4 * 60_000,
});

export function missionAccountQuotaScores(
  adapterId: string,
  entries: readonly ProviderQuotaEntry[],
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const entry of entries) {
    if (entry.adapterId !== adapterId || !entry.accountId) continue;
    scores.set(entry.accountId, quotaAvailabilityScore(entry));
  }
  return scores;
}

async function resolveMissionSpawnAccountId(
  adapterId: string,
): Promise<string | undefined> {
  if (listAccounts(adapterId).length === 0) return undefined;
  let scores: ReadonlyMap<string, number> | undefined;
  try {
    const snapshot = await requireQuotaService().snapshot();
    const measured = missionAccountQuotaScores(adapterId, snapshot.entries);
    if (measured.size > 0) scores = measured;
  } catch {
    // Quota is an optimization signal. Cooldown/credential enforcement still
    // runs in account-store when the optional service is unavailable at boot.
  }
  const selected = pickAvailable(adapterId, null, Date.now(), scores);
  if (!selected) {
    throw new Error(
      `quota_unavailable: nenhuma conta ${adapterId} está apta para o worker`,
    );
  }
  return selected.id;
}

interface MissionSchedulerOptions {
  readonly listScopes: () => readonly ProjectExecutionScope[];
  readonly now?: () => number;
}

const states = new Map<string, ReturnType<typeof createSchedulerRuntimeState>>();
const merging = new Set<string>();
let configured: MissionSchedulerOptions | null = null;
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight: Promise<void> | null = null;
let started = false;
let externalReconcileRequest: (() => boolean) | null = null;

function missionKey(scope: ProjectExecutionScope, missionId: string): string {
  return `${scope.projectId}:${scope.checkoutId}:${missionId}`;
}

export function missionSchedulerHasKickoffAuthority(
  missions: Pick<ScopedMissionStore, 'hasCurrentKickoffAcceptance'>,
  missionId: string,
): boolean {
  return missions.hasCurrentKickoffAcceptance(missionId);
}

export async function validateMissionMergeWithLifecycleFence<T>(input: {
  readonly assertCurrentAuthority: () => void;
  readonly validate: () => Promise<T> | T;
}): Promise<T> {
  input.assertCurrentAuthority();
  const result = await input.validate();
  // The validation may run sensors/reviewers for minutes. The synchronous
  // recheck after its final await is the last main-thread step before
  // MergeQueue performs the Git CAS.
  input.assertCurrentAuthority();
  return result;
}

export function buildMissionSchedulerTaskPrompt(
  task: SchedulerRuntimeTask & { readonly title?: string; readonly detail?: string },
  worker: {
    readonly agentName: string;
    readonly category: string;
    readonly executionMode: 'isolated_worktree' | 'read_only';
  },
): string {
  const heartbeatMinutes =
    MISSION_SCHEDULER_WORKER_LEASE_POLICY.heartbeatIntervalMs / 60_000;
  const detail = task.detail?.trim() || 'Execute a tarefa conforme o contrato da missão.';
  const completionContract = worker.executionMode === 'read_only'
    ? 'Esta tarefa é SOMENTE LEITURA: não edite arquivos, não execute comandos mutantes, ' +
      'não faça commit. Inspecione, reúna evidências Nexus confiáveis e chame ' +
      'nexus_handoff_submit. O dispatcher Nexus valida e conclui.'
    : 'Ao finalizar, execute os checks, faça somente um commit LOCAL no worktree e chame ' +
      'nexus_handoff_submit com a evidência. Não altere o status da task, não faça merge ' +
      'e nunca faça push: o dispatcher Nexus é a autoridade dessas transições.';
  return [
    `Você é ${worker.agentName}, worker ${worker.category} do roster selado do Nexus Scheduler.`,
    `Task ID: ${task.id}`,
    `Title: ${task.title ?? task.id}`,
    `Ownership: ${JSON.stringify(task.ownership)}`,
    `Dependencies: ${JSON.stringify(task.dependsOn)}`,
    '',
    detail,
    '',
    'Trabalhe somente dentro do ownership declarado. Em tarefas longas, chame ' +
      `nexus_worker_heartbeat no máximo a cada ${heartbeatMinutes} minutos.`,
    completionContract,
  ].join('\n');
}

function activeWorkers(
  scope: ProjectExecutionScope,
  missionId: string,
): readonly { readonly taskId: string; readonly ownership: SchedulerRuntimeTask['ownership'] }[] {
  const durable = getProjectDomainStores(scope).taskDispatches
    .list(missionId)
    .filter((record) => [
      'claimed', 'routed', 'spawning', 'running', 'handoff_ready', 'merging',
    ].includes(record.state))
    .map((record) => ({ taskId: record.taskId, ownership: record.ownership }));
  const durableIds = new Set(durable.map((record) => record.taskId));
  const worktrees = requireWorktreeRuntimeRegistry()
    .listMission(scope, missionId)
    .filter((record) => record.status === 'ready' || record.status === 'queued')
    .filter((record) => !durableIds.has(record.taskId))
    .map((record) => ({ taskId: record.taskId, ownership: record.ownership }));
  return [...durable, ...worktrees];
}

type WorktreeCreationFailureDispatchAuthority = Pick<
  TaskDispatchStore,
  'get' | 'list' | 'blockWorktreeCreationFailureByCoordinator'
>;

interface WorktreeCreationFailureReconciliationDeps {
  readonly registry: Pick<WorktreeRuntimeRegistry, 'get'>;
  readonly getDispatches: (
    scope: ProjectExecutionScope,
  ) => WorktreeCreationFailureDispatchAuthority;
}

/**
 * Startup worktree recovery runs before this projection. If exact Git identity
 * could not be proved, converge the still-pre-spawn claim immediately instead
 * of waiting for its ordinary ten-minute worker lease to expire.
 */
export function reconcileInterruptedWorktreeReservationFailuresForScope(
  scope: ProjectExecutionScope,
  dependencies?: WorktreeCreationFailureReconciliationDeps,
): number {
  const deps = dependencies ?? {
    registry: requireWorktreeRuntimeRegistry(),
    getDispatches: (currentScope: ProjectExecutionScope) =>
      getProjectDomainStores(currentScope).taskDispatches,
  };
  const dispatches = deps.getDispatches(scope);
  let projected = 0;
  for (const dispatch of dispatches.list()) {
    if (dispatch.state !== 'claimed') continue;
    const worktree = deps.registry.get(
      scope,
      dispatch.missionId,
      dispatch.taskId,
    );
    if (
      worktree?.status !== 'failed' ||
      !worktree.failureReason?.startsWith(
        INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER,
      )
    ) {
      continue;
    }
    try {
      dispatches.blockWorktreeCreationFailureByCoordinator({
        taskId: dispatch.taskId,
        revision: dispatch.revision,
        reason:
          'Falha terminal de criação do worktree após restart: ' +
          worktree.failureReason.slice(
            INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER.length,
          ).trim(),
      });
      projected += 1;
    } catch (error) {
      const current = dispatches.get(dispatch.taskId);
      if (current?.state === 'blocked') continue;
      throw error;
    }
  }
  return projected;
}

type MergeTerminalDispatchAuthority = Pick<
  TaskDispatchStore,
  'get' | 'blockMergeFailureByCoordinator'
>;

interface MergeTerminalReconciliationDeps {
  readonly registry: Pick<
    WorktreeRuntimeRegistry,
    'reconcile' | 'mergeSnapshot'
  >;
  readonly getDispatches: (
    scope: ProjectExecutionScope,
  ) => MergeTerminalDispatchAuthority;
}

function terminalMergeFailureReason(reason: string): string {
  const detail = reason.trim().slice(0, 60_000) ||
    'o coordenador não obteve prova válida da integração';
  return (
    `Falha terminal de merge: ${detail} ` +
    'A integração não foi aceita e exige revisão explícita.'
  ).slice(0, 65_536);
}

/**
 * Projects an already-terminal merge effect into the SQLite mission authority.
 * Completed receipts are deliberately immutable; only the current pre-receipt
 * merge states may cross this boundary.
 */
export function projectTerminalMergeFailure(
  input: {
    readonly missionId: string;
    readonly taskId: string;
    readonly reason: string;
  },
  dispatches: MergeTerminalDispatchAuthority,
): boolean {
  const current = dispatches.get(input.taskId);
  if (!current) return false;
  if (current.missionId !== input.missionId) {
    throw new Error(
      `merge terminal ${input.taskId} pertence a outra missão`,
    );
  }
  if (current.state === 'blocked' || current.state === 'completed') return false;
  if (!['handoff_ready', 'merging'].includes(current.state)) return false;
  dispatches.blockMergeFailureByCoordinator({
    taskId: input.taskId,
    revision: current.revision,
    reason: terminalMergeFailureReason(input.reason),
  });
  return true;
}

/**
 * Restart projection runs inside the existing mission-scheduler participant.
 * MergeQueue remains the Git authority; this closes its durable blocked result
 * into dispatch/task/mission state without introducing another timer or loop.
 */
export function reconcileTerminalMergeFailureForScope(
  scope: ProjectExecutionScope,
  dependencies?: MergeTerminalReconciliationDeps,
): boolean {
  const deps = dependencies ?? {
    registry: requireWorktreeRuntimeRegistry(),
    getDispatches: (currentScope: ProjectExecutionScope) =>
      getProjectDomainStores(currentScope).taskDispatches,
  };
  const reconciliation = deps.registry.reconcile(scope);
  if (reconciliation.action === 'none') return false;
  const snapshot = deps.registry.mergeSnapshot(scope);
  const blockedTaskKey =
    reconciliation.taskKey ?? snapshot.blocked?.taskKey;
  if (!blockedTaskKey) return false;
  const entry = snapshot.entries.find(
    (candidate) => candidate.taskKey === blockedTaskKey,
  );
  if (!entry || entry.status !== 'blocked') {
    throw new Error(
      `merge queue bloqueada sem entry terminal: ${blockedTaskKey}`,
    );
  }
  const reason =
    snapshot.blocked?.taskKey === blockedTaskKey
      ? snapshot.blocked.reason
      : entry.failureReason;
  return projectTerminalMergeFailure(
    {
      missionId: entry.missionId,
      taskId: entry.taskId,
      reason:
        reason ??
        'o merge persistido foi interrompido e não possui prova de integração',
    },
    deps.getDispatches(scope),
  );
}

function schedulerTasks(
  scope: ProjectExecutionScope,
  missionId: string,
): readonly SchedulerRuntimeTask[] {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  const intentVersion = mission?.intentContract?.intentVersion;
  if (intentVersion === undefined) return [];
  const dispatches = new Map(
    stores.taskDispatches.list(missionId).map((record) => [record.taskId, record]),
  );
  // Only the immutable receipt is schedulable. Ad-hoc task rows are never
  // allowed to leak into an approved mission's worker queue.
  return stores.tasks.listPlannedTasks(missionId, intentVersion).map((planned) => {
    const mapped = taskRecordToSchedulerTask(planned.task);
    const dispatch = dispatches.get(planned.taskId);
    return {
      ...mapped,
      // A dependency advances only after the durable coordinator receipt.
      // `worktree.status=integrated` alone is an incomplete crash window.
      merged: dispatch?.state === 'completed',
    };
  });
}

async function dispatchTask(
  scope: ProjectExecutionScope,
  missionId: string,
  request: SchedulerDispatchRequest,
): Promise<void> {
  const { taskId } = request;
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission?.intentContract) {
    throw new Error('scheduler dispatch requires an approved mission contract');
  }
  if (!missionSchedulerHasKickoffAuthority(stores.missions, missionId)) {
    throw new Error(
      'kickoff_not_accepted: o scheduler exige recibo durável idle→busy ' +
        'da sessão orquestradora atual',
    );
  }
  const planned = stores.tasks.getPlannedTask(taskId);
  if (
    !planned ||
    planned.missionId !== missionId ||
    planned.intentVersion !== mission.intentContract.intentVersion
  ) {
    throw new Error(`task ${taskId} não pertence ao plano selado da intenção atual`);
  }
  const task = planned.task;
  const decoded = decodeTaskScheduleDetail(task.detail);
  assertSealedTaskSchedule(planned, decoded.meta);
  const meta = decoded.meta;
  const mapped = taskRecordToSchedulerTask(task);
  if (
    JSON.stringify(request.ownership) !== JSON.stringify(meta.ownership) ||
    JSON.stringify(request.dependsOn) !== JSON.stringify(meta.dependsOn)
  ) {
    throw new Error(`scheduler request ${taskId} divergiu do plano selado`);
  }
  const executionMode = meta.executionMode;
  const taskText = `${task.title}\n${decoded.body}`;
  const adapters = listProviderSettings()
    .filter((provider) => provider.adapterId !== 'shell')
    .map((provider) => ({
      id: provider.adapterId,
      installed:
        provider.enabled &&
        provider.installed &&
        provider.authStrategy !== 'login-needed' &&
        hasAvailableAccount(provider.adapterId),
      models: {
        list: provider.models,
        default: provider.defaultModel,
      },
    }));
  const sealedRoute = resolveSealedWorkerRoute({
    taskText,
    agent: planned.agent,
    adapters,
    rosterHash: planned.rosterHash,
  });
  const accountId = await resolveMissionSpawnAccountId(
    sealedRoute.decision.adapterId,
  );
  if (
    executionMode === 'read_only' &&
    !supportsMechanicallyReadOnlyCli(sealedRoute.decision.adapterId)
  ) {
    throw new Error(
      `read_only_unsupported: ${sealedRoute.decision.adapterId} não oferece ` +
        'uma barreira mecânica de escrita verificada; ' +
        'replaneje com uma CLI que suporte sandbox read-only verificado',
    );
  }
  const workflow = getContextWorkflowService(scope);
  // PREVC is additive: once a frozen workflow exists it must be at execution,
  // but absence of an optional freeze cannot turn an approved mission into a
  // deadlock. The worker is still isolated by its sealed worktree contract.
  if (workflow.getMissionWorkflow(missionId).contract) {
    workflow.assertMutationAllowed(missionId, 'nexus_mission_spawn_pane', {});
  }
  const workerId = planned.agent.agentName;
  const plannedAllowedTools = planned.agent.allowedTools ?? [];
  const activeWithoutPane = stores.taskDispatches
    .list(missionId)
    .filter((record) => [
      'claimed', 'routed', 'spawning', 'running', 'handoff_ready', 'merging',
    ].includes(record.state) && !record.sessionId).length;
  const reservation = reserveWorkerSpawnSlot({
    scope,
    missionId,
    contract: mission.intentContract,
    // Só workers VIVOS ocupam slot (linha durável de worker morto não conta).
    currentWorkerCount:
      countLiveMissionWorkerSlots(
        scope,
        missionId,
        stores.missionPanes.list(missionId),
      ).live + activeWithoutPane,
    allowedTools: plannedAllowedTools,
  });
  if (!reservation.ok) throw new Error(reservation.error);

  let worktreeCreated = false;
  let dispatchLeaseToken: string | null = null;
  let dispatchRevision: number | null = null;
  try {
    const claim = stores.taskDispatches.claim({
      missionId,
      taskId,
      intentVersion: mission.intentContract.intentVersion,
      workerId,
      leaseOwner: 'main-orchestration-coordinator',
      leaseMs: MISSION_SCHEDULER_WORKER_LEASE_POLICY.claimLeaseMs,
      maxWorkers: mission.intentContract.budgets.maxWorkers,
      ownership: mapped.ownership,
      executionMode,
      agentRef: planned.agentRef,
      agentCategory: meta.agentCategory,
      rosterHash: planned.rosterHash,
      routeContract: sealedRoute.routeContract,
    });
    dispatchLeaseToken = claim.leaseToken;
    dispatchRevision = claim.revision;
    const worktree = executionMode === 'isolated_worktree'
      ? requireWorktreeRuntimeRegistry().create({
          scope,
          missionId,
          taskId,
          workerId,
          ownership: mapped.ownership,
          dependsOn: mapped.dependsOn.map((dependencyId) => ({
            missionId,
            taskId: dependencyId,
          })),
        })
      : null;
    worktreeCreated = worktree !== null;
    const executionRoot = worktree?.worktreePath ?? scope.rootRealPath;
    if (worktree?.worktreePath) {
      try {
        trustRealMissionCodexProjectPath(
          app.getPath('userData'),
          worktree.worktreePath,
        );
      } catch {
        // Exact Codex project trust is best-effort for the release gate only.
      }
    }
    const routeReservation = stores.missions.reserveRouteDecision(
      missionId,
      taskText,
      sealedRoute.decision,
    );
    const routedDispatch = stores.taskDispatches.attachRoute({
      taskId,
      revision: dispatchRevision,
      leaseToken: dispatchLeaseToken,
      routeReservationId: routeReservation.id,
      ...sealedRoute.routeContract,
    });
    dispatchRevision = routedDispatch.revision;
    const spawningDispatch = stores.taskDispatches.markSpawning({
      taskId,
      revision: dispatchRevision,
      leaseToken: dispatchLeaseToken,
    });
    dispatchRevision = spawningDispatch.revision;
    stores.missions.consumeRouteReservation(
      {
        reservationId: routeReservation.id,
        missionId,
        ...sealedRoute.routeContract,
      },
      `dispatch:${claim.id}`,
    );
    await spawnPaneAndMaybePrompt({
      adapterId: sealedRoute.routeContract.adapterId,
      accountId,
      model: sealedRoute.routeContract.model,
      effort: sealedRoute.routeContract.effort,
      cwd: executionRoot,
      executionScope: Object.freeze({ ...scope, rootRealPath: executionRoot }),
      scope,
      missionId,
      agentName: planned.agent.agentName,
      workerIncarnationId: claim.workerIncarnationId,
      agentCategory: meta.agentCategory,
      role: 'worker',
      title: task.title,
      prompt: buildMissionSchedulerTaskPrompt(
        { ...mapped, title: task.title, detail: decoded.body },
        {
          agentName: planned.agent.agentName,
          category: meta.agentCategory,
          executionMode,
        },
      ),
      allowedTools: [...(reservation.allowedTools ?? plannedAllowedTools)],
      allowedSkills: planned.agent.allowedSkills === null || planned.agent.allowedSkills === undefined
        ? null
        : [...planned.agent.allowedSkills],
      readOnly: executionMode === 'read_only',
      suppressOmpAutoSpawn: true,
    }, {
      onPaneCreated: (paneId, sessionId) => {
        if (!dispatchLeaseToken || dispatchRevision === null) return;
        const bound = stores.taskDispatches.bindSpawn({
          taskId,
          revision: dispatchRevision,
          leaseToken: dispatchLeaseToken,
          workerIncarnationId: claim.workerIncarnationId,
          paneId,
          sessionId,
        });
        dispatchRevision = bound.revision;
      },
    });
  } catch (error) {
    if (worktreeCreated) {
      try {
        requireWorktreeRuntimeRegistry().markFailed(
          scope,
          missionId,
          taskId,
          error instanceof Error ? error.message : String(error),
        );
      } catch (markError) {
        console.error('[mission-scheduler] failed to mark dispatch failure:', markError);
      }
    }
    if (dispatchLeaseToken) {
      try {
        const current = stores.taskDispatches.get(taskId);
        if (current && ![
          'completed', 'blocked', 'failed', 'suspended', 'superseded',
        ].includes(current.state)) {
          stores.taskDispatches.fail({
            taskId,
            revision: current.revision,
            leaseToken: dispatchLeaseToken,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } catch (dispatchError) {
        console.error('[mission-scheduler] failed to persist dispatch failure:', dispatchError);
      }
    }
    throw error;
  } finally {
    reservation.release();
  }
}

async function mergeCompletedTask(
  scope: ProjectExecutionScope,
  missionId: string,
  taskId: string,
): Promise<void> {
  const key = missionKey(scope, missionId) + `:${taskId}`;
  if (merging.has(key)) return;
  const worktree = requireWorktreeRuntimeRegistry().get(scope, missionId, taskId);
  if (!worktree) return;
  const domainStores = getProjectDomainStores(scope);
  let dispatch = domainStores.taskDispatches.get(taskId);
  if (!dispatch || !['handoff_ready', 'merging'].includes(dispatch.state)) return;
  const mergeIntentVersion = dispatch.intentVersion;
  if (worktree.status === 'integrated') {
    const mergeEntry = requireWorktreeRuntimeRegistry()
      .mergeSnapshot(scope)
      .entries.find((entry) =>
        entry.missionId === missionId &&
        entry.taskId === taskId &&
        ['finalizing', 'integrated'].includes(entry.status) &&
        Boolean(entry.integratedSha),
    );
    if (!mergeEntry?.integratedSha) return;
    domainStores.taskDispatches.assertLifecycleAuthority({
      taskId,
      missionId,
      intentVersion: mergeIntentVersion,
      expectedStates: ['handoff_ready', 'merging'],
    });
    domainStores.taskDispatches.completeByCoordinator({
      taskId,
      revision: dispatch.revision,
      receipt: {
        kind: 'worktree_integrated',
        reference: mergeEntry.integratedSha,
        completedAt: Date.now(),
        evidenceIds: [...mergeEntry.evidenceIds],
      },
    });
    return;
  }
  if (worktree.status === 'failed') {
    projectTerminalMergeFailure(
      {
        missionId,
        taskId,
        reason:
          worktree.failureReason ??
          'o worktree de integração entrou em estado failed sem receipt',
      },
      domainStores.taskDispatches,
    );
    return;
  }
  if (worktree.status !== 'ready' && worktree.status !== 'queued') return;
  merging.add(key);
  try {
    if (dispatch.state === 'handoff_ready') {
      dispatch = domainStores.taskDispatches.beginMerge({
        taskId,
        revision: dispatch.revision,
      });
    }
    let finalizedIntegrationReference: string | null = null;
    const assertCurrentMergeAuthority = () => {
      const current = getProjectDomainStores(scope)
        .taskDispatches.assertLifecycleAuthority({
          taskId,
          missionId,
          intentVersion: mergeIntentVersion,
          expectedStates: finalizedIntegrationReference
            ? ['completed']
            : ['merging'],
        });
      if (
        finalizedIntegrationReference &&
        (
          current.integrationReceipt?.kind !== 'worktree_integrated' ||
          current.integrationReceipt.reference !== finalizedIntegrationReference
        )
      ) {
        throw new Error(
          'receipt final divergiu da integração autorizada pelo merge queue',
        );
      }
    };
    assertCurrentMergeAuthority();
    const service = getContextWorkflowService(scope);
    const validator = new MergeValidationCoordinator(service);
    await requireWorktreeRuntimeRegistry().enqueue({
      scope,
      missionId,
      taskId,
      assertCurrentAuthority: assertCurrentMergeAuthority,
      validate: (context) => validator.validate(context),
      finalize: (result) => {
        const finalStores = getProjectDomainStores(scope);
        assertCurrentMergeAuthority();
        const currentDispatch = finalStores.taskDispatches.get(taskId);
        if (currentDispatch?.state === 'handoff_ready' || currentDispatch?.state === 'merging') {
          finalStores.taskDispatches.completeByCoordinator({
            taskId,
            revision: currentDispatch.revision,
            receipt: {
              kind: 'worktree_integrated',
              reference: result.integratedSha,
              completedAt: Date.now(),
              evidenceIds: [...result.evidenceIds],
            },
          });
          finalizedIntegrationReference = result.integratedSha;
        }
      },
    });
  } catch (error) {
    projectTerminalMergeFailure(
      {
        missionId,
        taskId,
        reason: error instanceof Error ? error.message : String(error),
      },
      getProjectDomainStores(scope).taskDispatches,
    );
    console.warn(`[mission-scheduler] merge deferred for ${missionId}/${taskId}:`, error);
  } finally {
    merging.delete(key);
  }
}

async function tickMission(scope: ProjectExecutionScope, missionId: string): Promise<void> {
  const stores = getProjectDomainStores(scope);
  // Nothing downstream—merge, spawn or mission completion—may advance before
  // the finite idle→busy kickoff proof commits for the current revision and
  // physical orchestrator session. The mission-store change wakes this tick.
  if (!missionSchedulerHasKickoffAuthority(stores.missions, missionId)) return;
  const dispatches = stores.taskDispatches.list(missionId);
  for (const dispatch of dispatches) {
    if (!['handoff_ready', 'merging'].includes(dispatch.state)) continue;
    if (dispatch.executionMode === 'same_checkout' && dispatch.state === 'handoff_ready') {
      stores.taskDispatches.blockUnvalidatedByCoordinator({
        taskId: dispatch.taskId,
        revision: dispatch.revision,
        reason:
          'same_checkout legado não possui baseline/diff atribuível; ' +
          'replaneje com ownership e worktree isolado.',
      });
      continue;
    }
    if (dispatch.executionMode === 'read_only' && dispatch.state === 'handoff_ready') {
      try {
        stores.taskDispatches.completeReadOnlyFromTrustedHandoff({
          taskId: dispatch.taskId,
          revision: dispatch.revision,
        });
      } catch (error) {
        stores.taskDispatches.blockUnvalidatedByCoordinator({
          taskId: dispatch.taskId,
          revision: dispatch.revision,
          reason:
            'Handoff read-only não possui evidência Nexus confiável e atual. ' +
            (error instanceof Error ? error.message : String(error)),
        });
      }
      continue;
    }
    await mergeCompletedTask(scope, missionId, dispatch.taskId);
  }
  const key = missionKey(scope, missionId);
  const state = states.get(key) ?? createSchedulerRuntimeState();
  const result = await runSchedulerTick(
    {
      isParallelSchedulerEnabled: () =>
        getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.parallelScheduler),
      listTasks: () => schedulerTasks(scope, missionId),
      listActiveWorkers: () => activeWorkers(scope, missionId),
      scheduleConfig: () => ({ configuredCap: 4, cores: 8, paneBudget: 8 }),
      now: () => configured?.now?.() ?? Date.now(),
      dispatchTask: (request) => dispatchTask(scope, missionId, request),
      getChangedFiles: async () => [],
      mergeTask: async () => undefined,
      markMerged: async () => undefined,
      markFailed: async (taskId, reason) => {
        const currentMission = stores.missions.get(missionId);
        const intentVersion = currentMission?.intentContract?.intentVersion;
        if (intentVersion === undefined) return;
        stores.taskDispatches.blockBeforeClaim({
          missionId,
          taskId,
          intentVersion,
          reason,
        });
      },
      reRunSequentially: async () => undefined,
    },
    state,
  );
  states.set(key, result.state);
  const currentMission = stores.missions.get(missionId);
  const currentIntentVersion = currentMission?.intentContract?.intentVersion;
  if (currentMission?.status === 'running' && currentIntentVersion !== undefined) {
    stores.taskDispatches.completeMissionFromVerifiedPlan({
      missionId,
      intentVersion: currentIntentVersion,
    });
  }
}

async function tick(): Promise<void> {
  if (!configured) return;
  await runBoundedMissionSchedulerPass({
    scopes: configured.listScopes(),
    scopeConcurrency: MISSION_SCHEDULER_CONCURRENCY_LIMITS.scopes,
    missionConcurrency:
      MISSION_SCHEDULER_CONCURRENCY_LIMITS.missionsPerScope,
    reconcileScope: (scope) => {
      reconcileInterruptedWorktreeReservationFailuresForScope(scope);
      reconcileTerminalMergeFailureForScope(scope);
    },
    listMissions: (scope) =>
      getProjectDomainStores(scope).missions.list('running'),
    runMission: async (scope, mission) => {
      try {
        await tickMission(scope, mission.id);
      } catch (error) {
        console.warn(`[mission-scheduler] tick failed for ${mission.id}:`, error);
      }
    },
  });
}

export function requestMissionSchedulerTick(): void {
  if (externalReconcileRequest) {
    externalReconcileRequest();
    return;
  }
  if (!started || tickInFlight) return;
  tickInFlight = tick().finally(() => {
    tickInFlight = null;
  });
}

export function setMissionSchedulerReconcileRequest(
  request: (() => boolean) | null,
): void {
  externalReconcileRequest = request;
}

/** One single-flight pass for the main-owned orchestration coordinator. */
export async function reconcileMissionScheduler(): Promise<void> {
  if (!configured) return;
  if (!tickInFlight) {
    tickInFlight = tick().finally(() => {
      tickInFlight = null;
    });
  }
  await tickInFlight;
}

export function configureMissionScheduler(options: MissionSchedulerOptions): void {
  disposeMissionScheduler();
  configured = options;
  // Wire release-gate main-owned completion without a static import cycle.
  setRealMissionE2ESchedulerTick(requestMissionSchedulerTick);
  setRealMissionE2ESchedulerReconcile(reconcileMissionScheduler);
  unsubscribe = requireProjectDomainStoreRegistry().onChange((_scope, store) => {
    if (
      store === 'tasks' ||
      store === 'task-dispatches' ||
      store === 'handoffs' ||
      store === 'missions' ||
      store === 'mission-panes'
    ) {
      requestMissionSchedulerTick();
    }
  });
}

export function startMissionSchedulerLoop(): void {
  if (started) return;
  started = true;
  timer = setInterval(requestMissionSchedulerTick, MISSION_SCHEDULER_TICK_MS);
  timer.unref?.();
  requestMissionSchedulerTick();
}

export function stopMissionSchedulerLoop(): void {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
}

export function disposeMissionScheduler(): void {
  stopMissionSchedulerLoop();
  unsubscribe?.();
  unsubscribe = null;
  configured = null;
  externalReconcileRequest = null;
  setRealMissionE2ESchedulerTick(null);
  setRealMissionE2ESchedulerReconcile(null);
  states.clear();
  merging.clear();
}
