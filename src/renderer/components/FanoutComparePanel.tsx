import { useMemo } from 'react';
import { useOrchStore } from '../state/orch-store';
import { PixelIcon } from './PixelIcon';

/**
 * Fan-out compare — quando um objetivo é despachado para vários agentes,
 * mostra o output mais recente de cada um lado a lado, para comparar
 * resultados sem abrir pane por pane. Escopado à missão mais recente que tem
 * 2+ agentes com handoff (fan-out é por missão; misturar missões confundiria).
 * Só aparece quando há pelo menos 2 agentes.
 */

const STATUS_TONE: Record<string, string> = {
  success: 'ok',
  partial: 'warn',
  progress: 'running',
  stalled: 'warn',
  blocked: 'failed',
  failed: 'failed',
};

interface AgentColumn {
  agent: string;
  summary: string;
  status: string;
  at: number;
}

export function FanoutComparePanel() {
  const handoffs = useOrchStore((s) => s.handoffs);
  const missions = useOrchStore((s) => s.missions);

  const columns = useMemo<AgentColumn[]>(() => {
    const byMission = new Map<string, Map<string, AgentColumn>>();
    for (const h of handoffs) {
      if (!h.missionId) continue;
      const agent = h.fromAgent ?? 'agente';
      let agents = byMission.get(h.missionId);
      if (!agents) {
        agents = new Map();
        byMission.set(h.missionId, agents);
      }
      const existing = agents.get(agent);
      if (!existing || h.createdAt > existing.at) {
        agents.set(agent, {
          agent,
          summary: h.summary,
          status: h.status,
          at: h.createdAt,
        });
      }
    }

    // Pick the most recently updated mission that actually fanned out (2+ agents).
    const sorted = [...missions].sort(
      (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
    );
    for (const mission of sorted) {
      const agents = byMission.get(mission.id);
      if (agents && agents.size >= 2) {
        return [...agents.values()].sort((a, b) => b.at - a.at);
      }
    }
    return [];
  }, [handoffs, missions]);

  if (columns.length < 2) return null;

  return (
    <section className="fanout" aria-label="Comparação de outputs dos agentes">
      <header className="fanout__head">
        <PixelIcon name="users" size={12} />
        <span className="fanout__title">Fan-out · {columns.length} agentes</span>
      </header>
      <div className="fanout__grid">
        {columns.map((col) => (
          <article
            key={col.agent}
            className={`fanout__card fanout__card--${STATUS_TONE[col.status] ?? 'idle'}`}
          >
            <header className="fanout__card-head">
              <span className="fanout__agent">{col.agent}</span>
              <span className="fanout__status">{col.status}</span>
            </header>
            <p className="fanout__summary">{col.summary || '—'}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
