import type { Mission, TodoItem, TodoList, TodoStatus } from '../../shared/orch-types';

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
  readonly status: TaskBoardColumnStatus;
  readonly mission: Mission;
}

export type TaskBoardEntry = TaskBoardTodoEntry | TaskBoardMissionEntry;

/**
 * Place a mission on the operator Kanban. Running/blocked belong in
 * "Em andamento" even before the orchestrator has dispatched any tasks —
 * otherwise a live mission vanishes behind "Sem tarefas no fluxo".
 */
export function missionBoardColumn(
  mission: Mission,
): TaskBoardColumnStatus | null {
  if (mission.status === 'pending') return 'todo';
  if (mission.status === 'running' || mission.status === 'blocked') {
    return 'in_progress';
  }
  if (mission.status === 'done' || mission.status === 'failed') return 'done';
  return null;
}

export function projectTaskBoardEntries(input: {
  readonly missions: readonly Mission[];
  readonly todoLists: readonly TodoList[];
}): readonly TaskBoardEntry[] {
  const missions = input.missions.flatMap((mission): TaskBoardMissionEntry[] => {
    const status = missionBoardColumn(mission);
    if (!status) return [];
    return [
      {
        kind: 'mission',
        key: `mission\u0000${mission.id}`,
        name: mission.title.trim() || 'Missão sem título',
        status,
        mission,
      },
    ];
  });
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
  return Object.freeze([...missions, ...todos]);
}

export function taskBoardIsEmpty(
  entries: readonly TaskBoardEntry[],
): boolean {
  return entries.length === 0;
}
