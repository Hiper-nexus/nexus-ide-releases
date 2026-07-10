import { useState } from 'react';
import type { Mission } from '../../shared/orch-types';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useSessionStateStore } from '../state/session-state-store';
import { reopenMission } from '../orch/mission-reopen';
import { PixelIcon } from './PixelIcon';

/**
 * Trilha de missões (lateral esquerda). Toda missão criada fica listada e
 * acessível: abrir uma nova NÃO apaga a anterior — ela continua aqui, e um
 * clique a retoma (as CLIs voltam com --continue). Resolve o "abri outra
 * missão e perdi a primeira". Só UMA missão fica viva por vez (um único
 * orquestrador Claude — senão as instâncias corrompem o login compartilhado).
 */

function statusLabel(s: Mission['status']): string {
  return (
    { pending: 'na fila', running: 'rodando', blocked: 'travada', done: 'concluída', failed: 'falhou' }[
      s
    ] ?? s
  );
}

export function MissionRail() {
  const missions = useOrchStore((s) => s.missions);
  const paneMissions = useOrchStore((s) => s.paneMissions);
  const openMissionWizard = useMissionWizardStore((s) => s.openForMission);
  const paneStates = useSessionStateStore((s) => s.paneStates);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function removeMission(m: Mission, active: boolean) {
    const warn = active
      ? `A missão "${m.title}" está aberta. Remover da lista? Os panes continuam abertos.`
      : `Remover a missão "${m.title}" da lista?`;
    if (!window.confirm(warn)) return;
    setNote(null);
    void window.nexus.orch
      .removeMission(m.id)
      .then((r) => {
        if (!r.removed) setNote('Missão já não estava na lista.');
      })
      .catch((cause) => {
        setNote(
          cause instanceof Error ? cause.message : 'Falha ao remover a missão.',
        );
      });
  }
  // Uma missão está ABERTA se algum pane vivo no grid pertence a ela.
  const openMissionIds = new Set(Object.values(paneMissions));

  if (missions.length === 0) return null;

  // Missão realmente aberta primeiro; dentro de cada grupo, atividade recente.
  const ordered = [...missions].sort((a, b) => {
    const activeDelta = Number(openMissionIds.has(b.id)) - Number(openMissionIds.has(a.id));
    return activeDelta || b.updatedAt - a.updatedAt;
  });
  const activeCount = ordered.filter((mission) => openMissionIds.has(mission.id)).length;

  function missionMeta(mission: Mission, active: boolean): string {
    if (!active) return `Retomar · ${statusLabel(mission.status)}`;
    const paneIds = Object.entries(paneMissions)
      .filter(([, missionId]) => missionId === mission.id)
      .map(([paneId]) => paneId);
    const busyCount = paneIds.filter((paneId) => paneStates.get(paneId) === 'busy').length;
    const spawningCount = paneIds.filter(
      (paneId) => paneStates.get(paneId) === 'spawning',
    ).length;
    if (busyCount > 0) {
      return `${busyCount} pane${busyCount === 1 ? '' : 's'} trabalhando`;
    }
    if (spawningCount > 0) {
      return `${spawningCount} pane${spawningCount === 1 ? '' : 's'} iniciando`;
    }
    return `${paneIds.length} pane${paneIds.length === 1 ? '' : 's'} pronto${paneIds.length === 1 ? '' : 's'}`;
  }

  return (
    <aside className="mission-rail" aria-label="Missões">
      <header className="mission-rail__head">
        <div className="mission-rail__heading">
          <span className="mission-rail__title">Missões</span>
          <span className="mission-rail__summary">
            {activeCount} ativa{activeCount === 1 ? '' : 's'} de {missions.length}
          </span>
        </div>
        <button
          className="mission-rail__new"
          title="Iniciar uma nova missão (a atual fica salva aqui)"
          aria-label="Iniciar nova missão"
          onClick={openMissionWizard}
        >
          <PixelIcon name="plus" size={10} /> <span>Nova</span>
        </button>
      </header>

      <ul className="mission-rail__list">
        {ordered.map((m) => {
          const active = openMissionIds.has(m.id);
          return (
            <li key={m.id} className="mission-rail__row">
              <button
                className={`mission-rail__item ${active ? 'mission-rail__item--active' : ''}`}
                disabled={busy !== null}
                aria-current={active ? 'true' : undefined}
                title={active ? 'Missão aberta agora' : 'Retomar esta missão (restaura os panes)'}
                onClick={() => {
                  if (active) return;
                  setBusy(m.id);
                  setNote(null);
                  void reopenMission(m)
                    .then((r) => {
                      if (!r.ok) setNote(r.error ?? 'Falha ao retomar.');
                    })
                    .catch((cause) => {
                      setNote(
                        cause instanceof Error
                          ? cause.message
                          : 'Falha ao retomar a missão.',
                      );
                    })
                    .finally(() => setBusy(null));
                }}
              >
                <span className={`mission-rail__dot mission-rail__dot--${m.status}`} />
                <span className="mission-rail__item-body">
                  <span className="mission-rail__item-title">{m.title}</span>
                  <span className="mission-rail__item-meta">
                    {busy === m.id ? 'Retomando…' : missionMeta(m, active)}
                  </span>
                </span>
              </button>
              <button
                className="mission-rail__remove"
                disabled={busy !== null}
                title="Remover esta missão da lista"
                aria-label={`Remover missão ${m.title}`}
                onClick={() => removeMission(m, active)}
              >
                <PixelIcon name="close" size={10} />
              </button>
            </li>
          );
        })}
      </ul>
      {note && <p className="mission-rail__note" role="status">{note}</p>}
    </aside>
  );
}
