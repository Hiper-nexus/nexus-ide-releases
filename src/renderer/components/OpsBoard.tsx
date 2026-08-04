import { useEffect, useState } from 'react';
import { usePanelZ } from '../lib/panel-stack';
import type { Mission, MissionStatus } from '../../shared/orch-types';
import { useOrchStore } from '../state/orch-store';
import { presentMissionFailure } from '../../shared/mission-failure-presentation';
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
  isMissionBoardRecovering,
} from '../lib/ops-board';
import { useLayoutStore } from '../state/layout-store';
import { useWorkspaceStore } from '../state/workspace-store';
import {
  loadArchivedMissionIds,
} from '../lib/mission-rail-prefs';
import { useSessionStateStore } from '../state/session-state-store';
import { listPanes } from '../lib/split-tree';
import { formatShortcut } from '../lib/platform';
import {
  AgentAvatar,
  resolveAgentCategory,
  summarizeAgentStates,
  type AgentVisualState,
} from './AgentAvatar';
import {
  removeMissionPrompt,
  discardMissionPrompt,
  missionActionCopy,
  missionListAction,
} from '../orch/mission-list-action';
import {
  closeMissionNote,
  closeMissionRuntimeAndPanes,
} from '../orch/close-mission-runtime';
import { toUserFacingMissionError } from '../lib/user-facing-mission-error';

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

  const workspacePath = useWorkspaceStore((s) => s.current?.path ?? null);
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

  // Arquivadas saem do board pelo mesmo motivo que saem do rail: o operador
  // já tirou da mesa. Nada é apagado — reaparecem ao desarquivar no rail.
  const archivedSet = new Set(loadArchivedMissionIds(workspacePath));
  const columns = groupMissionsIntoColumns(
    missions.filter((m) => !archivedSet.has(m.id)),
  );
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
      // Raw IPC/English diagnostics must not reach the operator here.
      setNote(toUserFacingMissionError(err, 'Falha ao mover a missão.'));
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

  async function closeOrDiscard(m: Mission, active: boolean) {
    const action = missionListAction(m, active);
    if (action === 'none') return;
    if (action === 'close-runtime' || action === 'stop-recovery') {
      setBusy(m.id);
      try {
        const result = await closeMissionRuntimeAndPanes(
          m.id,
          'ops-board-close',
        );
        if (!result.ok && result.cancelled) return;
        setNote(
          result.ok
            ? closeMissionNote(result.terminatedSessionIds.length)
            : result.error ?? 'Falha ao encerrar a missão.',
        );
      } finally {
        setBusy(null);
      }
      return;
    }
    const prompt =
      action === 'remove' ? removeMissionPrompt(m) : discardMissionPrompt(m);
    const ok = await askConfirm({ ...prompt, danger: true });
    if (!ok) return;
    void window.nexus.orch
      .removeMission(m.id)
      .then((r) => {
        if (!r.removed) setNote('Missão já não estava na lista.');
      })
      .catch((cause) => {
        setNote(toUserFacingMissionError(cause, 'Falha ao remover a missão.'));
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
          onClick={() => openWizard()}
          title="Nova missão — escolher modo"
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
            onClick={() => openWizard()}
          >
            <span className="action-card__icon" aria-hidden>
              <PixelIcon name="mission" size={18} />
            </span>
            <span className="action-card__copy">
              <strong className="action-card__title">
                Iniciar a primeira missão
              </strong>
              <small className="action-card__sub">
                Descrever objetivo e revisar equipe
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
                      <div className="ops-board__empty-icon" aria-hidden="true">
                        {col.status === 'pending' && (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                          </svg>
                        )}
                        {col.status === 'running' && (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                        )}
                        {col.status === 'blocked' && (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                          </svg>
                        )}
                        {col.status === 'done' && (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                            <polyline points="22 4 12 14.01 9 11.01" />
                          </svg>
                        )}
                        {col.status === 'failed' && (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                          </svg>
                        )}
                      </div>
                      <span className="ops-board__empty-label">Nenhuma missão</span>
                      <small>Arraste uma missão para esta etapa.</small>
                    </div>
                  ) : (
                    col.missions.map((m) => {
                      const active = openMissionIds.has(m.id);
                      const recovering = isMissionBoardRecovering(m);
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
                          draggable={!recovering}
                          aria-roledescription="cartão de missão"
                          onDragStart={(e) => {
                            if (recovering) {
                              e.preventDefault();
                              return;
                            }
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
                            {(active || recovering) && (
                              <span
                                className="ops-board__live"
                                title={
                                  recovering
                                    ? 'Recuperação automática em andamento'
                                    : 'Missão aberta no grid'
                                }
                              >
                                <span className="ops-board__dot" aria-hidden="true" />{' '}
                                {recovering ? 'recuperando' : 'aberta'}
                              </span>
                            )}
                          </div>
                          <h3 className="ops-board__card-title">
                            <button
                              type="button"
                              className="ops-board__card-open"
                              title="Abrir o diagnóstico e o relatório desta missão"
                              onMouseDown={(event) => event.stopPropagation()}
                              onDragStart={(event) => event.stopPropagation()}
                              onClick={() => {
                                useOrchStore.getState().openMissionDetail(m.id);
                                closeBoard();
                              }}
                            >
                              {m.title}
                            </button>
                          </h3>
                          {m.status === 'blocked' &&
                            (() => {
                              const headline = presentMissionFailure(
                                m.description ?? '',
                              ).headline;
                              return headline ? (
                                <div
                                  className="ops-board__card-failure-box"
                                  title={headline}
                                >
                                  <svg className="ops-board__card-failure-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/>
                                    <line x1="12" y1="9" x2="12" y2="13"/>
                                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                                  </svg>
                                  <span className="ops-board__card-failure-text">{headline}</span>
                                </div>
                              ) : null;
                            })()}
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
                            {!active && !recovering && (
                              <button
                                className="ops-board__card-btn ops-board__card-btn--resume"
                                disabled={busy !== null}
                                onClick={() => retomar(m)}
                                title="Restaura os panes desta missão (as CLIs voltam com --continue)"
                              >
                                {busy === m.id ? (
                                  'retomando…'
                                ) : (
                                  <span className="ops-board__resume-label">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                      <polygon points="5 3 19 12 5 21 5 3" />
                                    </svg>
                                    retomar
                                  </span>
                                )}
                              </button>
                            )}
                            {(m.status === 'pending' || m.status === 'running') && (
                              <button
                                className="ops-board__card-btn ops-board__card-btn--block"
                                disabled={busy !== null}
                                onClick={() => void encerrarComoBloqueada(m)}
                                title="Encerrar como bloqueada (com justificativa; não é done)"
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="12" cy="12" r="10"/>
                                  <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                                </svg>
                                bloquear
                              </button>
                            )}
                            {missionListAction(m, active) !== 'none' && (
                              <button
                                className="ops-board__card-btn ops-board__card-btn--dismiss"
                                onClick={() => closeOrDiscard(m, active)}
                                title={
                                  missionActionCopy(
                                    missionListAction(m, active),
                                  ).title
                                }
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <line x1="18" y1="6" x2="6" y2="18"/>
                                  <line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                                {missionActionCopy(
                                  missionListAction(m, active),
                                ).verb.toLowerCase()}
                              </button>
                            )}
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
