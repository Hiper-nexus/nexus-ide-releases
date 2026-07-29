import { useState } from 'react';
import { usePanelZ } from '../lib/panel-stack';
import type {
  Handoff,
  Mission,
  Squad,
  TodoItem,
  TodoList,
} from '../../shared/orch-types';
import { isMissionRuntimeSquadId } from '../../shared/orch-types';
import { useOrchStore, type OrchPanelTab } from '../state/orch-store';
import { askConfirm } from '../state/confirm-store';
import { confirmAndReopenMission } from '../orch/confirm-reopen-mission';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { EmptyState, ActionCard } from './ActionCard';
import { SquadEditor } from './SquadEditor';
import { EndorphinPresence } from './EndorphinPresence';
import {
  orchHandoffsEmptyBeat,
  orchMissionsEmptyBeat,
  orchTodosEmptyBeat,
} from '../../shared/endorphin';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { listPanes } from '../lib/split-tree';
import {
  AgentAvatar,
  agentVisualStateLabel,
  type AgentVisualState,
} from './AgentAvatar';
import { ProviderLogo } from './ProviderLogo';
import { livePaneIdsForMission } from '../orch/mission-reopen';
import {
  discardMissionPrompt,
  missionActionCopy,
  missionListAction,
  removeMissionPrompt,
} from '../orch/mission-list-action';
import { toUserFacingMissionError } from '../lib/user-facing-mission-error';
import { closeMissionRuntimeAndPanes } from '../orch/close-mission-runtime';
import { MissionResultDetail } from './MissionResultDetail';

/**
 * Orchestration drawer — the mission control surface (docs/ARCHITECTURE.md
 * §E.6). Reads as a mission timeline, not a debug dump: each mission shows how
 * many worker deliveries it has collected; the handoff feed shows who reported
 * to the orchestrator, whether the delivery is still pending, and its
 * artifacts. Todos and squad management round it out.
 */

