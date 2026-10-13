import type { SquadAgent } from '../../shared/orch-types';

/**
 * F-1500: spawning by name (`findAgentInSquad`) resolves a member only when
 * its name is unique in the squad — with two "Dev" neither one opens. Names
 * compare without surrounding spaces, like the lookup's trimmed fallback. Only
 * new saves and prepares are refused: squads already stored keep loading and
 * resolving (see `matchAgentRef`).
 */
export function assertUniqueAgentNames(
  agents: readonly Pick<SquadAgent, 'agentName'>[],
): void {
  const seen = new Set<string>();
  for (const agent of agents) {
    const name = agent.agentName.trim();
    if (seen.has(name)) {
      throw new Error(
        `A equipe tem mais de um integrante chamado \`${name}\`. ` +
          'Dê um nome diferente a cada um e tente de novo.',
      );
    }
    seen.add(name);
  }
}
