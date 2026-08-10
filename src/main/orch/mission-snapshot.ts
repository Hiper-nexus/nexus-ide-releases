import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { missionFastLaneEnabled } from './mission-fast-lane';
import {
  missionAgentSchema,
  missionAgentStateSchema,
  missionEdgeSchema,
  missionQuestionSchema,
  missionSnapshotSchema,
  missionSummarySnapshotSchema,
  missionUnitSchema,
  type MissionAllowedAction,
  type MissionLifecycleState,
  type MissionSnapshot,
  type MissionStateReason,
  type MissionSummarySnapshot,
} from '../../shared/mission-engine-contract';
import {
  missionStatusSchema,
  strictSquadAgentSchema,
} from '../../shared/orch-types';
import {
  evaluateMissionAdmission,
  type MissionAdmissionResult,
} from './mission-engine-admission';

function isRootRelativeProjectPath(value: string): boolean {
  if (
    value.includes('\0') ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    value === '~' ||
    value.startsWith('~/') ||
    value.startsWith('~\\')
  ) {
    return false;
  }

  const segments = value.replaceAll('\\', '/').split('/');
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..',
    )
  );
}

export const rootRelativeProjectPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(isRootRelativeProjectPath, 'path must be root-relative');

const evidenceReferenceSchema = z
  .object({
    id: missionUnitSchema.shape.evidenceIds.element,
    path: rootRelativeProjectPathSchema.optional(),
  })
  .strict();

const snapshotMissionViewSchema = missionSnapshotSchema
  .pick({
    id: true,
    title: true,
    objective: true,
    workspaceLabel: true,
    result: true,
    version: true,
    updatedAt: true,
  })
  .extend({ status: missionStatusSchema })
  .strict();

const snapshotTaskViewSchema = missionUnitSchema
  .omit({ evidenceIds: true })
  .extend({
    evidence: z.array(evidenceReferenceSchema).max(64),
  })
  .strict();

const snapshotHandoffViewSchema = missionEdgeSchema
  .extend({ settled: z.boolean() })
  .strict();

const snapshotPaneViewSchema = z
  .object({
    paneId: missionEdgeSchema.shape.id,
    agentId: missionEdgeSchema.shape.sourceAgentId,
    state: missionAgentStateSchema,
    currentUnitId: missionAgentSchema.shape.currentUnitId,
    detail: missionAgentSchema.shape.detail,
  })
  .strict();

export const projectMissionSnapshotViewSchema = z
  .object({
    mission: snapshotMissionViewSchema,
    hasDispatchAuthority: z.boolean(),
    hasCurrentKickoffReceipt: z.boolean(),
    orchestratorLive: z.boolean(),
    tasks: z.array(snapshotTaskViewSchema).max(256),
    handoffs: z.array(snapshotHandoffViewSchema).max(256),
    panes: z.array(snapshotPaneViewSchema).max(64),
    openQuestion: missionQuestionSchema.optional(),
    roster: z.array(strictSquadAgentSchema).max(64),
  })
  .strict();

export type ProjectMissionSnapshotView = z.infer<
  typeof projectMissionSnapshotViewSchema
>;

type ParsedView = z.output<typeof projectMissionSnapshotViewSchema>;

function admissionReason(
  admission: Exclude<MissionAdmissionResult, { readonly ok: true }>,
): MissionStateReason {
  switch (admission.code) {
    case 'authority-missing':
      return {
        code: admission.code,
        label: 'Autoridade de execução ausente',
      };
    case 'kickoff-receipt-missing':
      return {
        code: admission.code,
        label: 'Confirmação de início ausente',
      };
    case 'orchestrator-not-live':
      return {
        code: admission.code,
        label: 'Coordenação inativa',
      };
  }
}

function hasResidualWork(view: ParsedView): boolean {
  return (
    view.tasks.some((task) => task.status !== 'done') ||
    view.handoffs.some((handoff) => !handoff.settled) ||
    view.panes.some((pane) =>
      ['queued', 'working', 'waiting', 'blocked'].includes(pane.state),
    )
  );
}

function projectState(view: ParsedView): {
  readonly state: MissionLifecycleState;
  readonly stateReason?: MissionStateReason;
} {
  if (view.openQuestion) {
    return {
      state: 'blocked_user',
      stateReason: {
        code: 'open-question',
        label: 'Aguardando sua resposta',
      },
    };
  }

  if (view.mission.status === 'running') {
    // Via Rápida: missão running É running. O tripé cerimonial
    // (autoridade+recibo+liveness) pertencia ao motor antigo e projetava
    // "Precisa de reparo" sobre equipes vivas trabalhando nos terminais.
    if (missionFastLaneEnabled()) return { state: 'running' };
    const admission = evaluateMissionAdmission({
      hasDispatchAuthority: view.hasDispatchAuthority,
      hasCurrentKickoffReceipt: view.hasCurrentKickoffReceipt,
      orchestratorLive: view.orchestratorLive,
    });
    return admission.ok
      ? { state: 'running' }
      : { state: 'blocked_technical', stateReason: admissionReason(admission) };
  }

  if (view.mission.status === 'done') {
    if (view.mission.result) return { state: 'completed' };
    return hasResidualWork(view)
      ? {
          state: 'blocked_technical',
          stateReason: {
            code: 'residual-work',
            label: 'A missão ainda tem trabalho pendente',
          },
        }
      : { state: 'completed' };
  }

  switch (view.mission.status) {
    case 'pending':
      return { state: 'review_ready' };
    case 'blocked':
      return {
        state: 'blocked_technical',
        stateReason: {
          code: 'mission-blocked',
          label: 'A missão encontrou um bloqueio técnico',
        },
      };
    case 'failed':
      return { state: 'failed' };
  }
}

