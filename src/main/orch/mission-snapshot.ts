import { posix, win32 } from 'node:path';
import { z } from 'zod';
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
    runtimeClosedByOperator: z.boolean().optional(),
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

function hasResidualWork(view: ParsedView): boolean {
  return missionViewHasResidualWork(view);
}

/**
 * Mesma definição de "ainda tem trabalho" que faz o card anunciar Retomar
 * (blocked_technical/residual-work). Exportada para o motor decidir o resume
 * com a MESMA régua que a UI usa para oferecer o botão.
 */
export function missionViewHasResidualWork(view: {
  readonly tasks: readonly { readonly status: string }[];
  readonly handoffs: readonly { readonly settled?: boolean | null }[];
  readonly panes: readonly { readonly state: string }[];
}): boolean {
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
    // Via Rápida: missão running É running — mas SÓ quando há runtime real.
    // Se o orquestrador não está vivo E todos os panes estão stopped (sem
    // sessão), o status 'running' no banco é stale e NÃO pode ser projetado
    // como "Trabalhando" ao operador. Isso acontece após restart quando o
    // restore falhou mas o status não foi atualizado: a UI mostrava
    // "Trabalhando" enquanto os panes exibiam "agente em pausa, sessão NÃO
    // reiniciada". A correção: verificar liveness antes de aceitar 'running'.
    const hasLiveRuntime =
      view.orchestratorLive ||
      view.panes.some(
        (pane) =>
          pane.state !== 'stopped' &&
          pane.state !== 'done' &&
          pane.state !== 'failed',
      );

    if (!hasLiveRuntime) {
      // Runtime não existe: restore falhou, sessões não foram reiniciadas.
      // O operador DEVE ver "Encerrada pelo operador" ou "Precisa de reparo",
      // nunca "Trabalhando" mentindo sobre runtime inexistente.
      if (view.runtimeClosedByOperator) {
        return {
          state: 'blocked_user',
          stateReason: {
            code: 'runtime-closed',
            label: 'Encerrada pelo operador',
          },
        };
      }
      if (view.panes.length === 0) {
        // Kickoff: a missão já está running e o leaf ainda não nasceu.
        // Sem pane morto para testemunhar o cadáver, não inventa restore-failed.
        return { state: 'running' };
      }
      return {
        state: 'blocked_technical',
        stateReason: {
          code: 'restore-failed',
          label: 'O runtime não foi restaurado após restart',
        },
      };
    }

    return { state: 'running' };
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
      if (view.runtimeClosedByOperator) {
        return {
          state: 'blocked_user',
          stateReason: {
            code: 'runtime-closed',
            label: 'Encerrada pelo operador',
          },
        };
      }
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
      return stateReason?.code === 'runtime-closed'
        ? ['resume']
        : ['answer-question', 'stop'];
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
    if (taskState === 'failed') return 'failed';
    if (taskState === 'done') return 'done';
    // Sem processo físico, tarefa "running" no banco é cadáver pós-restart —
    // não é working, nem interrompido: o orquestrador respawnado vai
    // re-disparar o trabalho, então o chip honesto é "na fila". Turno
    // encerrado com handoff entregue NUNCA é Interrupção (doutrina
    // Overclock — print 2026-08-16). Idle transport continua abaixo.
    return 'queued';
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
    needsAttention:
      snapshot.stateReason?.code !== 'runtime-closed' &&
      [
        'blocked_user',
        'blocked_technical',
        'recovering',
        'failed',
      ].includes(snapshot.state),
    updatedAt: snapshot.updatedAt,
  });
}
