import { useEffect, useState } from 'react';
import { usePanelZ } from '../lib/panel-stack';
import type { Mission, MissionStatus } from '../../shared/orch-types';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { askConfirm } from '../state/confirm-store';
import { confirmAndBlockMission } from '../orch/block-mission';
import { useGamificationStore } from '../state/gamification-store';
import { confirmAndReopenMission } from '../orch/confirm-reopen-mission';
import { ChosenPetPortrait } from './ChosenPetPortrait';
import { NexusMark } from './NexusMark';
import { PixelIcon } from './PixelIcon';
import {
  MISSION_STATUS_LABELS,
  canDropMission,
  formatAgo,
  groupMissionsIntoColumns,
} from '../lib/ops-board';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { listPanes } from '../lib/split-tree';
import { formatShortcut } from '../lib/platform';
import {
  AgentAvatar,
  resolveAgentCategory,
  summarizeAgentStates,
  type AgentVisualState,
} from './AgentAvatar';

/**
 * Ops Board — o pipeline de missões como superfície espacial (war-room).
 * Mesmo domínio do MissionRail/OrchestrationPanel, outra projeção: colunas
 * por status com trilho semântico, arrastar = planejar (override de status),
 * "rodando" só via Retomar (agentes reais no grid). ⌘B abre/fecha.
 */

interface DragState {
  id: string;
  from: MissionStatus;
}