function allowedActions(
  state: MissionLifecycleState,
  stateReason: MissionStateReason | undefined,
): MissionAllowedAction[] {
  switch (state) {
    case 'review_ready':
      return ['start'];
    case 'running':
      return ['direct', 'stop'];
    case 'blocked_user':
      return ['answer-question', 'stop'];
    case 'blocked_technical':
      return stateReason?.code === 'residual-work'
        ? ['resume', 'stop']
        : ['retry-kickoff', 'stop'];
    case 'recovering':
      return ['stop'];
    case 'draft':
    case 'starting':
    case 'stopping':
    case 'failed':
    case 'completed':
      return [];
  }
}


export type MissionAgentLiveSemantic =
  | 'working'
  | 'completed'
  | 'awaiting-input'
  | 'idle'
  | 'error';

export type MissionAgentLiveSession = 'spawning' | 'busy' | 'idle' | null;

export type MissionAgentTaskFallback = 'queued' | 'working' | 'failed' | 'done';

/**
 * Prefer live PTY/hook/ACP signals for board chips. Task status is only a
 * fallback when the live channel is quiet or absent — never let an idle
 * transport hide an actively running sealed task, and never invent `waiting`
 * without an explicit permission/elicitation latch.
 */
export function resolveMissionAgentLiveState(input: {
  readonly semantic?: MissionAgentLiveSemantic | null;
  readonly sessionState?: MissionAgentLiveSession;
  readonly taskState?: MissionAgentTaskFallback;
}): z.infer<typeof missionAgentStateSchema> {
  const semantic = input.semantic ?? null;
  const sessionState = input.sessionState ?? null;
  const taskState = input.taskState ?? 'queued';

  if (
    semantic === 'working' ||
    sessionState === 'busy' ||
    sessionState === 'spawning'
  ) {
    return 'working';
  }
  if (semantic === 'awaiting-input') return 'waiting';
  if (semantic === 'error') return 'failed';

  if (sessionState === null) {
    if (taskState === 'working') return 'working';
    if (taskState === 'failed') return 'failed';
    if (taskState === 'done') return 'done';
    // Pane row still listed but the physical session is gone.
    return 'stopped';
  }

  if (semantic === 'completed') {
    if (taskState === 'working') return 'working';
    if (taskState === 'failed') return 'failed';
    return 'done';
  }

  // Live idle transport (hook idle / quiet PTY): keep task truth when present.
  if (taskState === 'working') return 'working';
  if (taskState === 'failed') return 'failed';
  if (taskState === 'done') return 'done';
  return 'queued';
}

function fallbackAgentState(
  view: ParsedView,
  agentId: string,
  missionState: MissionLifecycleState,
): z.infer<typeof missionAgentStateSchema> {
  if (missionState === 'completed') return 'done';
  const tasks = view.tasks.filter((task) => task.agentId === agentId);
  if (tasks.some((task) => task.status === 'running')) return 'working';
  if (tasks.some((task) => task.status === 'failed')) return 'failed';
  if (tasks.length > 0 && tasks.every((task) => task.status === 'done')) {
    return 'done';
  }
  return 'queued';
}

export function projectMissionSnapshot(
  rawView: ProjectMissionSnapshotView,
): MissionSnapshot {
  const view = projectMissionSnapshotViewSchema.parse(rawView);
  const { state, stateReason } = projectState(view);
  const completed = view.tasks.filter((task) => task.status === 'done').length;

  const snapshot = {
    id: view.mission.id,
    title: view.mission.title,
    objective: view.mission.objective,
    workspaceLabel: view.mission.workspaceLabel,
    state,
    ...(stateReason ? { stateReason } : {}),
    progress: { completed, total: view.tasks.length },
    agents: view.roster.map((agent) => {
      const pane = view.panes.find((candidate) => candidate.agentId === agent.id);
      return {
        id: agent.id,
        agentName: agent.agentName,
        category: agent.category,
        cli: agent.cli,
        state:
          state === 'completed'
            ? 'done'
            : (pane?.state ?? fallbackAgentState(view, agent.id, state)),
        ...(pane?.currentUnitId
          ? { currentUnitId: pane.currentUnitId }
          : {}),
        ...(pane ? { paneId: pane.paneId } : {}),
        ...(pane?.detail ? { detail: pane.detail } : {}),
      };
    }),
    edges: view.handoffs.map(({ settled: _settled, ...edge }) => edge),
    units: view.tasks.map(({ evidence, ...task }) => ({
      ...task,
      evidenceIds: evidence.map(({ id }) => id),
    })),
    ...(view.openQuestion ? { question: view.openQuestion } : {}),
    ...(view.mission.result ? { result: view.mission.result } : {}),
    allowedActions: allowedActions(state, stateReason),
    version: view.mission.version,
    updatedAt: view.mission.updatedAt,
  };

  return missionSnapshotSchema.parse(snapshot);
}

export function projectMissionSummarySnapshot(
  view: ProjectMissionSnapshotView,
): MissionSummarySnapshot {
  const snapshot = projectMissionSnapshot(view);
  return missionSummarySnapshotSchema.parse({
    id: snapshot.id,
    title: snapshot.title,
    state: snapshot.state,
    ...(snapshot.stateReason ? { stateReason: snapshot.stateReason } : {}),
    progress: snapshot.progress,
    needsAttention: [
      'blocked_user',
      'blocked_technical',
      'recovering',
      'failed',
    ].includes(snapshot.state),
    updatedAt: snapshot.updatedAt,
  });
}
