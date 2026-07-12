import { useEffect, useState } from 'react';
import type { Mission, MissionStatus } from '../../shared/orch-types';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { askConfirm } from '../state/confirm-store';
import { useGamificationStore } from '../state/gamification-store';
import { confirmAndReopenMission } from '../orch/confirm-reopen-mission';
import { OperatorSprite } from './OperatorSprite';
import { NexusMark } from './NexusMark';
import { PixelIcon } from './PixelIcon';
import {
  MISSION_STATUS_LABELS,
  canDropMission,
  formatAgo,
  groupMissionsIntoColumns,
} from '../lib/ops-board';

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
  const closeBoard = useOrchStore((s) => s.closeBoard);
  const missions = useOrchStore((s) => s.missions);
  const squads = useOrchStore((s) => s.squads);
  const paneMissions = useOrchStore((s) => s.paneMissions);
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

  return (
    <section className="ops-board" aria-label="Ops Board — pipeline de missões">
      <header className="ops-board__head">
        <span className="ops-board__mark" aria-hidden="true">
          <NexusMark size={13} />
        </span>
        <div className="ops-board__head-text">
          <h2 className="ops-board__title">Ops Board</h2>
          <span className="ops-board__sub">
            {missions.length} miss{missions.length === 1 ? 'ão' : 'ões'} · arraste para planejar
            · ⌘B fecha
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
          <OperatorSprite
            size={48}
            tier={snapshot.tier}
            branch={snapshot.branch}
            skin={snapshot.selectedSkin}
            mood="idle"
          />
          <p className="ops-board__empty-title">Nenhuma missão no pipeline</p>
          <p className="ops-board__empty-sub">
            Toda missão criada aparece aqui — na fila, rodando, travada, concluída.
          </p>
          <button className="ops-board__new" onClick={openWizard}>
            <PixelIcon name="mission" />
            Iniciar a primeira missão
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
                      <OperatorSprite
                        size={34}
                        tier={snapshot.tier}
                        branch={snapshot.branch}
                        skin={snapshot.selectedSkin}
                        mood="sleeping"
                      />
                      <span>operador ocioso</span>
                    </div>
                  ) : (
                    col.missions.map((m) => {
                      const active = openMissionIds.has(m.id);
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
