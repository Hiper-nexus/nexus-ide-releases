/**
 * Snapshot do plano de controle da missão (P1-0 · slice 1).
 *
 * Funde, em UMA leitura, o que hoje vive espalhado: estado vivo dos panes
 * (nexus_pane_list), fila/ondas (mission-task-schedule), ownership e bloqueios
 * (task-dispatch + mission-block-cause). Módulo puro: recebe projeções já
 * coletadas pelo main e nunca toca store, IPC ou registry — o coletor
 * (main) é quem decide escopo e autoridade do chamador.
 */
import {
  hasNamedMissionBlockCause,
  missionBlockCause,
  missionBlockCauseText,
  redactMissionBlockDetail,
  type MissionBlockCauseCode,
  type MissionBlockCauseInput,
} from './mission-block-cause';

export type MissionControlPaneActivity = 'working' | 'idle' | 'dead' | 'unknown';

export interface MissionControlPaneInput {
  readonly paneId: string;
  readonly sessionId?: string | null;
  readonly title?: string;
  readonly state?: string;
  readonly adapterId?: string;
  readonly model?: string;
  readonly agentName?: string;
  readonly role?: 'orchestrator' | 'worker';
  readonly workerIncarnationId?: string;
}

export interface MissionControlDispatchInput {
  readonly taskId: string;
  readonly state: string;
  readonly attempt: number;
  readonly workerId: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  readonly paneId?: string;
  readonly sessionId?: string;
  readonly lastHeartbeatAt?: number;
  readonly lastError?: string;
  readonly agentCategory?: string;
  readonly ownership?: {
    readonly files: readonly string[];
    readonly symbols: readonly string[];
    readonly domains: readonly string[];
  };
}

export interface MissionControlScheduleItemInput {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly agentName?: string | null;
  readonly agentCategory?: string | null;
  readonly stage?: string | null;
  readonly dependsOn?: readonly string[];
  readonly waveHint?: number;
}

export interface MissionControlSnapshotInput {
  readonly missionId: string;
  readonly generatedAt: number;
  readonly mission: MissionBlockCauseInput & { readonly title?: string };
  readonly panes: readonly MissionControlPaneInput[];
  readonly schedule: readonly MissionControlScheduleItemInput[];
  readonly dispatches: readonly MissionControlDispatchInput[];
}

export interface MissionControlPaneEntry {
  readonly paneId: string;
  readonly sessionId: string | null;
  readonly title: string | null;
  readonly state: string;
  readonly activity: MissionControlPaneActivity;
  readonly adapterId?: string;
  readonly model?: string;
  readonly agentName?: string;
  readonly role?: 'orchestrator' | 'worker';
  readonly workerIncarnationId?: string;
  readonly currentTaskId?: string;
  readonly currentTaskTitle?: string;
  readonly dispatchState?: string;
  readonly lastHeartbeatAt?: number;
}

export interface MissionControlQueueEntry {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly waveHint: number;
  readonly dependsOn: readonly string[];
  readonly agentName: string | null;
  readonly stage: string | null;
  readonly dispatchState?: string;
  readonly attempt?: number;
  readonly paneId?: string;
  readonly workerId?: string;
  readonly leaseExpiresAt?: number;
  readonly lastError?: string;
}

export interface MissionControlOwnershipEntry {
  readonly taskId: string;
  readonly workerId: string;
  readonly paneId?: string;
  readonly leaseOwner?: string;
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly domains: readonly string[];
}

export interface MissionControlBlockEntry {
  readonly scope: 'mission' | 'task';
  readonly taskId?: string;
  readonly code?: MissionBlockCauseCode;
  readonly text: string;
}

export interface MissionControlSnapshot {
  readonly missionId: string;
  readonly generatedAt: number;
  readonly missionStatus?: string;
  readonly missionTitle?: string;
  readonly panes: readonly MissionControlPaneEntry[];
  readonly queue: readonly MissionControlQueueEntry[];
  readonly ownership: readonly MissionControlOwnershipEntry[];
  readonly blocks: readonly MissionControlBlockEntry[];
}

/** Dispatch que representa trabalho corrente de um pane (espelha o schedule). */
const ACTIVE_DISPATCH_STATES: ReadonlySet<string> = new Set([
  'claimed',
  'routed',
  'spawning',
  'running',
  'handoff_ready',
  'merging',
]);

const BLOCKED_DISPATCH_STATES: ReadonlySet<string> = new Set([
  'blocked',
  'suspended',
  'failed',
]);

/** Ownership só interessa enquanto a task pode voltar a escrever. */
const OWNERSHIP_IRRELEVANT_STATES: ReadonlySet<string> = new Set([
  'completed',
  'superseded',
]);

function paneActivity(state: string | undefined): MissionControlPaneActivity {
  switch (state) {
    case 'busy':
    case 'spawning':
      return 'working';
    case 'idle':
    case 'hibernated':
      return 'idle';
    case 'exited':
      return 'dead';
    default:
      return 'unknown';
  }
}

