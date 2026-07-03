import { useState } from 'react';
import type {
  Handoff,
  Mission,
  Squad,
  TodoItem,
  TodoList,
} from '../../shared/orch-types';
import { useOrchStore, type OrchPanelTab } from '../state/orch-store';
import { reopenMission } from '../orch/mission-reopen';

/**
 * Orchestration drawer — the mission/handoff/todo/squad debug view that
 * Overclock lacks (docs/ARCHITECTURE.md §E.6): live mission timeline, handoff
 * audit trail, visible todo milestones and squad management with
 * export/import.
 */

const TABS: Array<{ id: OrchPanelTab; label: string }> = [
  { id: 'missions', label: 'Missions' },
  { id: 'handoffs', label: 'Handoffs' },
  { id: 'todos', label: 'Todos' },
  { id: 'squads', label: 'Squads' },
];

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function MissionRow({
  mission,
  onReopen,
}: {
  mission: Mission;
  onReopen: (mission: Mission) => void;
}) {
  return (
    <li className="orch-item">
      <div className="orch-item__head">
        <span className={`orch-badge orch-badge--${mission.status}`}>
          {mission.status}
        </span>
        <span className="orch-item__title">{mission.title}</span>
        <button
          className="orch-panel__btn"
          onClick={() => onReopen(mission)}
          title="Reabrir esta missão restaurando os panes (as CLIs retomam a conversa com --resume)"
        >
          ↻
        </button>
      </div>
      {mission.description && (
        <p className="orch-item__detail">{mission.description}</p>
      )}
      {mission.milestones.length > 0 && (
        <p className="orch-item__detail">
          milestones: {mission.milestones.join(' · ')}
        </p>
      )}
      <span className="orch-item__meta">
        {mission.id} · {timeLabel(mission.createdAt)}
      </span>
    </li>
  );
}

function HandoffRow({ handoff }: { handoff: Handoff }) {
  return (
    <li className="orch-item">
      <div className="orch-item__head">
        <span className={`orch-badge orch-badge--${handoff.status}`}>
          {handoff.status}
        </span>
        <span className="orch-item__title">
          {handoff.fromAgent ?? 'worker'}
        </span>
        {handoff.delivered && (
          <span className="orch-item__meta">delivered</span>
        )}
      </div>
      <p className="orch-item__detail">{handoff.summary}</p>
      <span className="orch-item__meta">{timeLabel(handoff.createdAt)}</span>
    </li>
  );
}

function todoGlyph(status: TodoItem['status']): string {
  if (status === 'done') return '✓';
  if (status === 'in_progress') return '▸';
  return '○';
}

function TodoListBlock({ list }: { list: TodoList }) {
  if (list.items.length === 0) return null;
  return (
    <li className="orch-item">
      <div className="orch-item__head">
        <span className="orch-item__title">{list.id}</span>
      </div>
      <ul className="orch-todo-list">
        {list.items.map((item) => (
          <li key={item.id} className={`orch-todo orch-todo--${item.status}`}>
            <span className="orch-todo__glyph">{todoGlyph(item.status)}</span>
            {item.name}
          </li>
        ))}
      </ul>
    </li>
  );
}

function SquadRow({
  squad,
  onDelete,
}: {
  squad: Squad;
  onDelete: (id: string) => void;
}) {
  return (
    <li className="orch-item">
      <div className="orch-item__head">
        <span className="orch-item__title">{squad.name}</span>
        <button
          className="orch-panel__btn orch-panel__btn--danger"
          onClick={() => onDelete(squad.id)}
          title="Delete squad"
        >
          ✕
        </button>
      </div>
      <p className="orch-item__detail">
        {squad.agents.length} agent{squad.agents.length === 1 ? '' : 's'}:{' '}
        {squad.agents
          .map((a) => `${a.agentName} (${a.category}/${a.cli})`)
          .join(', ') || '—'}
      </p>
    </li>
  );
}

