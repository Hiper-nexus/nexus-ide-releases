import { useState } from 'react';
import type {
  Handoff,
  Mission,
  Squad,
  TodoItem,
  TodoList,
} from '../../shared/orch-types';
import { useOrchStore, type OrchPanelTab } from '../state/orch-store';
import { confirmAndReopenMission } from '../orch/confirm-reopen-mission';

/**
 * Orchestration drawer — the mission control surface (docs/ARCHITECTURE.md
 * §E.6). Reads as a mission timeline, not a debug dump: each mission shows how
 * many worker deliveries it has collected; the handoff feed shows who reported
 * to the orchestrator, whether the delivery is still pending, and its
 * artifacts. Todos and squad management round it out.
 */

const TABS: Array<{ id: OrchPanelTab; label: string }> = [
  { id: 'missions', label: 'Missões' },
  { id: 'handoffs', label: 'Entregas' },
  { id: 'todos', label: 'Tarefas' },
  { id: 'squads', label: 'Squads' },
];

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path
      d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

function MissionRow({
  mission,
  handoffCount,
  onReopen,
  onRemove,
}: {
  mission: Mission;
  handoffCount: number;
  onReopen: (mission: Mission) => void;
  onRemove: (mission: Mission) => void;
}) {
  return (
    <li className="orch-item">
      <div className="orch-item__head">
        <span className={`orch-badge orch-badge--${mission.status}`}>
          {mission.status}
        </span>
        <span className="orch-item__title">{mission.title}</span>
        {handoffCount > 0 && (
          <span className="orch-tag">
            {handoffCount} entrega{handoffCount === 1 ? '' : 's'}
          </span>
        )}
        <button
          className="orch-panel__btn"
          onClick={() => onReopen(mission)}
          title="Restaura os panes da missão; as CLIs retomam a conversa com --resume"
        >
          Reabrir
        </button>
        <button
          className="orch-item__remove"
          onClick={() => onRemove(mission)}
          title="Remover esta missão da lista"
          aria-label={`Remover missão ${mission.title}`}
        >
          <CloseIcon />
        </button>
      </div>
      {mission.description && (
        <p className="orch-item__detail">{mission.description}</p>
      )}
      {mission.milestones.length > 0 && (
        <p className="orch-item__detail">
          Marcos: {mission.milestones.join(' · ')}
        </p>
      )}
      <span className="orch-item__meta">{timeLabel(mission.createdAt)}</span>
    </li>
  );
}

/** A best-effort human label for one handoff artifact (path/name/url or JSON). */
function artifactLabel(artifact: unknown): string {
  if (typeof artifact === 'string') return artifact;
  if (artifact && typeof artifact === 'object') {
    const o = artifact as Record<string, unknown>;
    for (const key of ['path', 'name', 'file', 'url', 'title']) {
      if (typeof o[key] === 'string') return o[key] as string;
    }
  }
  return JSON.stringify(artifact).slice(0, 100);
}

function HandoffRow({ handoff }: { handoff: Handoff }) {
  const artifacts = Array.isArray(handoff.artifacts) ? handoff.artifacts : [];
  return (
    <li className="orch-item">
      <div className="orch-item__head">
        <span className={`orch-badge orch-badge--${handoff.status}`}>
          {handoff.status}
        </span>
        <span className="orch-item__title">
          {(handoff.fromAgent ?? 'worker') + ' → orquestrador'}
        </span>
        <span
          className={`orch-tag ${handoff.delivered ? 'orch-tag--done' : 'orch-tag--pending'}`}
        >
          {handoff.delivered ? 'entregue' : 'pendente'}
        </span>
      </div>
      <p className="orch-item__detail">{handoff.summary}</p>
      {artifacts.length > 0 && (
        <ul className="orch-artifacts" aria-label="Artefatos">
          {artifacts.map((artifact, i) => (
            <li key={i} className="orch-artifacts__item">
              {artifactLabel(artifact)}
            </li>
          ))}
        </ul>
      )}
      <span className="orch-item__meta">{timeLabel(handoff.createdAt)}</span>
    </li>
  );
}

const TODO_STATUS_LABEL: Record<TodoItem['status'], string> = {
  done: 'feito',
  in_progress: 'em andamento',
  todo: 'a fazer',
};

