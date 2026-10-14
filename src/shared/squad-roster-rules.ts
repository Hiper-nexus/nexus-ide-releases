import type { SquadAgent } from './orch-types';

/** Teto de integrantes de uma missão (Nova missão › Equipe aceita até 12). */
export const MISSION_ROSTER_MAX_AGENTS = 12;

/**
 * F-1503: a forma que todo squad salvo precisa ter para virar missão —
 * exatamente um coordenador (`assertRosterShape` na preparação e
 * `maestro-count` no approve) e no máximo 12 integrantes (o roster da Nova
 * missão). Devolve o problema em pt-BR para compor `O squad "X" <problema>`,
 * ou null quando o squad pode ser usado. Executor/revisor dependem da
 * modalidade e a etapa Equipe completa, por isso ficam fora daqui.
 */
export function squadRosterUsabilityIssue(
  agents: readonly Pick<SquadAgent, 'category'>[],
): string | null {
  const coordinators = agents.filter(
    (agent) => agent.category === 'orchestrator',
  ).length;
  if (coordinators !== 1) {
    return (
      'precisa de exatamente um coordenador (categoria "orchestrator") ' +
      `e tem ${coordinators}`
    );
  }
  if (agents.length > MISSION_ROSTER_MAX_AGENTS) {
    return (
      `tem ${agents.length} integrantes e uma missão aceita no máximo ` +
      `${MISSION_ROSTER_MAX_AGENTS}; remova ` +
      `${agents.length - MISSION_ROSTER_MAX_AGENTS}`
    );
  }
  return null;
}
