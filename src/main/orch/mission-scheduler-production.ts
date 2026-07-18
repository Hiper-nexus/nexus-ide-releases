import type { ProjectExecutionScope } from '../../shared/types';
import {
  FEATURE_FLAG_IDS,
} from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { getOrchSettings } from '../persistence/settings-store';
import { listAdapterInfos } from '../adapters/adapter-registry';
import { loadAdaptersHot } from '../adapters/adapter-hot-cache';
import { routeTask } from './task-router';
import { buildOmpRouteContext } from './omp-roster-policy';
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
} from '../runtime/worktree-runtime-registry';
import {
  spawnPaneAndMaybePrompt,
} from './tool-util';
import { reserveWorkerSpawnSlot } from './tools-panes';
import { countLiveMissionWorkerSlots } from './mission-driver-io';
import {
  createSchedulerRuntimeState,
  runSchedulerTick,
  type SchedulerRuntimeTask,
} from './mission-scheduler-runtime';
import {
  taskRecordToSchedulerTask,
} from './mission-scheduler-io';
import {
  decodeTaskScheduleDetail,
  withMergedFlag,
} from './mission-scheduler-meta';

export const MISSION_SCHEDULER_TICK_MS = 5_000;

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

function missionKey(scope: ProjectExecutionScope, missionId: string): string {
  return `${scope.projectId}:${scope.checkoutId}:${missionId}`;
}

function workerIdForTask(taskId: string): string {
  return `nexus-scheduler-${taskId}`;
}

function taskPrompt(
  task: SchedulerRuntimeTask & { readonly title?: string; readonly detail?: string },
): string {
  const detail = task.detail?.trim() || 'Execute a tarefa conforme o contrato da missão.';
  return [
    'Você é um worker executor do Nexus Scheduler.',
    `Task ID: ${task.id}`,
    `Title: ${task.title ?? task.id}`,
    `Ownership: ${JSON.stringify(task.ownership)}`,
    `Dependencies: ${JSON.stringify(task.dependsOn)}`,
    '',
    detail,
    '',
    'Trabalhe somente dentro do ownership declarado. Ao finalizar, execute os checks da tarefa, marque o task como done usando nexus_task e envie o handoff. Não faça commit ou push fora do fluxo Nexus.',
  ].join('\n');
}

function activeWorkers(
  scope: ProjectExecutionScope,
  missionId: string,
): readonly { readonly taskId: string; readonly ownership: SchedulerRuntimeTask['ownership'] }[] {
  return requireWorktreeRuntimeRegistry()
    .listMission(scope, missionId)
    .filter((record) => record.status === 'ready' || record.status === 'queued')
    .map((record) => ({ taskId: record.taskId, ownership: record.ownership }));
}

function schedulerTasks(
  scope: ProjectExecutionScope,
  missionId: string,
): readonly SchedulerRuntimeTask[] {
  const stores = getProjectDomainStores(scope);
  const integrated = new Set(
    requireWorktreeRuntimeRegistry()
      .listMission(scope, missionId)
      .filter((record) => record.status === 'integrated')
      .map((record) => record.taskId),
  );
  return stores.tasks.list(missionId).map((record) => {
    const mapped = taskRecordToSchedulerTask(record);
    return {
      ...mapped,
      merged: mapped.merged || integrated.has(record.id),
    };
  });
}

