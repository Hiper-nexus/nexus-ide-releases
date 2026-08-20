/**
 * Modo livre de agentes (opt-in por missão) — decisões puras dos gates.
 *
 * "Iniciar missão em modo livre" é o análogo Bridge: o orquestrador spawna
 * QUALQUER CLI/modelo instalado como worker, sem cerimônia. O flag mora no
 * contrato de intenção da missão (`MissionIntentContract.freeAgentChoice`),
 * selado no início — nunca é default silencioso, sempre opt-in do operador.
 *
 * Estas funções isolam as decisões dos três gates cerimoniais de
 * `tools-panes.ts` para que o bypass do modo livre seja testável sem MCP:
 *   (a) release-qualified CLI — via isMissionWorkerWriteEligibleCli(operatorChoice)
 *       e o backstop assertReleaseQualifiedMissionWorkerSpawn (honram o flag);
 *   (b) squad_binding_violation — squadBindingViolationError;
 *   (c) route_reservation_required — requiresRouteReservation.
 *
 * O modo livre NUNCA relaxa os guardrails que não são cerimônia: containment de
 * workspace (executionMode), allowlists de tools (attenuateTools), 1 escritor
 * por checkout (activeSameCheckoutWorker) e maxWorkers seguem valendo.
 */

/** Lê o opt-in de modo livre do contrato de intenção (fail-safe: ausente = off). */
export function isFreeAgentChoiceContract(
  contract: { readonly freeAgentChoice?: boolean } | null | undefined,
): boolean {
  return contract?.freeAgentChoice === true;
}

/**
 * Default do modo livre no SELO do contrato (decisão de 20/08, ordem do
 * operador: "tirar o cabresto"). Sob Autopiloto (squadCliPolicy ≠ governed)
 * uma missão nova nasce em modo livre, a menos que o fluxo peça o contrário;
 * sob Hardened continua opt-in explícito. Pet Studio reescreve `advanced` e
 * só entra em modo livre por escolha explícita do próprio fluxo — preservado.
 *
 * Os guardrails que não são cerimônia (containment de workspace, allowlists,
 * 1 escritor por checkout, maxWorkers) não passam por aqui e seguem valendo.
 */
export function defaultFreeAgentChoice(input: {
  readonly requested: boolean | undefined;
  readonly operatorChoicePolicy: boolean;
  readonly petStudio: boolean;
}): boolean {
  if (input.petStudio) return input.requested === true;
  if (input.requested !== undefined) return input.requested;
  return input.operatorChoicePolicy;
}

export interface SquadBindingGateInput {
  /** Spawn de agente NOMEADO do roster (agentName) já é vinculado por identidade. */
  readonly hasNamedAgent: boolean;
  readonly missionSquadId: string | undefined;
  /** CLIs roteáveis do roster selado da missão. */
  readonly rosterClis: ReadonlySet<string>;
  readonly adapterId: string;
  readonly freeAgentChoice: boolean;
}

/**
 * Gate (b): um worker ad-hoc só pode usar uma CLI do roster do squad selado.
 * Retorna a mensagem de erro, ou null quando o spawn pode prosseguir.
 *
 * Fail-open quando o roster é irresolúvel (vazio) — sem membros para julgar não
 * há colapso a impedir. Modo livre dispensa o vínculo por completo.
 */
export function squadBindingViolationError(
  input: SquadBindingGateInput,
): string | null {
  if (input.hasNamedAgent) return null;
  if (input.freeAgentChoice) return null;
  if (!input.missionSquadId) return null;
  if (input.rosterClis.size === 0) return null;
  if (input.rosterClis.has(input.adapterId)) return null;
  return (
    `squad_binding_violation: a missão está vinculada ao squad ` +
    `${input.missionSquadId}; um worker ad-hoc só pode usar uma CLI do ` +
    `roster (${[...input.rosterClis].join(', ')}), não ${input.adapterId}. ` +
    `Spawne um agente nomeado do squad (agentName), roteie para um membro do ` +
    `roster, ou inicie a missão em modo livre (Escolha livre de agentes).`
  );
}

export interface RouteReservationGateInput {
  readonly missionRunning: boolean;
  /** Rota sticky do roster (agente nomeado sem override) já é autorizada. */
  readonly rosterRouteAuthorized: boolean;
  readonly freeAgentChoice: boolean;
}

/**
 * Gate (c): uma missão em execução exige routeReservationId de nexus_route_task,
 * exceto quando a rota sticky do roster já autoriza ou o modo livre está ligado.
 */
export function requiresRouteReservation(
  input: RouteReservationGateInput,
): boolean {
  return (
    input.missionRunning &&
    !input.rosterRouteAuthorized &&
    !input.freeAgentChoice
  );
}
