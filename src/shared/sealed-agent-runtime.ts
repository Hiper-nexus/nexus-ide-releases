/**
 * Modelo e effort selados na escolha das CLIs da missão.
 *
 * Ranking, bandas, `nexus_route_task` e o default do adapter/CLI,
 * DeepSeek Flash, Claude sonnet) nunca vencem o que o operador selou no
 * início. Failover para OUTRA CLI usa o model/effort da rota — nunca mistura
 * o selo de um provider no binário de outro.
 */

function present(value: string | undefined | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export interface SealedRosterAgent {
  readonly cli?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
}

export interface HonorSealedRosterInput {
  readonly sealedCli?: string | null;
  readonly sealedModel?: string | null;
  readonly sealedEffort?: string | null;
  readonly requestedAdapterId?: string | null;
  readonly requestedModel?: string | null;
  readonly requestedEffort?: string | null;
}

export interface HonorSealedRosterResult {
  readonly adapterId: string;
  readonly model?: string;
  readonly effort?: string;
  /** Mesma CLI do roster com modelo selado — a rota sticky está honrada. */
  readonly rosterHonored: boolean;
}

export function uniqueSealedRuntimeForAdapter(
  agents: readonly SealedRosterAgent[],
  adapterId: string,
): { readonly model: string; readonly effort?: string } | null {
  const matches = agents.filter(
    (agent) => present(agent.cli) === adapterId && present(agent.model),
  );
  if (matches.length !== 1) return null;
  const agent = matches[0]!;
  const model = present(agent.model);
  if (!model) return null;
  const effort = present(agent.effort);
  return effort ? { model, effort } : { model };
}

export function pinUniqueSealedRosterOnDecision<
  T extends {
    adapterId: string;
    model?: string;
    effort?: string;
    reason: string;
  },
>(decision: T, agents: readonly SealedRosterAgent[]): T {
  const unique = uniqueSealedRuntimeForAdapter(agents, decision.adapterId);
  if (!unique) return decision;
  const modelChanged = unique.model !== decision.model;
  const effortChanged =
    unique.effort !== undefined && unique.effort !== decision.effort;
  if (!modelChanged && !effortChanged) return decision;
  return {
    ...decision,
    model: unique.model,
    effort: unique.effort ?? decision.effort,
    reason:
      `${decision.reason}; roster selado ${unique.model}` +
      (unique.effort ? ` effort=${unique.effort}` : ''),
  };
}

export function honorSealedRosterRuntime(
  input: HonorSealedRosterInput,
): HonorSealedRosterResult {
  const sealedCli = present(input.sealedCli);
  const sealedModel = present(input.sealedModel);
  const sealedEffort = present(input.sealedEffort);
  const requestedAdapter = present(input.requestedAdapterId);
  const adapterId = requestedAdapter ?? sealedCli;
  if (!adapterId) {
    throw new Error(
      'spawn de missão exige uma CLI (adapterId ou roster selado)',
    );
  }
  const sameCli = !sealedCli || adapterId === sealedCli;
  if (sameCli && sealedModel) {
    return {
      adapterId,
      model: sealedModel,
      effort: sealedEffort ?? present(input.requestedEffort),
      rosterHonored: true,
    };
  }
  return {
    adapterId,
    model: present(input.requestedModel),
    effort: present(input.requestedEffort),
    rosterHonored: false,
  };
}
