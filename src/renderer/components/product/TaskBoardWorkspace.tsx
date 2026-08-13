import { useEffect, useMemo, useRef, useState } from 'react';
import type { TodoItem, TodoList, TodoStatus } from '../../../shared/orch-types';
import { orchTodosEmptyBeat } from '../../../shared/endorphin';
import { statusLabel } from '../../lib/mission-rail-groups';
import {
  projectTaskBoardEntries,
  taskBoardIsEmpty,
} from '../../lib/task-board-projection';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { ActionCard, EmptyState } from '../ActionCard';
import { PixelIcon } from '../PixelIcon';

const TODO_STATUS_OPTIONS: ReadonlyArray<{
  value: TodoStatus;
  label: string;
}> = [
  { value: 'todo', label: 'A fazer' },
  { value: 'in_progress', label: 'Em andamento' },
  { value: 'done', label: 'Concluída' },
];

interface PendingTodoWrite {
  workspaceEpoch: number;
  boundWorkspacePath: string | null;
  writeId: symbol;
}

interface TodoWriteFailure {
  message: string;
  targetStatus: TodoStatus;
}

export function TaskBoardWorkspace() {
  const todoLists = useOrchStore((state) => state.todoLists);
  const missions = useOrchStore((state) => state.missions);
  const workspaceEpoch = useOrchStore((state) => state.workspaceEpoch);
  const boundWorkspacePath = useOrchStore(
    (state) => state.boundWorkspacePath,
  );
  const openNewMission = useProductNavigationStore(
    (state) => state.openNewMission,
  );
  const openMission = useProductNavigationStore((state) => state.openMission);
  const pendingWrites = useRef(new Map<string, PendingTodoWrite>());
  const [pending, setPending] = useState<
    ReadonlyMap<string, PendingTodoWrite>
  >(() => new Map());
  const [errors, setErrors] = useState<Record<string, TodoWriteFailure>>({});

  useEffect(() => {
    pendingWrites.current.clear();
    setPending(new Map());
    setErrors({});
  }, [workspaceEpoch, boundWorkspacePath]);
  const boardEntries = useMemo(
    () => projectTaskBoardEntries({ missions, todoLists }),
    [missions, todoLists],
  );
  const itemCount = boardEntries.length;
  const missionCount = boardEntries.filter(
    (entry) => entry.kind === 'mission',
  ).length;
  const todoCount = itemCount - missionCount;

  const setStatus = async (
    list: TodoList,
    item: TodoItem,
    status: TodoStatus,
  ): Promise<void> => {
    const key = `${list.id}\u0000${item.id}`;
    if (status === item.status || pendingWrites.current.has(key)) return;
    const writeScope = useOrchStore.getState();
    const ownership: PendingTodoWrite = {
      workspaceEpoch: writeScope.workspaceEpoch,
      boundWorkspacePath: writeScope.boundWorkspacePath,
      writeId: Symbol(key),
    };

    pendingWrites.current.set(key, ownership);
    setPending((current) => new Map(current).set(key, ownership));
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });

    try {
      const updated = await window.nexus.orch.setTodoStatus(
        list.id,
        item.id,
        status,
      );
      useOrchStore.setState((state) =>
        state.workspaceEpoch === writeScope.workspaceEpoch &&
        state.boundWorkspacePath === writeScope.boundWorkspacePath &&
        state.todoLists.some((candidate) => candidate.id === updated.id)
          ? {
              todoLists: state.todoLists.map((candidate) =>
                candidate.id === updated.id ? updated : candidate,
              ),
            }
          : {},
      );
    } catch {
      const currentScope = useOrchStore.getState();
      if (
        currentScope.workspaceEpoch === writeScope.workspaceEpoch &&
        currentScope.boundWorkspacePath === writeScope.boundWorkspacePath
      ) {
        setErrors((current) => ({
          ...current,
          [key]: {
            message: 'Não foi possível atualizar a tarefa.',
            targetStatus: status,
          },
        }));
      }
    } finally {
      const currentScope = useOrchStore.getState();
      if (
        pendingWrites.current.get(key) !== ownership ||
        currentScope.workspaceEpoch !== ownership.workspaceEpoch ||
        currentScope.boundWorkspacePath !== ownership.boundWorkspacePath
      ) {
        return;
      }
      pendingWrites.current.delete(key);
      setPending((current) => {
        if (current.get(key) !== ownership) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }
  };

  const emptyBeat = orchTodosEmptyBeat();
  const boardEmpty = taskBoardIsEmpty(boardEntries);

  // Bridge parity: the board reads as status columns, not opaque list ids.
  // Running/blocked missions occupy Em andamento even before any todo exists.
  const columns = TODO_STATUS_OPTIONS.map((option) => ({
    status: option.value,
    label: option.label,
    entries: boardEntries.filter((entry) => entry.status === option.value),
  }));

  return (
    <section
      className="product-workspace task-board-workspace"
      aria-label="Quadro de tarefas"
    >
      <header className="product-workspace__header">
        <div className="product-workspace__identity">
          <span className="product-workspace__badge" aria-hidden="true">
            <PixelIcon name="board" size={16} />
          </span>
          <div className="product-workspace__heading">
            <span className="product-workspace__context">
              Execução do workspace
            </span>
            <h1>Quadro</h1>
          </div>
        </div>
        {itemCount > 0 ? (
          <p className="product-workspace__summary" aria-live="polite">
            {missionCount > 0
              ? `${missionCount} ${missionCount === 1 ? 'missão' : 'missões'}${
                  todoCount > 0
                    ? ` · ${todoCount} ${todoCount === 1 ? 'tarefa' : 'tarefas'}`
                    : ''
                } no fluxo`
              : `${todoCount} ${todoCount === 1 ? 'tarefa' : 'tarefas'} no fluxo`}
          </p>
        ) : null}
      </header>

      <div className="product-workspace__content task-board-workspace__content">
        {boardEmpty ? (
          <EmptyState
            icon="board"
            title={emptyBeat.title}
            body={emptyBeat.line}
            className="task-board-workspace__empty"
            action={
              <ActionCard
                icon="mission"
                title="Criar nova missão"
                subtitle="Defina o objetivo para gerar as primeiras tarefas."
                variant="primary"
                onClick={openNewMission}
              />
            }
          />
        ) : null}

        <div className="task-board-workspace__lists">
          {columns.map((column) => (
            <section
              key={column.status}
              className="task-board-workspace__list"
              data-status={column.status}
              aria-label={`Tarefas: ${column.label}`}
            >
              <header className="task-board-workspace__list-header">
                <h2>{column.label}</h2>
                <span>{column.entries.length}</span>
              </header>
              {column.entries.length === 0 ? (
                <p className="task-board-workspace__column-empty">
                  Sem tarefas
                </p>
              ) : (
                <ul className="task-board-workspace__items">
                  {column.entries.map((entry, itemIndex) => {
                    if (entry.kind === 'mission') {
                      const missionStatus = entry.mission.status;
                      return (
                        <li
                          key={entry.key}
                          className={`task-board-workspace__item task-board-workspace__item--mission task-board-workspace__item--${entry.status}`}
                        >
                          <span
                            className={`task-board-workspace__dot task-board-workspace__dot--${entry.status}${
                              missionStatus === 'blocked'
                                ? ' task-board-workspace__dot--blocked'
                                : ''
                            }`}
                            aria-hidden="true"
                          />
                          <button
                            type="button"
                            className="task-board-workspace__mission-open"
                            onClick={() => openMission(entry.mission.id)}
                          >
                            <span className="task-board-workspace__item-name">
                              {entry.name}
                            </span>
                            <span className="task-board-workspace__mission-badge">
                              Missão · {statusLabel(missionStatus)}
                            </span>
                          </button>
                        </li>
                      );
                    }
                    const { list, item } = entry;
                    const key = entry.key;
                    const isPending = pending.has(key);
                    const error = errors[key];
                    const errorId = error
                      ? `task-board-error-${column.status}-${itemIndex + 1}`
                      : undefined;

                    return (
                      <li
                        key={entry.key}
                        className={`task-board-workspace__item task-board-workspace__item--${item.status}`}
                        aria-busy={isPending || undefined}
                      >
                        <span
                          className={`task-board-workspace__dot task-board-workspace__dot--${item.status}`}
                          aria-hidden="true"
                        />
                        <span className="task-board-workspace__item-name">
                          {item.name}
                        </span>
                        <label className="task-board-workspace__status">
                          <span>Status</span>
                          <select
                            value={item.status}
                            disabled={isPending}
                            aria-label={`Status de ${item.name}`}
                            aria-describedby={errorId}
                            onChange={(event) =>
                              void setStatus(
                                list,
                                item,
                                event.target.value as TodoStatus,
                              )
                            }
                          >
                            {TODO_STATUS_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        {isPending ? (
                          <span
                            className="task-board-workspace__pending"
                            role="status"
                          >
                            Salvando…
                          </span>
                        ) : null}
                        {error ? (
                          <div className="task-board-workspace__failure">
                            <p
                              id={errorId}
                              className="task-board-workspace__error"
                              role="alert"
                            >
                              {error.message}
                            </p>
                            <button
                              type="button"
                              className="task-board-workspace__retry"
                              onClick={() =>
                                void setStatus(list, item, error.targetStatus)
                              }
                            >
                              Tentar novamente
                            </button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