async function dispatchTask(
  scope: ProjectExecutionScope,
  missionId: string,
  taskId: string,
): Promise<void> {
  const stores = getProjectDomainStores(scope);
  const task = stores.tasks.list(missionId).find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`scheduler task not found: ${taskId}`);
  const mission = stores.missions.get(missionId);
  if (!mission?.intentContract) {
    throw new Error('scheduler dispatch requires an approved mission contract');
  }
  const workflow = getContextWorkflowService(scope);
  workflow.assertMutationAllowed(missionId, 'nexus_mission_spawn_pane', {});
  const mapped = taskRecordToSchedulerTask(task);
  const workerId = workerIdForTask(taskId);
  const reservation = reserveWorkerSpawnSlot({
    scope,
    missionId,
    contract: mission.intentContract,
    // Só workers VIVOS ocupam slot (linha durável de worker morto não conta).
    currentWorkerCount: countLiveMissionWorkerSlots(
      scope,
      missionId,
      stores.missionPanes.list(missionId),
    ).live,
    allowedTools: null,
  });
  if (!reservation.ok) throw new Error(reservation.error);

  let worktreeCreated = false;
  try {
    const worktree = requireWorktreeRuntimeRegistry().create({
      scope,
      missionId,
      taskId,
      workerId,
      ownership: mapped.ownership,
      dependsOn: mapped.dependsOn.map((dependencyId) => ({
        missionId,
        taskId: dependencyId,
      })),
    });
    worktreeCreated = true;
    const settings = getOrchSettings();
    const missionUsedAdapters = stores.missionPanes
      .list(missionId)
      .map((pane) => pane.adapterId)
      .filter(Boolean);
    const routed = routeTask(
      `${task.title}\n${decodeTaskScheduleDetail(task.detail).body}`,
      loadAdaptersHot(() => listAdapterInfos()).map((adapter) => ({
        id: adapter.id,
        installed: adapter.installed,
        models: adapter.models.list,
      })),
      undefined,
      undefined,
      true,
      undefined,
      buildOmpRouteContext({
        ompParticipation: settings.ompParticipation,
        missionAdapterIds: missionUsedAdapters,
      }),
    );
    const adapterId = routed?.adapterId ?? settings.defaultAdapterId;
    await spawnPaneAndMaybePrompt({
      adapterId,
      model: routed?.model ?? (settings.defaultModel || undefined),
      effort: routed?.effort,
      cwd: worktree.worktreePath,
      executionScope: Object.freeze({ ...scope, rootRealPath: worktree.worktreePath }),
      scope,
      missionId,
      agentName: workerId,
      role: 'worker',
      title: task.title,
      prompt: taskPrompt({ ...mapped, title: task.title, detail: decodeTaskScheduleDetail(task.detail).body }),
      allowedTools: reservation.allowedTools ?? null,
      allowedSkills: null,
    });
    stores.tasks.update(taskId, { status: 'running' });
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
  if (!worktree || worktree.status !== 'ready') return;
  merging.add(key);
  try {
    const service = getContextWorkflowService(scope);
    const validator = new MergeValidationCoordinator(service);
    await requireWorktreeRuntimeRegistry().enqueue({
      scope,
      missionId,
      taskId,
      validate: (context) => validator.validate(context),
      finalize: () => {
        const task = getProjectDomainStores(scope).tasks.list(missionId)
          .find((candidate) => candidate.id === taskId);
        if (!task) throw new Error(`scheduler merge task disappeared: ${taskId}`);
        getProjectDomainStores(scope).tasks.update(taskId, {
          status: 'done',
          detail: withMergedFlag(task.detail, true),
        });
      },
    });
  } catch (error) {
    console.warn(`[mission-scheduler] merge deferred for ${missionId}/${taskId}:`, error);
  } finally {
    merging.delete(key);
  }
}

async function tickMission(scope: ProjectExecutionScope, missionId: string): Promise<void> {
  const stores = getProjectDomainStores(scope);
  const tasks = stores.tasks.list(missionId);
  for (const task of tasks) {
    if (task.status === 'done') await mergeCompletedTask(scope, missionId, task.id);
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
      dispatchTask: (request) => dispatchTask(scope, missionId, request.taskId),
      getChangedFiles: async () => [],
      mergeTask: async () => undefined,
      markMerged: async () => undefined,
      markFailed: async (taskId, reason) => {
        stores.tasks.update(taskId, { status: 'failed', detail: reason });
      },
      reRunSequentially: async () => undefined,
    },
    state,
  );
  states.set(key, result.state);
}

async function tick(): Promise<void> {
  if (!configured) return;
  for (const scope of configured.listScopes()) {
    const missions = getProjectDomainStores(scope).missions.list('running');
    for (const mission of missions) {
      try {
        await tickMission(scope, mission.id);
      } catch (error) {
        console.warn(`[mission-scheduler] tick failed for ${mission.id}:`, error);
      }
    }
  }
}

export function requestMissionSchedulerTick(): void {
  if (!started || tickInFlight) return;
  tickInFlight = tick().finally(() => {
    tickInFlight = null;
  });
}

export function configureMissionScheduler(options: MissionSchedulerOptions): void {
  disposeMissionScheduler();
  configured = options;
  unsubscribe = requireProjectDomainStoreRegistry().onChange((_scope, store) => {
    if (store === 'tasks' || store === 'missions' || store === 'mission-panes') {
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
  states.clear();
  merging.clear();
}