function TodoListBlock({ list }: { list: TodoList }) {
  if (list.items.length === 0) return null;
  return (
    <li className="orch-item">
      <div className="orch-item__head">
        <span className="orch-item__title">{list.id}</span>
      </div>
      <ul className="orch-todo-list">
        {list.items.map((item) => (
          <li
            key={item.id}
            className={`orch-todo orch-todo--${item.status}`}
            aria-label={`${TODO_STATUS_LABEL[item.status]}: ${item.name}`}
          >
            <span
              className={`orch-todo__dot orch-todo__dot--${item.status}`}
              aria-hidden="true"
            />
            <span className="orch-todo__label">{item.name}</span>
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
          title="Remover este squad"
        >
          Remover
        </button>
      </div>
      <p className="orch-item__detail">
        {squad.agents.length} agente{squad.agents.length === 1 ? '' : 's'}:{' '}
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
      result.ok ? `Exportado para ${result.path}` : result.error ?? 'Exportação cancelada',
    );
  }

  async function onImport() {
    const result = await window.nexus.orch.importSquads();
    setNotice(
      result.ok
        ? `Importado: ${result.count} squad(s)`
        : result.error ?? 'Importação cancelada',
    );
  }

  function onDeleteSquad(id: string) {
    void window.nexus.orch.deleteSquad(id);
  }

  function onReopenMission(mission: Mission) {
    void (async () => {
      const result = await confirmAndReopenMission(mission);
      if (!result.ok) {
        setNotice(result.error ?? 'Falha ao reabrir a missão.');
        return;
      }
      if (result.soft) {
        setNotice('Missão já aberta — foco nos panes ao vivo (sem kill).');
        return;
      }
      setNotice(
        result.multi
          ? `Missão em paralelo: ${result.panes} pane(s) adicionados (multi-missão).`
          : `Missão reaberta: ${result.panes} pane(s) restaurado(s), retomando as conversas.`,
      );
    })();
  }

  function onRemoveMission(mission: Mission) {
    if (
      !window.confirm(
        `Remover a missão "${mission.title}" da lista? Os panes abertos continuam; só o registro sai.`,
      )
    ) {
      return;
    }
    void window.nexus.orch.removeMission(mission.id).then((r) => {
      if (!r.removed) setNotice('Missão já não estava na lista.');
    });
  }

  const visibleTodoLists = todoLists.filter((l) => l.items.length > 0);
  const handoffCountByMission = new Map<string, number>();
  for (const h of handoffs) {
    if (h.missionId) {
      handoffCountByMission.set(
        h.missionId,
        (handoffCountByMission.get(h.missionId) ?? 0) + 1,
      );
    }
  }

  return (
    <aside className="orch-panel" aria-label="Orquestração">
      <header className="orch-panel__header">
        <span className="orch-panel__title">Orquestração</span>
        <span className="orch-panel__mcp">
          {mcpInfo?.running
            ? `MCP · ${mcpInfo.toolCount} tools`
            : 'MCP offline'}
        </span>
        <button
          className="orch-panel__btn orch-panel__icon-btn"
          onClick={togglePanel}
          aria-label="Fechar painel de orquestração"
        >
          <CloseIcon />
        </button>
      </header>

      <nav className="orch-panel__tabs" aria-label="Seções da orquestração">
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
                Nenhuma missão ainda. Inicie um squad na barra de missões — o
                orquestrador abre a missão e começa a delegar aos workers.
              </p>
            ) : (
              <ul className="orch-list">
                {missions.map((m) => (
                  <MissionRow
                    key={m.id}
                    mission={m}
                    handoffCount={handoffCountByMission.get(m.id) ?? 0}
                    onReopen={onReopenMission}
                    onRemove={onRemoveMission}
                  />
                ))}
              </ul>
            )}
          </>
        )}

        {tab === 'handoffs' &&
          (handoffs.length === 0 ? (
            <p className="orch-panel__empty">
              Nenhuma entrega ainda. Cada worker publica aqui o resultado assim
              que conclui a tarefa que recebeu.
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
              Sem tarefas publicadas. Elas aparecem aqui conforme o orquestrador
              divide a missão em passos.
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
                Importar…
              </button>
              <button
                className="orch-panel__btn"
                onClick={onExport}
                disabled={squads.length === 0}
              >
                Exportar…
              </button>
            </div>
            {notice && <p className="orch-panel__notice">{notice}</p>}
            {squads.length === 0 ? (
              <p className="orch-panel__empty">
                Nenhum squad salvo. Importe um arquivo de squads ou monte um
                pela barra de missões.
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
