import type { SquadAgent } from '../../shared/orch-types';

/**
 * F-1500: spawning by name (`findAgentInSquad`) resolves a member only when
 * its name is unique in the squad — with two "Dev" neither one opens. Names
 * compare without surrounding spaces, like the lookup's trimmed fallback.
 * Returns the first repeated (trimmed) name, or null.
 */
export function duplicateAgentName(
  agents: readonly Pick<SquadAgent, 'agentName'>[],
): string | null {
  const seen = new Set<string>();
  for (const agent of agents) {
    const name = agent.agentName.trim();
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return null;
}

/**
 * Only new saves, prepares and imports (F-1503) are refused: squads already
 * stored keep loading and resolving (see `matchAgentRef` in squad-store).
 */
export function assertUniqueAgentNames(
  agents: readonly Pick<SquadAgent, 'agentName'>[],
): void {
  const name = duplicateAgentName(agents);
  if (name !== null) {
    throw new Error(
      `A equipe tem mais de um integrante chamado \`${name}\`. ` +
        'Dê um nome diferente a cada um e tente de novo.',
    );
  }
}