export function OrchestrationPanel() {
  const panelOpen = useOrchStore((s) => s.panelOpen);
  const togglePanel = useOrchStore((s) => s.togglePanel);
  const missions = useOrchStore((s) => s.missions);
  const handoffs = useOrchStore((s) => s.handoffs);
  const todoLists = useOrchStore((s) => s.todoLists);
  const squads = useOrchStore((s) => s.squads);
  const mcpInfo = useOrchStore((s) => s.mcpInfo);
  const tab = useOrchStore((s) => s.panelTab);
  const setTab = useOrchStore((s) => s.setPanelTab);
  const [notice, setNotice] = useState<string | null>(null);

  if (!panelOpen) return null;

  async function onExport() {
    const result = await window.nexus.orch.exportSquads();
    setNotice(
      result.ok ? `Exported to ${result.path}` : result.error ?? 'Export cancelled',
    );
  }

  async function onImport() {
    const result = await window.nexus.orch.importSquads();
    setNotice(
      result.ok
        ? `Imported ${result.count} squad(s)`
        : result.error ?? 'Import cancelled',
    );
  }

  function onDeleteSquad(id: string) {
    void window.nexus.orch.deleteSquad(id);
  }

  function onReopenMission(mission: Mission) {
    void (async () => {
      const result = await reopenMission(mission);
      setNotice(
        result.ok
          ? `Missão reaberta: ${result.panes} pane(s) restaurado(s), retomando as conversas.`
          : result.error ?? 'Falha ao reabrir a missão.',
      );
    })();
  }

  const visibleTodoLists = todoLists.filter((l) => l.items.length > 0);

  return (
    <aside className="orch-panel" aria-label="Orchestration">
      <header className="orch-panel__header">
        <span className="orch-panel__title">Orchestration</span>
        <span className="orch-panel__mcp">
          {mcpInfo?.running
            ? `MCP · ${mcpInfo.toolCount} tools`
            : 'MCP offline'}
        </span>
        <button
          className="orch-panel__btn"
          onClick={togglePanel}
          aria-label="Close orchestration panel"
        >
          ✕
        </button>
      </header>

      <nav className="orch-panel__tabs" aria-label="Orchestration sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`orch-panel__tab ${tab === t.id ? 'orch-panel__tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="orch-panel__body">
        {tab === 'missions' && (
          <>
            {notice && <p className="orch-panel__notice">{notice}</p>}
            {missions.length === 0 ? (
              <p className="orch-panel__empty">
                No missions yet. Agents create them via nexus_mission_create.
              </p>
            ) : (
              <ul className="orch-list">
                {missions.map((m) => (
                  <MissionRow key={m.id} mission={m} onReopen={onReopenMission} />
                ))}
              </ul>
            )}
          </>
        )}

        {tab === 'handoffs' &&
          (handoffs.length === 0 ? (
            <p className="orch-panel__empty">
              No handoffs submitted. Workers report via nexus_handoff_submit.
            </p>
          ) : (
            <ul className="orch-list">
              {[...handoffs].reverse().map((h) => (
                <HandoffRow key={h.id} handoff={h} />
              ))}
            </ul>
          ))}

        {tab === 'todos' &&
          (visibleTodoLists.length === 0 ? (
            <p className="orch-panel__empty">
              No task lists. Agents publish milestones via nexus_todo_manager.
            </p>
          ) : (
            <ul className="orch-list">
              {visibleTodoLists.map((list) => (
                <TodoListBlock key={list.id} list={list} />
              ))}
            </ul>
          ))}

        {tab === 'squads' && (
          <>
            <div className="orch-panel__toolbar">
              <button className="orch-panel__btn" onClick={onImport}>
                Import…
              </button>
              <button
                className="orch-panel__btn"
                onClick={onExport}
                disabled={squads.length === 0}
              >
                Export…
              </button>
            </div>
            {notice && <p className="orch-panel__notice">{notice}</p>}
            {squads.length === 0 ? (
              <p className="orch-panel__empty">
                No squads saved. Save one via nexus_squad_save or import an
                Overclock squads.json.
              </p>
            ) : (
              <ul className="orch-list">
                {squads.map((s) => (
                  <SquadRow key={s.id} squad={s} onDelete={onDeleteSquad} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