function dispatchForPane(
  pane: MissionControlPaneInput,
  dispatches: readonly MissionControlDispatchInput[],
): MissionControlDispatchInput | undefined {
  return dispatches.find(
    (dispatch) =>
      ACTIVE_DISPATCH_STATES.has(dispatch.state) &&
      (dispatch.paneId === pane.paneId ||
        (typeof dispatch.sessionId === 'string' &&
          dispatch.sessionId === pane.sessionId)),
  );
}

export function buildMissionControlSnapshot(
  input: MissionControlSnapshotInput,
): MissionControlSnapshot {
  const titleByTask = new Map(
    input.schedule.map((item) => [item.taskId, item.title]),
  );
  const dispatchByTask = new Map(
    input.dispatches.map((dispatch) => [dispatch.taskId, dispatch]),
  );

  const panes: MissionControlPaneEntry[] = [...input.panes]
    .sort((a, b) => a.paneId.localeCompare(b.paneId))
    .map((pane) => {
      const dispatch = dispatchForPane(pane, input.dispatches);
      return {
        paneId: pane.paneId,
        sessionId: pane.sessionId ?? null,
        title: pane.title ?? null,
        state: pane.state ?? 'unknown',
        activity: paneActivity(pane.state),
        ...(pane.adapterId ? { adapterId: pane.adapterId } : {}),
        ...(pane.model ? { model: pane.model } : {}),
        ...(pane.agentName ? { agentName: pane.agentName } : {}),
        ...(pane.role ? { role: pane.role } : {}),
        ...(pane.workerIncarnationId
          ? { workerIncarnationId: pane.workerIncarnationId }
          : {}),
        ...(dispatch
          ? {
              currentTaskId: dispatch.taskId,
              dispatchState: dispatch.state,
              ...(titleByTask.has(dispatch.taskId)
                ? { currentTaskTitle: titleByTask.get(dispatch.taskId) }
                : {}),
              ...(typeof dispatch.lastHeartbeatAt === 'number'
                ? { lastHeartbeatAt: dispatch.lastHeartbeatAt }
                : {}),
            }
          : {}),
      };
    });

  const queue: MissionControlQueueEntry[] = [...input.schedule]
    .sort(
      (a, b) =>
        (a.waveHint ?? 1) - (b.waveHint ?? 1) ||
        a.taskId.localeCompare(b.taskId),
    )
    .map((item) => {
      const dispatch = dispatchByTask.get(item.taskId);
      return {
        taskId: item.taskId,
        title: item.title,
        status: item.status,
        waveHint: item.waveHint ?? 1,
        dependsOn: item.dependsOn ?? [],
        agentName: item.agentName ?? null,
        stage: item.stage ?? null,
        ...(dispatch
          ? {
              dispatchState: dispatch.state,
              attempt: dispatch.attempt,
              ...(dispatch.paneId ? { paneId: dispatch.paneId } : {}),
              workerId: dispatch.workerId,
              ...(typeof dispatch.leaseExpiresAt === 'number'
                ? { leaseExpiresAt: dispatch.leaseExpiresAt }
                : {}),
              ...(dispatch.lastError
                ? { lastError: redactMissionBlockDetail(dispatch.lastError) }
                : {}),
            }
          : {}),
      };
    });

  const ownership: MissionControlOwnershipEntry[] = input.dispatches
    .filter(
      (dispatch) =>
        dispatch.ownership !== undefined &&
        !OWNERSHIP_IRRELEVANT_STATES.has(dispatch.state),
    )
    .map((dispatch) => ({
      taskId: dispatch.taskId,
      workerId: dispatch.workerId,
      ...(dispatch.paneId ? { paneId: dispatch.paneId } : {}),
      ...(dispatch.leaseOwner ? { leaseOwner: dispatch.leaseOwner } : {}),
      files: dispatch.ownership?.files ?? [],
      symbols: dispatch.ownership?.symbols ?? [],
      domains: dispatch.ownership?.domains ?? [],
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));

  const blocks: MissionControlBlockEntry[] = [];
  // Reconcilia com 260eb2e6: a causa nomeada é a autoridade; sem causa nomeada
  // e sem status blocked, a missão está saudável — nenhum bloco de missão.
  const missionCause = missionBlockCause(input.mission);
  if (
    hasNamedMissionBlockCause(missionCause) ||
    input.mission.status === 'blocked'
  ) {
    blocks.push({
      scope: 'mission',
      code: missionCause.code,
      text: missionBlockCauseText(missionCause),
    });
  }
  for (const dispatch of input.dispatches) {
    if (!BLOCKED_DISPATCH_STATES.has(dispatch.state)) continue;
    const detail = dispatch.lastError
      ? redactMissionBlockDetail(dispatch.lastError)
      : '';
    blocks.push({
      scope: 'task',
      taskId: dispatch.taskId,
      text:
        detail.length > 0
          ? detail
          : `Dispatch da task em estado ${dispatch.state}.`,
    });
  }

  return {
    missionId: input.missionId,
    generatedAt: input.generatedAt,
    ...(input.mission.status ? { missionStatus: input.mission.status } : {}),
    ...(input.mission.title ? { missionTitle: input.mission.title } : {}),
    panes,
    queue,
    ownership,
    blocks,
  };
}
