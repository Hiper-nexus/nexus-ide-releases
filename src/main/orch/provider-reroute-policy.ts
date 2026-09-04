import type { TaskPlanAgentSnapshot } from "./task-store";
import type { TaskProviderRerouteDirective } from "./task-dispatch-codec";
import { QUOTA_HIGH_USAGE_THRESHOLD } from "../../shared/quota-types";

export const PROVIDER_REROUTE_MARKER = "[NEXUS_PROVIDER_REROUTE]";

/**
 * Política pura do reroute dentro do roster selado.
 *
 * Um worker que esgota as tentativas físicas de spawn prova que aquela CLI
 * está inutilizável agora (auth, cota, binário quebrado). O plano selado não
 * muda: a task apenas é re-vinculada a OUTRO agente do MESMO roster, da MESMA
 * categoria, cuja CLI ainda não foi provada morta para esta task. Nunca é um
 * waiver — a task continua obrigatória e o selo do roster continua a
 * autoridade sobre quem pode executá-la.
 */
export interface ProviderRerouteCandidateInput {
  /** agentRef atualmente vinculado ao dispatch (original ou já re-roteado). */
  readonly currentAgentRef: string;
  /** Categoria selada da task (executor/reviewer/scout/architect). */
  readonly agentCategory: string;
  /** Roster selado completo do plano (inclui o orquestrador). */
  readonly rosterAgents: readonly TaskPlanAgentSnapshot[];
  /** CLIs já provadas mortas para esta task nesta intentVersion. */
  readonly exhaustedAdapterIds: readonly string[];
  /**
   * Prova de que a rota selada do candidato resolve AGORA (CLI instalada,
   * modelo na família real, regras reserveClaude). Os chamadores embrulham
   * `resolveSealedWorkerRoute` num try/catch — o mesmo juiz do dispatch real.
   */
  readonly isRouteResolvable: (agent: TaskPlanAgentSnapshot) => boolean;
}

export function selectProviderRerouteCandidate(
  input: ProviderRerouteCandidateInput & {
    /** Pior janela de quota por CLI. Ausente = ordem do roster. */
    readonly quotaWorstRatioByCli?: Readonly<Record<string, number | null>>;
  },
): TaskPlanAgentSnapshot | null {
  const exhausted = new Set(input.exhaustedAdapterIds);
  const quota = input.quotaWorstRatioByCli;
  const isQuotaHigh = (cli: string): boolean => {
    if (!quota) return false;
    const worst = quota[cli.toLowerCase()] ?? quota[cli] ?? null;
    return worst !== null && worst >= QUOTA_HIGH_USAGE_THRESHOLD;
  };
  const candidates: TaskPlanAgentSnapshot[] = [];
  for (const agent of input.rosterAgents) {
    if (agent.category !== input.agentCategory) continue;
    if (agent.id === input.currentAgentRef) continue;
    if (exhausted.has(agent.cli)) continue;
    if (!input.isRouteResolvable(agent)) continue;
    candidates.push(agent);
  }
  // Com sinal de quota, prefere um fresco da mesma categoria; se todos
  // estão em alta, mantém a ordem do roster (fail-closed não piora).
  const fresh = candidates.filter((agent) => !isQuotaHigh(agent.cli));
  return (fresh.length > 0 ? fresh : candidates)[0] ?? null;
}

export function buildProviderRerouteDirective(input: {
  readonly previousDirective: TaskProviderRerouteDirective | undefined;
  readonly sealedAgentRef: string;
  readonly deadAdapterId: string;
  readonly candidate: TaskPlanAgentSnapshot;
  readonly reason: string;
  readonly now: number;
}): TaskProviderRerouteDirective {
  const exhausted = new Set(
    input.previousDirective?.exhaustedAdapterIds ?? [],
  );
  exhausted.add(input.deadAdapterId);
  return {
    version: 1,
    fromAgentRef:
      input.previousDirective?.fromAgentRef ?? input.sealedAgentRef,
    toAgentRef: input.candidate.id,
    exhaustedAdapterIds: [...exhausted],
    reason: input.reason.slice(0, 4_000),
    reroutedAt: input.now,
  };
}

export function providerRerouteNote(input: {
  readonly deadAdapterId: string;
  readonly candidate: Pick<TaskPlanAgentSnapshot, "agentName" | "cli">;
}): string {
  return (
    `${PROVIDER_REROUTE_MARKER} A CLI ${input.deadAdapterId} esgotou as ` +
    "tentativas físicas de spawn; a tarefa foi re-roteada automaticamente " +
    `para ${input.candidate.agentName} (${input.candidate.cli}) do mesmo ` +
    "roster selado."
  );
}

/**
 * A mesma troca contada para o humano. O reroute acontece sozinho e devolve a
 * missão a running — sem esta entrada durável, a recuperação seria invisível e
 * o operador só notaria que "de repente" outro agente está trabalhando.
 */
export function providerRerouteLearning(input: {
  readonly taskTitle: string;
  readonly deadAdapterId: string;
  readonly previousAgentName: string;
  readonly candidate: Pick<TaskPlanAgentSnapshot, "agentName" | "cli">;
}): string {
  return (
    `## Troca automática de provider\n` +
    `A tarefa "${input.taskTitle}" ficou sem execução porque a CLI ` +
    `${input.deadAdapterId} (${input.previousAgentName}) não subiu depois de ` +
    "três tentativas — normalmente cota esgotada, login expirado ou binário " +
    "quebrado.\n\n" +
    `O Nexus passou a tarefa para **${input.candidate.agentName}** ` +
    `(${input.candidate.cli}), do mesmo time aprovado, e retomou a missão ` +
    "sozinho. O plano não mudou."
  ).slice(0, 4_000);
}
