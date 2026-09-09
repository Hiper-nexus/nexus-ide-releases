import type { MissionSummarySnapshot } from '../../shared/mission-engine-contract';
import type { Mission, TodoItem, TodoList, TodoStatus } from '../../shared/orch-types';
import { missionChromeTitle } from '../../shared/mission-identity';
import {
  MISSION_KANBAN_LANES,
  missionKanbanLane,
  sortMissionsForLane,
  type MissionKanbanLane,
} from '../../shared/mission-kanban';
import { wasMissionLeftoverParked } from '../../shared/mission-leftover-isolation';
import {
  wasMissionApprovedByOperator,
  wasMissionRuntimeClosedByOperator,
} from '../../shared/mission-recovery-policy';
import {
  persistClosedReason,
  sessionSleepingReason,
} from '../../shared/session-restore-liveness';
import { missionLifecycleLabel } from './mission-lifecycle-copy';

export type TaskBoardColumnStatus = TodoStatus;

export interface TaskBoardTodoEntry {
  readonly kind: 'todo';
  readonly key: string;
  readonly name: string;
  readonly status: TodoStatus;
  readonly list: TodoList;
  readonly item: TodoItem;
}

export interface TaskBoardMissionEntry {
  readonly kind: 'mission';
  readonly key: string;
  readonly name: string;
  /** Lane derivada do snapshot — nunca persistida, nunca arrastada. */
  readonly lane: MissionKanbanLane;
  /** Palavra de estado que o operador lê no card (mission-lifecycle-copy). */
  readonly stateLabel: string;
  readonly summary: MissionSummarySnapshot;
  readonly awaitsOperatorReview: boolean;
}

export type TaskBoardEntry = TaskBoardTodoEntry | TaskBoardMissionEntry;

export interface TaskBoardProjectionInput {
  /** Linhas legadas (SQLite): fonte do aceite humano e fallback de hidratação. */
  readonly missions: readonly Mission[];
  /** Snapshots canônicos do main: fonte do estado, da atenção e do updatedAt. */
  readonly missionSummaries?: readonly MissionSummarySnapshot[];
  readonly todoLists: readonly TodoList[];
  /** Missões que o operador tirou do fluxo (histórico intacto). */
  readonly archivedMissionIds?: readonly string[];
}

export type TaskBoardMissionLanes = Readonly<
  Record<MissionKanbanLane, readonly TaskBoardMissionEntry[]>
>;

/**
 * Fallback de hidratação: a linha legada chega antes do snapshot canônico e o
 * quadro não pode piscar vazio. Espelha `projectState` do main no que a linha
 * sozinha sabe (pending é plano pronto, não rascunho); assim que o snapshot
 * chega, ele vence pelo id.
 */
function legacyMissionSummary(mission: Mission): MissionSummarySnapshot {
  const base = {
    id: mission.id,
    title: mission.title,
    progress: {
      completed: mission.milestones.filter((step) => step.status === 'done')
        .length,
      total: mission.milestones.length,
    },
    updatedAt: mission.updatedAt,
  };
  switch (mission.status) {
    case 'pending':
      return { ...base, state: 'review_ready', needsAttention: false };
    case 'running':
      return { ...base, state: 'running', needsAttention: false };
    case 'done':
      return { ...base, state: 'completed', needsAttention: false };
    case 'failed':
      return { ...base, state: 'failed', needsAttention: true };
    case 'blocked':
      if (wasMissionRuntimeClosedByOperator(mission)) {
        return {
          ...base,
          state: 'blocked_user',
          stateReason: persistClosedReason(),
          needsAttention: false,
        };
      }
      if (wasMissionLeftoverParked(mission)) {
        return {
          ...base,
          state: 'blocked_user',
          stateReason: sessionSleepingReason(),
          needsAttention: false,
        };
      }
      return {
        ...base,
        state: 'blocked_technical',
        stateReason: {
          code: 'mission-blocked',
          label: 'A missão encontrou um bloqueio técnico',
        },
        needsAttention: true,
      };
  }
}

/**
 * `missionAwaitsOperatorReview` com a metade "status === done" já respondida
 * pelo snapshot. O aceite só se prova com o marcador durável na linha legada;
 * sem a linha, não há prova — e "Pronto" sem prova é o que o quadro não diz.
 */
function awaitsOperatorReviewFor(
  summary: MissionSummarySnapshot,
  legacy: Mission | undefined,
): boolean {
  if (summary.state !== 'completed') return false;
  return legacy === undefined || !wasMissionApprovedByOperator(legacy);
}

function missionEntry(
  summary: MissionSummarySnapshot,
  legacy: Mission | undefined,
  archived: ReadonlySet<string>,
): TaskBoardMissionEntry {
  const awaitsOperatorReview = awaitsOperatorReviewFor(summary, legacy);
  return {
    kind: 'mission',
    key: `mission\u0000${summary.id}`,
    name: missionChromeTitle(summary.title) || 'Missão sem título',
    lane: missionKanbanLane(summary, {
      awaitsOperatorReview,
      archivedByOperator: archived.has(summary.id),
    }),
    stateLabel: missionLifecycleLabel(
      summary.state,
      summary.needsAttention,
      summary.stateReason?.code,
      awaitsOperatorReview,
    ),
    summary,
    awaitsOperatorReview,
  };
}

export function projectTaskBoardEntries(
  input: TaskBoardProjectionInput,
): readonly TaskBoardEntry[] {
  const legacyById = new Map(
    input.missions.map((mission) => [mission.id, mission] as const),
  );
  const summaries = input.missionSummaries ?? [];
  const summarizedIds = new Set(summaries.map((summary) => summary.id));
  const archived = new Set(input.archivedMissionIds ?? []);

  const canonical = summaries.map((summary) =>
    missionEntry(summary, legacyById.get(summary.id), archived),
  );
  const legacyOnly = input.missions
    .filter((mission) => !summarizedIds.has(mission.id))
    .map((mission) =>
      missionEntry(legacyMissionSummary(mission), mission, archived),
    );
  const todos = input.todoLists.flatMap((list) =>
    list.items.map(
      (item): TaskBoardTodoEntry => ({
        kind: 'todo',
        key: `${list.id}\u0000${item.id}`,
        name: item.name,
        status: item.status,
        list,
        item,
      }),
    ),
  );
  return Object.freeze([...canonical, ...legacyOnly, ...todos]);
}

export function isTaskBoardMissionEntry(
  entry: TaskBoardEntry,
): entry is TaskBoardMissionEntry {
  return entry.kind === 'mission';
}

/** Missões por lane, já na ordem do quadro: atenção primeiro, depois recência. */
export function groupTaskBoardMissionsByLane(
  entries: readonly TaskBoardEntry[],
): TaskBoardMissionLanes {
  const missions = entries.filter(isTaskBoardMissionEntry);
  const lanes = MISSION_KANBAN_LANES.map((lane) => {
    const members = sortMissionsForLane(
      missions.filter((entry) => entry.lane === lane.id),
      (entry) => entry.summary,
    );
    return [lane.id, Object.freeze([...members])] as const;
  });
  return Object.freeze(
    Object.fromEntries(lanes),
  ) as TaskBoardMissionLanes;
}

export function taskBoardIsEmpty(
  entries: readonly TaskBoardEntry[],
): boolean {
  return entries.length === 0;
}