export function OpsBoard() {
  const open = useOrchStore((s) => s.boardOpen);
  const { zIndex: stackZ, bringToFront } = usePanelZ('ops-board', open);
  const closeBoard = useOrchStore((s) => s.closeBoard);
  const missions = useOrchStore((s) => s.missions);
  const squads = useOrchStore((s) => s.squads);
  const paneMissions = useOrchStore((s) => s.paneMissions);
  const layoutRoot = useLayoutStore((s) => s.root);
  const focusPane = useLayoutStore((s) => s.focus);
  const paneStates = useSessionStateStore((s) => s.paneStates);
  const openWizard = useMissionWizardStore((s) => s.openForMission);
  const snapshot = useGamificationStore((s) => s.snapshot);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropCol, setDropCol] = useState<MissionStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeBoard();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeBoard]);

  if (!open) return null;

  const columns = groupMissionsIntoColumns(missions);
  const openMissionIds = new Set(Object.values(paneMissions));
  const squadNames = new Map(squads.map((s) => [s.id, s.name]));
  const panes = listPanes(layoutRoot);
  const now = Date.now();

  async function dropOn(to: MissionStatus) {
    const current = drag;
    setDrag(null);
    setDropCol(null);
    if (!current || !canDropMission(current.from, to)) return;
    try {
      await window.nexus.orch.updateMission(current.id, { status: to });
      setNote(null);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Falha ao mover a missão.');
    }
  }

  function retomar(m: Mission) {
    setBusy(m.id);
    setNote(null);
    void confirmAndReopenMission(m)
      .then((r) => {
        if (!r.ok) setNote(r.error ?? 'Falha ao retomar.');
      })
      .finally(() => setBusy(null));
  }

  async function remover(m: Mission, active: boolean) {
    const ok = await askConfirm({
      title: `Remover "${m.title}"?`,
      body: active
        ? 'A missão está aberta. Remover tira o registro da lista; os panes continuam abertos.'
        : 'A missão sai da lista de trabalho.',
      confirmLabel: 'Remover missão',
      danger: true,
    });
    if (!ok) return;
    void window.nexus.orch.removeMission(m.id).then((r) => {
      if (!r.removed) setNote('Missão já não estava na lista.');
    });
  }

  async function encerrarComoBloqueada(m: Mission) {
    setBusy(m.id);
    setNote(null);
    const result = await confirmAndBlockMission(m);
    if (!result.ok && !result.cancelled && result.error) setNote(result.error);
    setBusy(null);
  }

  return (
    <section
      className="ops-board"
      aria-label="Ops Board — pipeline de missões"
      style={{ zIndex: stackZ }}
      onMouseDownCapture={bringToFront}
    >
      <header className="ops-board__head">
        <span className="ops-board__mark" aria-hidden="true">
          <NexusMark size={13} />
        </span>
        <div className="ops-board__head-text">
          <h2 className="ops-board__title">Ops Board</h2>
          <span className="ops-board__sub">
            {missions.length} miss{missions.length === 1 ? 'ão' : 'ões'} · arraste para planejar
            · {formatShortcut('mod', 'B')} fecha
          </span>
        </div>
        <span className="ops-board__spacer" />
        <button
          className="ops-board__new"
          onClick={openWizard}
          title="Nova missão (livre ou squad)"
        >
          <PixelIcon name="mission" />
          Missão
        </button>
        <button
          className="ops-board__close"
          onClick={closeBoard}
          title="Fechar o board (Esc)"
          aria-label="Fechar Ops Board"
        >
          <PixelIcon name="close" size={10} />
        </button>
      </header>

      {missions.length === 0 ? (
        <div className="ops-board__empty">
          <ChosenPetPortrait
            size={48}
            mood="idle"
            fallbackTier={snapshot.tier}
            fallbackBranch={snapshot.branch}
            fallbackSkin={snapshot.selectedSkin}
          />
          <p className="ops-board__empty-title">Nenhuma missão no pipeline</p>
          <p className="ops-board__empty-sub">
            Toda missão criada aparece aqui — na fila, rodando, travada, concluída.
          </p>
          <button
            type="button"
            className="action-card action-card--primary ops-board__new-cta"
            onClick={openWizard}
          >
            <span className="action-card__icon" aria-hidden>
              <PixelIcon name="mission" size={18} />
            </span>
            <span className="action-card__copy">
              <strong className="action-card__title">
                Iniciar a primeira missão
              </strong>
              <small className="action-card__sub">
                Abre o wizard de squad / objetivo
              </small>
            </span>
          </button>
        </div>
      ) : (
        <div className="ops-board__cols">
          {columns.map((col) => {
            const droppable = drag ? canDropMission(drag.from, col.status) : false;
            return (
              <section
                key={col.status}
                className={[
                  'ops-board__col',
                  `ops-board__col--${col.status}`,
                  dropCol === col.status && droppable ? 'ops-board__col--drop' : '',
                ].join(' ')}
                aria-label={`Coluna ${MISSION_STATUS_LABELS[col.status]}`}
                onDragOver={(e) => {
                  if (!droppable) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDropCol(col.status);
                }}
                onDrop={() => void dropOn(col.status)}
              >
                <div className="ops-board__col-rail" aria-hidden="true" />
                <header className="ops-board__col-head">
                  <span className="ops-board__col-glyph" aria-hidden="true" />
                  <span className="ops-board__col-label">
                    {MISSION_STATUS_LABELS[col.status]}
                  </span>
                  <span className="ops-board__count">{col.missions.length}</span>
                </header>

                <div className="ops-board__cards">
                  {col.missions.length === 0 ? (
                    <div className="ops-board__empty-col">
                      <ChosenPetPortrait
                        size={34}
                        mood="sleeping"
                        fallbackTier={snapshot.tier}
                        fallbackBranch={snapshot.branch}
                        fallbackSkin={snapshot.selectedSkin}
                      />
                      <span>operador ocioso</span>
                    </div>
                  ) : (
                    col.missions.map((m) => {
                      const active = openMissionIds.has(m.id);
                      const squad = m.squadId
                        ? squads.find((candidate) => candidate.id === m.squadId)
                        : undefined;
                      const livePanes = panes.filter(
                        (pane) =>
                          pane.kind === 'cli-agent' && paneMissions[pane.id] === m.id,
                      );
                      const crew =
                        livePanes.length > 0
                          ? livePanes.slice(0, 4).map((pane) => ({
                              key: pane.id,
                              paneId: pane.id,
                              label: pane.agentName ?? pane.title,
                              category: resolveAgentCategory(
                                squads,
                                pane.agentName,
                                pane.role,
                              ),
                              state: (paneStates.get(pane.id) ??
                                'spawning') as AgentVisualState,
                            }))
                          : (squad?.agents.slice(0, 4).map((agent) => ({
                              key: agent.id,
                              paneId: undefined,
                              label: agent.agentName,
                              category: agent.category,
                              state: 'offline' as AgentVisualState,
                            })) ?? []);
                      return (
                        <article
                          key={m.id}
                          className={[
                            'ops-board__card',
                            drag?.id === m.id ? 'ops-board__card--dragging' : '',
                          ].join(' ')}
                          draggable
                          aria-roledescription="cartão de missão"
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', m.title);
                            setDrag({ id: m.id, from: col.status });
                          }}
                          onDragEnd={() => {
                            setDrag(null);
                            setDropCol(null);
                          }}
                        >
                          <div className="ops-board__card-top">
                            <span
                              className={`ops-board__badge ${m.squadId ? '' : 'ops-board__badge--livre'}`}
                            >
                              {m.squadId
                                ? (squadNames.get(m.squadId) ?? 'squad')
                                : 'livre'}
                            </span>
                            {active && (
                              <span className="ops-board__live" title="Missão aberta no grid">
                                <span className="ops-board__dot" aria-hidden="true" /> aberta
                              </span>
                            )}
                          </div>
                          <h3 className="ops-board__card-title">{m.title}</h3>
                          {crew.length > 0 && (
                            <div className="ops-board__crew">
                              <span className="agent-avatar-group" aria-label="Tripulação da missão">
                                {crew.map((agent) =>
                                  agent.paneId ? (
                                    <button
                                      type="button"
                                      className="ops-board__agent-focus"
                                      key={agent.key}
                                      title={`Focar ${agent.label}`}
                                      aria-label={`Focar ${agent.label}`}
                                      onMouseDown={(event) => event.stopPropagation()}
                                      onDragStart={(event) => event.stopPropagation()}
                                      onClick={() => {
                                        focusPane(agent.paneId!);
                                        closeBoard();
                                      }}
                                    >
                                      <AgentAvatar
                                        category={agent.category}
                                        state={agent.state}
                                        size="card"
                                        label={agent.label}
                                        className="ops-board__agent-avatar"
                                      />
                                    </button>
                                  ) : (
                                    <AgentAvatar
                                      key={agent.key}
                                      category={agent.category}
                                      state={agent.state}
                                      size="card"
                                      label={agent.label}
                                      className="ops-board__agent-avatar"
                                    />
                                  ),
                                )}
                              </span>
                              <span className="ops-board__crew-state">
                                {summarizeAgentStates(crew.map((agent) => agent.state))}
                              </span>
                            </div>
                          )}
                          <div className="ops-board__card-meta">
                            <span>{formatAgo(now, m.updatedAt)}</span>
                            {m.milestones.length > 0 && (
                              <span>
                                {m.milestones.length} marco
                                {m.milestones.length === 1 ? '' : 's'}
                              </span>
                            )}
                          </div>
                          <div className="ops-board__card-actions">
                            {!active && (
                              <button
                                className="ops-board__card-btn"
                                disabled={busy !== null}
                                onClick={() => retomar(m)}
                                title="Restaura os panes desta missão (as CLIs voltam com --continue)"
                              >
                                {busy === m.id ? (
                                  'retomando…'
                                ) : (
                                  <span className="ops-board__resume-label">
                                    <PixelIcon name="mission" size={8} /> retomar
                                  </span>
                                )}
                              </button>
                            )}
                            {(m.status === 'pending' || m.status === 'running') && (
                              <button
                                className="ops-board__card-btn ops-board__card-btn--danger"
                                disabled={busy !== null}
                                onClick={() => void encerrarComoBloqueada(m)}
                                title="Encerrar como bloqueada (com justificativa; não é done)"
                              >
                                bloquear
                              </button>
                            )}
                            <button
                              className="ops-board__card-btn ops-board__card-btn--danger"
                              onClick={() => remover(m, active)}
                              title="Remover esta missão da lista"
                            >
                              remover
                            </button>
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {note && (
        <p className="ops-board__note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
