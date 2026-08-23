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
import {
  NEXUS_PROCESS_STARTED_AT,
  isIsolationStopReasonCode,
  leftoverRunningOrPendingIsDead,
  persistClosedReason,
  sessionDeadReason,
  sessionSleepingReason,
  wasUpdatedBeforeThisProcess,
} from '../../shared/session-restore-liveness';

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
  .extend({
    status: missionStatusSchema,
    createdAt: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
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
    leftoverParked: z.boolean().optional(),
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
 * Processo de verdade: busy/spawning (orquestrador vivo) ou pane working /
 * waiting / blocked. queued sem sessão é cadáver pós-restart, não equipe.
 */
export function missionViewHasLiveWorkingRuntime(view: {
  readonly orchestratorLive: boolean;
  readonly panes: readonly { readonly state: string }[];
}): boolean {
  if (view.orchestratorLive) return true;
  return view.panes.some(
    (pane) =>
      pane.state === 'working' ||
      pane.state === 'waiting' ||
      pane.state === 'blocked',
  );
}

/** Arquivo de verdade — evidence com path. Tarefa vazia não conta. */
export function missionViewHasFiles(view: {
  readonly tasks: readonly {
    readonly evidence: readonly { readonly path?: string }[];
  }[];
}): boolean {
  return view.tasks.some((task) =>
    task.evidence.some((item) => Boolean(item.path?.trim())),
  );
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
  // Persist terminal is authority. leftover-parked leftover in the
  // description must never paint Parou over Pronto.
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

  if (view.mission.status === 'failed') {
    return { state: 'failed' };
  }

  if (view.runtimeClosedByOperator) {
    return {
      state: 'blocked_user',
      stateReason: persistClosedReason(),
    };
  }

  if (view.leftoverParked) {
    return {
      state: 'blocked_user',
      stateReason: sessionSleepingReason(),
    };
  }

  // Precisa de você only for a live human ask — leftover-park / Encerrar
  // persist the same blocked_user row and must not inherit this label.
  if (view.openQuestion) {
    return {
      state: 'blocked_user',
      stateReason: {
        code: 'open-question',
        label: 'Aguardando sua resposta',
      },
    };
  }

  const persistStillLive =
    view.mission.status === 'running' || view.mission.status === 'pending';
  const staleAcrossRestart = wasUpdatedBeforeThisProcess(
    view.mission.updatedAt,
    NEXUS_PROCESS_STARTED_AT,
  );
  const hasLiveRuntime = missionViewHasLiveWorkingRuntime(view);
  const hasFiles = missionViewHasFiles(view);
  const freshKickoff =
    view.mission.status === 'running' &&
    view.hasCurrentKickoffReceipt &&
    view.panes.length === 0 &&
    !staleAcrossRestart;

  // session-dead only while SQLite still says running/pending. After Encerrar
  // or leftover-park persist (blocked / blocked_user), follow that row.
  const kickoffThisProcess =
    view.mission.status === 'running' &&
    view.hasCurrentKickoffReceipt &&
    view.panes.length === 0;

  if (
    persistStillLive &&
    leftoverRunningOrPendingIsDead({
      status: view.mission.status,
      hasLivePty: hasLiveRuntime,
      hasFiles,
      isFreshKickoff: freshKickoff || kickoffThisProcess,
      isFreshPending:
        view.mission.status === 'pending' &&
        !staleAcrossRestart &&
        view.panes.length === 0,
    })
  ) {
    return {
      state: 'blocked_technical',
      stateReason: sessionDeadReason(),
    };
  }

  // Stale running/pending without a live process is leftover until persist
  // lands. Stopped/done/failed panes are restore-failed (running branch),
  // not session-dead painted over persist.
  const restoreFailedWitness =
    view.panes.length > 0 &&
    view.panes.every(
      (pane) =>
        pane.state === 'stopped' ||
        pane.state === 'done' ||
        pane.state === 'failed',
    );
  if (
    persistStillLive &&
    staleAcrossRestart &&
    !hasLiveRuntime &&
    !kickoffThisProcess &&
    !restoreFailedWitness
  ) {
    return {
      state: 'blocked_technical',
      stateReason: sessionDeadReason(),
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
          stateReason: persistClosedReason(),
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

  switch (view.mission.status) {
    case 'pending':
      return { state: 'review_ready' };
    case 'blocked':
      if (view.runtimeClosedByOperator) {
        return {
          state: 'blocked_user',
          stateReason: persistClosedReason(),
        };
      }
      return {
        state: 'blocked_technical',
        stateReason: {
          code: 'mission-blocked',
          label: 'A missão encontrou um bloqueio técnico',
        },
      };
  }
}

/** Exportada para teste: contrato "o que a UI anuncia, o motor aceita". */
export function allowedActionsForState(
  state: MissionLifecycleState,
  stateReason: MissionStateReason | undefined,
): MissionAllowedAction[] {
  switch (state) {
    case 'review_ready':
      return ['start'];
    case 'running':
      return ['direct', 'stop'];
    case 'blocked_user':
      return isIsolationStopReasonCode(stateReason?.code)
        ? ['resume']
        : ['answer-question', 'stop'];
    case 'blocked_technical':
      return stateReason?.code === 'residual-work'
        ? ['resume', 'stop']
        : ['retry-kickoff', 'stop'];
    case 'recovering':
      return ['stop'];
    // Concluída NÃO é o fim da conversa: a entrega ainda espera a revisão
    // humana e o operador pode não aprovar. `resume` é a decisão explícita
    // que reabre a coordenação para o ajuste — o mesmo caminho já usado por
    // missão concluída com trabalho residual.
    case 'completed':
      return ['resume'];
    // Missão falhada oferecia SÓ ação destrutiva ("Remover"): a pessoa que
    // pediu o trabalho ficava com apagar como única saída. `resume` é a
    // decisão explícita de tentar de novo — o caminho já existe e religa a
    // coordenação pela Via Rápida.
    case 'failed':
      return ['resume'];
    case 'draft':
    case 'starting':
    case 'stopping':
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
    ...(view.openQuestion &&
    !view.leftoverParked &&
    !view.runtimeClosedByOperator
      ? { question: view.openQuestion }
      : {}),
    ...(view.mission.result ? { result: view.mission.result } : {}),
    allowedActions: allowedActionsForState(state, stateReason),
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
      !isIsolationStopReasonCode(snapshot.stateReason?.code) &&
      [
        'blocked_user',
        'blocked_technical',
        'recovering',
        'failed',
      ].includes(snapshot.state),
    updatedAt: snapshot.updatedAt,
  });
}
