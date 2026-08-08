import { useEffect, useRef, useState } from 'react';
import type { TodoItem, TodoList, TodoStatus } from '../../../shared/orch-types';
import { orchTodosEmptyBeat } from '../../../shared/endorphin';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { ActionCard, EmptyState } from '../ActionCard';

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

export function TaskBoardWorkspace() {
  const todoLists = useOrchStore((state) => state.todoLists);
  const workspaceEpoch = useOrchStore((state) => state.workspaceEpoch);
  const boundWorkspacePath = useOrchStore(
    (state) => state.boundWorkspacePath,
  );
  const openMissionSetup = useProductNavigationStore(
    (state) => state.openMissionSetup,
  );
  const pendingWrites = useRef(new Map<string, PendingTodoWrite>());
  const [pending, setPending] = useState<
    ReadonlyMap<string, PendingTodoWrite>
  >(() => new Map());
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    pendingWrites.current.clear();
    setPending(new Map());
    setErrors({});
  }, [workspaceEpoch, boundWorkspacePath]);
  const visibleLists = todoLists.filter((list) => list.items.length > 0);
  const itemCount = visibleLists.reduce((count, list) => count + list.items.length, 0);

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
          [key]: 'Não foi possível atualizar a tarefa. Tente novamente.',
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

  return (
    <section
      className="product-workspace task-board-workspace"
      aria-label="Quadro de tarefas"
    >
      <header className="product-workspace__header">
        <div className="product-workspace__heading">
          <span className="product-workspace__context">Execução do workspace</span>
          <h1>Quadro</h1>
        </div>
        {itemCount > 0 ? (
          <p className="product-workspace__summary" aria-live="polite">
            {itemCount} {itemCount === 1 ? 'tarefa' : 'tarefas'} no fluxo
          </p>
        ) : null}
      </header>

      <div className="product-workspace__content task-board-workspace__content">
        {visibleLists.length === 0 ? (
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
                onClick={openMissionSetup}
              />
            }
          />
        ) : (
          <div className="task-board-workspace__lists">
            {visibleLists.map((list, listIndex) => (
              <section
                key={list.id}
                className="task-board-workspace__list"
                aria-label={`Lista de tarefas ${listIndex + 1}`}
              >
                <header className="task-board-workspace__list-header">
                  <h2>Lista {listIndex + 1}</h2>
                  <span>
                    {list.items.length}{' '}
                    {list.items.length === 1 ? 'tarefa' : 'tarefas'}
                  </span>
                </header>
                <ul className="task-board-workspace__items">
                  {list.items.map((item, itemIndex) => {
                    const key = `${list.id}\u0000${item.id}`;
                    const isPending = pending.has(key);
                    const error = errors[key];
                    const errorId = error
                      ? `task-board-error-${listIndex + 1}-${itemIndex + 1}`
                      : undefined;

                    return (
                      <li
                        key={item.id}
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
                          <p
                            id={errorId}
                            className="task-board-workspace__error"
                            role="alert"
                          >
                            {error}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
