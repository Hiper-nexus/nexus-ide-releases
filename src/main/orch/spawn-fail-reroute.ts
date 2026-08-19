/**
 * Política pura: falha física de spawn → mensagem civil + sucessor no roster.
 * Sem toast vocabulary de PR69; só a frase acionável e o agente seguinte.
 */

export interface SpawnFailRosterAgent {
  readonly id: string;
  readonly agentName: string;
  readonly category: string;
  readonly cli: string;
  readonly model?: string;
  readonly effort?: string;
}

const PREFERRED_REROUTE_CLIS = ['claude', 'codex'] as const;

export function civilianSpawnFailMessage(input: {
  readonly deadAdapterId: string;
  readonly deadLabel?: string;
  readonly successorCli?: string;
  readonly successorName?: string;
}): string {
  const dead = input.deadLabel?.trim() || input.deadAdapterId;
  if (input.successorCli && input.successorName) {
    return (
      `${dead} não iniciou — a tarefa foi reatribuída a ` +
      `${input.successorName} (${input.successorCli}).`
    );
  }
  return (
    `${dead} não iniciou. Escolha Claude ou Codex e tente de novo.`
  );
}

/**
 * Escolhe o próximo escritor do roster (mesma categoria), preferindo
 * Claude/Codex e evitando CLIs já esgotadas nesta tentativa.
 */
export function selectSpawnFailSuccessor(input: {
  readonly deadAdapterId: string;
  readonly preferredCategory: string;
  readonly roster: readonly SpawnFailRosterAgent[];
  readonly exhaustedAdapterIds?: readonly string[];
}): SpawnFailRosterAgent | null {
  const exhausted = new Set(
    (input.exhaustedAdapterIds ?? []).map((id) => id.toLowerCase()),
  );
  exhausted.add(input.deadAdapterId.toLowerCase());

  const sameCategory = input.roster.filter(
    (agent) =>
      agent.category === input.preferredCategory &&
      !exhausted.has(agent.cli.toLowerCase()),
  );
  for (const preferred of PREFERRED_REROUTE_CLIS) {
    const hit = sameCategory.find(
      (agent) => agent.cli.toLowerCase() === preferred,
    );
    if (hit) return hit;
  }
  return sameCategory[0] ?? null;
}

export function isLikelyBootSpawnFailure(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return /spawn|pane spawn|failed to start|not installed|não.*instal|timeout|ENOENT|effort|binário|binary|auth|login|mcp/i.test(
    message,
  );
}
