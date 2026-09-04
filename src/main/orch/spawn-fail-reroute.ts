/**
 * Política pura: falha física de spawn → mensagem civil + sucessor no roster.
 * Sem toast vocabulary de PR69; só a frase acionável e o agente seguinte.
 */

import { QUOTA_HIGH_USAGE_THRESHOLD } from '../../shared/quota-types';

export interface SpawnFailRosterAgent {
  readonly id: string;
  readonly agentName: string;
  readonly category: string;
  readonly cli: string;
  readonly model?: string;
  readonly effort?: string;
}

const PREFERRED_REROUTE_CLIS = ['claude', 'codex'] as const;

/**
 * Pior janela de quota conhecida por CLI (0..1, null = desconhecida).
 * Só penaliza com sinal conhecido ≥ threshold — quota desconhecida ou
 * inferida nunca desvia a rota sozinha (herança Orca: observabilidade
 * primeiro, enforcement só com provider-api/limit-hit).
 */
export type QuotaWorstRatioByCli = Readonly<Record<string, number | null>>;

export function isQuotaHighUsage(
  cli: string,
  quotaWorstRatioByCli: QuotaWorstRatioByCli | undefined,
  threshold = QUOTA_HIGH_USAGE_THRESHOLD,
): boolean {
  if (!quotaWorstRatioByCli) return false;
  const key = cli.toLowerCase();
  const worst =
    quotaWorstRatioByCli[key] ?? quotaWorstRatioByCli[cli] ?? null;
  return worst !== null && worst >= threshold;
}

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
  /** Pior janela de quota por CLI. Ausente = comportamento anterior. */
  readonly quotaWorstRatioByCli?: QuotaWorstRatioByCli;
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
  // Quota alta desvia para um fresco da mesma categoria; se todos estão em
  // alta, mantém o pool cheio (fail-closed nunca piora a seleção).
  const fresh = sameCategory.filter(
    (agent) => !isQuotaHighUsage(agent.cli, input.quotaWorstRatioByCli),
  );
  const pool = fresh.length > 0 ? fresh : sameCategory;
  for (const preferred of PREFERRED_REROUTE_CLIS) {
    const hit = pool.find((agent) => agent.cli.toLowerCase() === preferred);
    if (hit) return hit;
  }
  return pool[0] ?? null;
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
