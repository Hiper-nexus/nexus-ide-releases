import { useState } from 'react';
import type { Mission } from '../../shared/orch-types';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { reopenMission } from '../orch/mission-reopen';

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
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Uma missão está ABERTA se algum pane vivo no grid pertence a ela.
  const openMissionIds = new Set(Object.values(paneMissions));

  if (missions.length === 0) return null;

  // Mais recentes primeiro.
  const ordered = [...missions].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <aside className="mission-rail" aria-label="Missões">
      <header className="mission-rail__head">
        <span className="mission-rail__title">Missões</span>
        <button
          className="mission-rail__new"
          title="Iniciar uma nova missão (a atual fica salva aqui)"
          onClick={openMissionWizard}
        >
          ＋ Nova
        </button>
      </header>

      <ul className="mission-rail__list">
        {ordered.map((m) => {
          const active = openMissionIds.has(m.id);
          return (
            <li key={m.id}>
              <button
                className={`mission-rail__item ${active ? 'mission-rail__item--active' : ''}`}
                disabled={busy !== null}
                title={active ? 'Missão aberta agora' : 'Retomar esta missão (restaura os panes)'}
                onClick={() => {
                  if (active) return;
                  setBusy(m.id);
                  setNote(null);
                  void reopenMission(m).then((r) => {
                    setBusy(null);
                    if (!r.ok) setNote(r.error ?? 'Falha ao retomar.');
                  });
                }}
              >
                <span className={`mission-rail__dot mission-rail__dot--${m.status}`} />
                <span className="mission-rail__item-body">
                  <span className="mission-rail__item-title">{m.title}</span>
                  <span className="mission-rail__item-meta">
                    {active ? 'aberta' : statusLabel(m.status)}
                    {busy === m.id ? ' · retomando…' : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {note && <p className="mission-rail__note">{note}</p>}
    </aside>
  );
}
