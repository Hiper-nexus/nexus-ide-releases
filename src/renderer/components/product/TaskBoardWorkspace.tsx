import { useEffect, useMemo, useRef, useState } from 'react';
import type { TodoItem, TodoList, TodoStatus } from '../../../shared/orch-types';
import { orchTodosEmptyBeat } from '../../../shared/endorphin';
import {
  MISSION_KANBAN_LANES,
  MISSION_KANBAN_LANE_LABELS,
  relativeAgeLabel,
  type MissionKanbanLane,
} from '../../../shared/mission-kanban';
import {
  groupTaskBoardMissionsByLane,
  isRemovableTaskBoardMission,
  projectTaskBoardEntries,
  taskBoardIsEmpty,
  type TaskBoardMissionEntry,
  type TaskBoardTodoEntry,
} from '../../lib/task-board-projection';
import { confirmAndRemoveMission } from '../../orch/remove-mission-flow';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useToastStore } from '../../state/toast-store';
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

/** Lanes vivas viram colunas; o arquivo é gaveta recolhida no rodapé. */
const KANBAN_COLUMNS = MISSION_KANBAN_LANES.filter(
  (lane) => lane.placement === 'column',
);

const LANE_EMPTY_COPY: Readonly<Record<MissionKanbanLane, string>> = {
  building: 'Nada em construção',
  validating: 'Nada para validar',
  needs_you: 'Nada pendente com você',
  ready: 'Nada pronto ainda',
  archive: 'Nada arquivado',
};

/** A idade relativa não tem segundos, então um tique por minuto basta. */
const AGE_TICK_MS = 60_000;