const ORCH_MISSIONS_EMPTY = orchMissionsEmptyBeat();
const ORCH_HANDOFFS_EMPTY = orchHandoffsEmptyBeat();
const ORCH_TODOS_EMPTY = orchTodosEmptyBeat();

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
  onViewResult,
  onRemove,
  hasVisiblePanes,
}: {
  mission: Mission;
  handoffCount: number;
  onReopen: (mission: Mission) => void;
  onViewResult: (mission: Mission) => void;
  onRemove: (mission: Mission) => void;
  hasVisiblePanes: boolean;
}) {
  const listAction = missionListAction(mission, hasVisiblePanes);
  const hasTerminalResult =
    mission.status === 'done' || mission.status === 'failed';
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
          onClick={() =>
            hasTerminalResult
              ? onViewResult(mission)
              : onReopen(mission)
          }
          title={
            hasTerminalResult
              ? 'Abre o relatório persistido sem iniciar uma CLI'
              : 'Restaura os panes da missão; as CLIs retomam a conversa com --resume'
          }
        >
          {hasTerminalResult ? 'Ver resultado' : 'Reabrir'}
        </button>
        {listAction !== 'none' && (
          <button
            className="orch-item__remove"
            onClick={() => onRemove(mission)}
            title={missionActionCopy(listAction).title}
            aria-label={`${missionActionCopy(listAction).verb} missão ${mission.title}`}
          >
            <CloseIcon />
          </button>
        )}
      </div>
      {mission.description && (
        <p className="orch-item__detail">{mission.description}</p>
      )}
      {mission.milestones.length > 0 && (
        <p className="orch-item__detail">
          Marcos:{' '}
          {mission.milestones.map((step) => step.label).join(' · ')}
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
  onEdit,
}: {
  squad: Squad;
  onDelete: (id: string) => void;
  onEdit: (squad: Squad) => void;
}) {
  const root = useLayoutStore((s) => s.root);
  const paneStates = useSessionStateStore((s) => s.paneStates);
  const panes = listPanes(root);

  return (
    <li className="orch-item">
      <div className="orch-item__head">
        <span className="orch-item__title">{squad.name}</span>
        <div className="orch-item__actions">
          <button
            className="orch-panel__btn"
            onClick={() => onEdit(squad)}
            title={
              squad.builtin
                ? 'Duplicar este squad interno para personalizar'
                : 'Editar nome, roster e modelos'
            }
          >
            {squad.builtin ? 'Personalizar' : 'Editar'}
          </button>
          {!squad.builtin && (
            <button
              className="orch-panel__btn orch-panel__btn--danger"
              onClick={() => onDelete(squad.id)}
              title="Remover este squad"
            >
              Remover
            </button>
          )}
        </div>
      </div>
      <ul className="orch-agent-roster" aria-label={`${squad.agents.length} agentes`}>
        {squad.agents.map((agent) => {
          const pane = panes.find((candidate) => candidate.agentName === agent.agentName);
          const state: AgentVisualState = pane
            ? (paneStates.get(pane.id) ?? 'spawning')
            : 'offline';
          return (
            <li className="orch-agent-roster__item" key={agent.id}>
              <AgentAvatar
                category={agent.category}
                state={state}
                size="card"
                label={agent.agentName}
              />
              <span className="orch-agent-roster__identity">
                <strong>{agent.agentName}</strong>
                <small>
                  <ProviderLogo adapterId={agent.cli} label={agent.cli} size="xs" />
                  <span>{agent.category} · {agent.cli}</span>
                </small>
              </span>
              <span className={`orch-agent-roster__state orch-agent-roster__state--${state}`}>
                {agentVisualStateLabel(state)}
              </span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function OrchestrationPanel() {
  const panelOpen = useOrchStore((s) => s.panelOpen);
  const { zIndex: stackZ, bringToFront } = usePanelZ('orch', panelOpen);
  const togglePanel = useOrchStore((s) => s.togglePanel);
  const missions = useOrchStore((s) => s.missions);
  const handoffs = useOrchStore((s) => s.handoffs);
  const todoLists = useOrchStore((s) => s.todoLists);
  const squads = useOrchStore((s) => s.squads);
  const visibleSquads = squads.filter(
    (squad) => !isMissionRuntimeSquadId(squad.id),
  );
  const mcpInfo = useOrchStore((s) => s.mcpInfo);
  const tab = useOrchStore((s) => s.panelTab);
  const selectedMissionId = useOrchStore((s) => s.selectedMissionId);
  const openMissionDetail = useOrchStore((s) => s.openMissionDetail);
  const clearMissionDetail = useOrchStore((s) => s.clearMissionDetail);
  const setTab = useOrchStore((s) => s.setPanelTab);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Squad | null>(null);

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

  async function onRemoveMission(mission: Mission) {
    const paneIds = livePaneIdsForMission(mission.id);
    const action = missionListAction(mission, paneIds.length > 0);
    if (action === 'none') return;
    if (action === 'close-runtime') {
      const result = await closeMissionRuntimeAndPanes(
        mission.id,
        'orch-panel-close',
      );
      if (!result.ok && result.cancelled) return;
      setNotice(
        result.ok
          ? 'Missão encerrada; histórico preservado.'
          : result.error ?? 'Falha ao encerrar a missão.',
      );
      return;
    }
    const prompt =
      action === 'remove'
        ? removeMissionPrompt(mission)
        : discardMissionPrompt(mission);
    const ok = await askConfirm({ ...prompt, danger: true });
    if (!ok) return;
    void window.nexus.orch
      .removeMission(mission.id)
      .then((r) => {
        if (!r.removed) setNotice('Missão já não estava na lista.');
      })
      .catch((cause) => {
        setNotice(toUserFacingMissionError(cause, 'Falha ao remover a missão.'));
      });
  }

  const visibleTodoLists = todoLists.filter((l) => l.items.length > 0);
  const selectedMission =
    missions.find((mission) => mission.id === selectedMissionId) ?? null;
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
    <aside
      className="orch-panel"
      aria-label="Orquestração"
      style={{ zIndex: stackZ }}
      onMouseDownCapture={bringToFront}
    >
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
            {selectedMission ? (
              <MissionResultDetail
                mission={selectedMission}
                onBack={clearMissionDetail}
              />
            ) : missions.length === 0 ? (
              <EmptyState
                className="orch-panel__empty-state orch-panel__empty--story"
                icon="mission"
                title={ORCH_MISSIONS_EMPTY.title}
                body={
                  <>
                    <EndorphinPresence
                      kicker={ORCH_MISSIONS_EMPTY.kicker}
                      mood="idle"
                      size={44}
                      className="endorphin-presence--row orch-panel__empty-presence"
                    />
                    <p>{ORCH_MISSIONS_EMPTY.line}</p>
                  </>
                }
                action={
                  <ActionCard
                    icon="mission"
                    title="Lançar missão"
                    subtitle="Descrever objetivo e revisar equipe"
                    variant="primary"
                    onClick={() =>
                      useMissionWizardStore.getState().openForAgentic()
                    }
                  />
                }
              />
            ) : (
              <ul className="orch-list">
                {missions.map((m) => (
                  <MissionRow
                    key={m.id}
                    mission={m}
                    handoffCount={handoffCountByMission.get(m.id) ?? 0}
                    onReopen={onReopenMission}
                    onViewResult={(mission) =>
                      openMissionDetail(mission.id)
                    }
                    onRemove={onRemoveMission}
                    hasVisiblePanes={
                      livePaneIdsForMission(m.id).length > 0
                    }
                  />
                ))}
              </ul>
            )}
          </>
        )}

        {tab === 'handoffs' &&
          (handoffs.length === 0 ? (
            <EmptyState
              className="orch-panel__empty--story"
              icon="agent"
              title={ORCH_HANDOFFS_EMPTY.title}
              body={
                <>
                  <EndorphinPresence
                    kicker={ORCH_HANDOFFS_EMPTY.kicker}
                    mood="idle"
                    size={40}
                    className="endorphin-presence--row orch-panel__empty-presence"
                  />
                  <p>{ORCH_HANDOFFS_EMPTY.line}</p>
                </>
              }
            />
          ) : (
            <ul className="orch-list">
              {[...handoffs].reverse().map((h) => (
                <HandoffRow key={h.id} handoff={h} />
              ))}
            </ul>
          ))}

        {tab === 'todos' &&
          (visibleTodoLists.length === 0 ? (
            <EmptyState
              className="orch-panel__empty--story"
              icon="board"
              title={ORCH_TODOS_EMPTY.title}
              body={
                <>
                  <EndorphinPresence
                    kicker={ORCH_TODOS_EMPTY.kicker}
                    mood="idle"
                    size={40}
                    className="endorphin-presence--row orch-panel__empty-presence"
                  />
                  <p>{ORCH_TODOS_EMPTY.line}</p>
                </>
              }
            />
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
                disabled={visibleSquads.length === 0}
              >
                Exportar…
              </button>
            </div>
            {notice && <p className="orch-panel__notice">{notice}</p>}
            {visibleSquads.length === 0 ? (
              <EmptyState
                icon="users"
                title="Nenhum squad salvo"
                body={
                  <p>
                    Importe um arquivo de squads ou monte um pela barra de
                    missões.
                  </p>
                }
                action={
                  <ActionCard
                    icon="users"
                    title="Configurar squad"
                    subtitle="Abrir configuração técnica"
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      useMissionWizardStore.getState().openForMission()
                    }
                  />
                }
              />
            ) : (
              <ul className="orch-list">
                {visibleSquads.map((s) => (
                  <SquadRow
                    key={s.id}
                    squad={s}
                    onDelete={onDeleteSquad}
                    onEdit={setEditing}
                  />
                ))}
              </ul>
            )}
            {editing && (
              <SquadEditor
                key={editing.id}
                squad={editing}
                onClose={() => setEditing(null)}
                onSaved={(message) => setNotice(message)}
              />
            )}
          </>
        )}
      </div>
    </aside>
  );
}