function isoStamp(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

interface MissionKanbanCardProps {
  readonly entry: TaskBoardMissionEntry;
  readonly now: number;
  readonly onOpen: (missionId: string) => void;
}

/**
 * Card = título + estado em palavra + idade curta. Sem arrastar: a lane é
 * derivada. Missão sem processo (arquivada ou parada) ganha "Remover" (F-741).
 */
function MissionKanbanCard({ entry, now, onOpen }: MissionKanbanCardProps) {
  const { summary } = entry;
  const removable = isRemovableTaskBoardMission(entry);
  return (
    <li
      className="mission-kanban__card"
      data-state={summary.state}
      data-attention={summary.needsAttention ? 'true' : undefined}
      data-removable={removable ? 'true' : undefined}
    >
      {removable ? (
        <button
          type="button"
          className="mission-kanban__card-remove"
          aria-label={`Remover a missão ${entry.name}`}
          title="Remover missão"
          onClick={() => {
            void confirmAndRemoveMission({
              missionId: summary.id,
              title: entry.name,
            });
          }}
        >
          <PixelIcon name="trash" size={12} />
        </button>
      ) : null}
      <button
        type="button"
        className="mission-kanban__card-open"
        onClick={() => onOpen(summary.id)}
      >
        <span className="mission-kanban__card-title">{entry.name}</span>
        <span className="mission-kanban__card-meta">
          <span className="mission-kanban__card-state">{entry.stateLabel}</span>
          <span className="mission-kanban__card-sep" aria-hidden="true">
            ·
          </span>
          <time
            className="mission-kanban__card-age"
            dateTime={isoStamp(summary.updatedAt)}
          >
            {relativeAgeLabel(summary.updatedAt, now)}
          </time>
        </span>
      </button>
    </li>
  );
}

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
  const missionSummaries = useOrchStore((state) => state.missionSummaries);
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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    pendingWrites.current.clear();
    setPending(new Map());
    setErrors({});
  }, [workspaceEpoch, boundWorkspacePath]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const boardEntries = useMemo(
    () => projectTaskBoardEntries({ missions, missionSummaries, todoLists }),
    [missions, missionSummaries, todoLists],
  );
  const missionLanes = useMemo(
    () => groupTaskBoardMissionsByLane(boardEntries),
    [boardEntries],
  );
  const todoEntries = useMemo(
    () =>
      boardEntries.filter(
        (entry): entry is TaskBoardTodoEntry => entry.kind === 'todo',
      ),
    [boardEntries],
  );
  const itemCount = boardEntries.length;
  const todoCount = todoEntries.length;
  const missionCount = itemCount - todoCount;

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

  // "Limpar concluídas" — a política vive no main (board-clear-plan):
  // missão viva perde só itens concluídos; lista terminal/órfã sai inteira.
  const clearableCount = todoEntries.filter(
    (entry) => entry.status === 'done',
  ).length;
  const [clearArmed, setClearArmed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const clearConcluded = async (): Promise<void> => {
    if (clearing) return;
    if (!clearArmed) {
      setClearArmed(true);
      setClearError(null);
      return;
    }
    const writeScope = useOrchStore.getState();
    setClearing(true);
    setClearError(null);
    try {
      const result = await window.nexus.orch.clearTodoBoard();
      const currentScope = useOrchStore.getState();
      if (
        currentScope.workspaceEpoch === writeScope.workspaceEpoch &&
        currentScope.boundWorkspacePath === writeScope.boundWorkspacePath
      ) {
        useOrchStore.setState({ todoLists: result.todoLists });
      }
      setClearArmed(false);
      useToastStore.getState().push(
        'info',
        'Quadro limpo',
        result.removedLists + result.removedItems > 0
          ? `${result.removedLists} ${result.removedLists === 1 ? 'lista' : 'listas'} e ${result.removedItems} ${result.removedItems === 1 ? 'tarefa concluída' : 'tarefas concluídas'} saíram do quadro.`
          : 'Nada concluído para limpar agora.',
      );
    } catch {
      const currentScope = useOrchStore.getState();
      if (
        currentScope.workspaceEpoch === writeScope.workspaceEpoch &&
        currentScope.boundWorkspacePath === writeScope.boundWorkspacePath
      ) {
        setClearError('Não foi possível limpar o quadro agora.');
      }
    } finally {
      setClearing(false);
    }
  };

  // Tarefas seguem em colunas por status canônico (todo/in_progress/done),
  // sem expor ids de lista. Missões vivem em lanes derivadas, acima.
  const columns = TODO_STATUS_OPTIONS.map((option) => ({
    status: option.value,
    label: option.label,
    entries: todoEntries.filter((entry) => entry.status === option.value),
  }));
  const archived = missionLanes.archive;
  const showMissionKanban = missionCount > 0;
  // Sem missão, as colunas ficam visíveis embaixo do empty state (o CTA
  // senta acima delas). Com missão e sem tarefa, três colunas vazias seriam
  // só ruído abaixo das lanes.
  const showTodoColumns = todoCount > 0 || missionCount === 0;

  return (
    <section
      className="product-workspace product-page task-board-workspace"
      aria-label="Quadro de tarefas"
    >
      <header className="product-workspace__header">
        <div className="product-workspace__identity">
          <span className="product-workspace__badge" aria-hidden="true">
            <PixelIcon name="board" size={16} />
          </span>
          <div className="product-workspace__heading">
            <span className="product-workspace__context">
              Missões e tarefas
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
        <div className="task-board-workspace__actions">
        {clearableCount > 0 ? (
          <div className="task-board-workspace__clear-group">
            {clearError ? (
              <span
                className="task-board-workspace__clear-error"
                role="alert"
              >
                {clearError}
              </span>
            ) : null}
            <button
              type="button"
              className={`task-board-workspace__clear${
                clearArmed ? ' task-board-workspace__clear--armed' : ''
              }`}
              disabled={clearing}
              aria-label={
                clearArmed
                  ? 'Confirmar: limpar tarefas concluídas do quadro'
                  : 'Limpar tarefas concluídas do quadro'
              }
              onClick={() => void clearConcluded()}
            >
              {clearing
                ? 'Limpando…'
                : clearArmed
                  ? 'Confirmar limpeza'
                  : `Limpar concluídas (${clearableCount})`}
            </button>
            {clearArmed && !clearing ? (
              <button type="button" className="task-board-workspace__cancel" aria-label="Cancelar limpeza" onClick={() => setClearArmed(false)}>Cancelar</button>
            ) : null}
          </div>
        ) : null}
        {!boardEmpty ? <button type="button" className="task-board-workspace__new" onClick={openNewMission}>Nova missão</button> : null}
        </div>
      </header>

      <div className="product-workspace__content task-board-workspace__content">
        {boardEmpty ? (
          <EmptyState
            icon="board"
            title={emptyBeat.title}
            body="As tarefas aparecem aqui conforme sua missão avança."
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

        {showMissionKanban ? (
          <section className="mission-kanban" aria-label="Missões por estado">
            <p className="task-board-workspace__group-label">Missões</p>
            <div className="mission-kanban__lanes">
              {KANBAN_COLUMNS.map((lane) => {
                const members = missionLanes[lane.id];
                return (
                  <section
                    key={lane.id}
                    className="mission-kanban__lane"
                    data-lane={lane.id}
                    data-empty={members.length === 0 ? 'true' : undefined}
                    aria-label={`Missões: ${lane.label}`}
                  >
                    <header className="mission-kanban__lane-header">
                      <span
                        className="mission-kanban__lane-dot"
                        aria-hidden="true"
                      />
                      <h2 className="mission-kanban__lane-name">{lane.label}</h2>
                      <span
                        className="mission-kanban__lane-sep"
                        aria-hidden="true"
                      >
                        ·
                      </span>
                      <span className="mission-kanban__lane-count">
                        {members.length}
                      </span>
                    </header>
                    {members.length === 0 ? (
                      <p className="mission-kanban__lane-empty">
                        {LANE_EMPTY_COPY[lane.id]}
                      </p>
                    ) : (
                      <ul className="mission-kanban__cards">
                        {members.map((entry) => (
                          <MissionKanbanCard
                            key={entry.key}
                            entry={entry}
                            now={now}
                            onOpen={openMission}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
            {archived.length > 0 ? (
              <details className="mission-kanban__archive">
                <summary className="mission-kanban__archive-summary">
                  <span
                    className="mission-kanban__lane-dot"
                    aria-hidden="true"
                  />
                  <span className="mission-kanban__lane-name">
                    {MISSION_KANBAN_LANE_LABELS.archive}
                  </span>
                  <span className="mission-kanban__lane-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="mission-kanban__lane-count">
                    {archived.length}
                  </span>
                </summary>
                <ul className="mission-kanban__cards">
                  {archived.map((entry) => (
                    <MissionKanbanCard
                      key={entry.key}
                      entry={entry}
                      now={now}
                      onOpen={openMission}
                    />
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : null}

        {showTodoColumns ? (
          <section
            className="task-board-workspace__todos"
            aria-label="Tarefas por status"
          >
            {showMissionKanban ? (
              <p className="task-board-workspace__group-label">Tarefas</p>
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
          </section>
        ) : null}
      </div>
    </section>
  );
}
