import {
  REAL_MISSION_E2E_ADVISORS,
  realMissionE2EAdvisorTier,
  type RealMissionE2EAdvisorCli,
  type RealMissionE2EEvidence,
  type RealMissionE2EOrchestratorCli,
} from "../shared/real-mission-e2e";
import type { RealMissionAdvisorPtyExpectation } from "./real-mission-e2e-physical";

/**
 * Uma CLI advisor do harness e o que a evidência exige dela. Advisors sem
 * credencial materializável chegam via env NEXUS_REAL_MISSION_ADVISOR_SKIP
 * (launcher); na variante orquestrador Claude, a advisor claude é reservada
 * (reserveClaude: um único processo Claude na missão — o orquestrador).
 */
export interface RealMissionAdvisorExpectation {
  readonly cli: RealMissionE2EAdvisorCli;
  readonly agentRef: string;
  readonly agentName: string;
  readonly tier: "mechanically-confined" | "advisory-unconfined";
  readonly skipped: "no-credential" | "orchestrator-reserved" | null;
}

/** Conjunto advisor esperado na ordem canônica do contrato. */
export function expectedRealMissionAdvisors(
  skipAdvisorClis: readonly string[],
  options: { readonly orchestratorCli?: RealMissionE2EOrchestratorCli } = {},
): RealMissionAdvisorExpectation[] {
  const skipped = new Set(skipAdvisorClis);
  const orchestratorReserved = options.orchestratorCli === "claude";
  return REAL_MISSION_E2E_ADVISORS.map((advisor) => ({
    cli: advisor.cli,
    agentRef: advisor.id,
    agentName: advisor.name,
    tier: realMissionE2EAdvisorTier(advisor.cli),
    skipped:
      orchestratorReserved && advisor.cli === "claude"
        ? ("orchestrator-reserved" as const)
        : skipped.has(advisor.cli)
          ? ("no-credential" as const)
          : null,
  }));
}

/** Expectativas PTY das advisors credenciadas para a cerca física exata. */
export function realMissionAdvisorPtyExpectations(
  expectations: readonly RealMissionAdvisorExpectation[],
): RealMissionAdvisorPtyExpectation[] {
  return expectations
    .filter((expectation) => expectation.skipped === null)
    .map((expectation) => ({
      cli: expectation.cli,
      agentName: expectation.agentName,
    }));
}

/** Captura física de uma sessão advisor (taps PTY do main). */
export interface RealMissionAdvisorPtyCapture {
  readonly sessionId: string;
  readonly spawnedAt: number;
}

export interface RealMissionParticipationInput {
  readonly expectations: readonly RealMissionAdvisorExpectation[];
  readonly ptyByCli: ReadonlyMap<string, RealMissionAdvisorPtyCapture>;
  readonly dispatches: readonly {
    readonly agentRef?: string | null;
    readonly sessionId?: string | null;
    readonly handoffId?: string | null;
    readonly handoffAcceptedAt?: number | null;
    /** Diretiva durável de reroute (fromAgentRef = advisor selado ORIGINAL). */
    readonly providerReroute?: { readonly fromAgentRef: string } | null;
  }[];
  /** issuedAt do receipt MCP físico do handoff (null se ausente). */
  readonly handoffIssuedAt: (handoffId: string) => number | null;
  /** Primeira tool nexus_* da sessão na fronteira HTTP MCP (audit log). */
  readonly firstNexusToolAt: (sessionId: string) => number | null;
}

export type RealMissionParticipation =
  RealMissionE2EEvidence["participation"];

/**
 * Projeta o recibo de participação de cada CLI advisor. Fontes: taps PTY
 * físicos (spawn), audit log HTTP MCP (primeira nexus_*) e a store de
 * handoffs (issuedAt do receipt, com fallback ao aceite durável do dispatch).
 */
export function buildRealMissionParticipation(
  input: RealMissionParticipationInput,
): RealMissionParticipation {
  return input.expectations.map((expectation) => {
    if (expectation.skipped !== null) {
      return {
        cli: expectation.cli,
        tier: expectation.tier,
        skipped: expectation.skipped,
        spawnedAt: null,
        firstNexusToolAt: null,
        handoffAt: null,
      };
    }
    const capture = input.ptyByCli.get(expectation.cli) ?? null;
    // Participação por SUBSTITUIÇÃO: quando o provider do advisor morre
    // (401/cota), o reroute re-vincula a task selada a outro agente do roster
    // e o agent_ref do dispatch passa a ser o substituto. A diretiva durável
    // guarda o advisor original em fromAgentRef — o handoff entregue por essa
    // cadeia É o handoff da task selada deste advisor, não uma ausência.
    const dispatch =
      input.dispatches.find(
        (candidate) => candidate.agentRef === expectation.agentRef,
      ) ??
      input.dispatches.find(
        (candidate) =>
          candidate.providerReroute?.fromAgentRef === expectation.agentRef,
      ) ??
      null;
    const handoffAt = dispatch?.handoffId
      ? (input.handoffIssuedAt(dispatch.handoffId) ??
        dispatch.handoffAcceptedAt ??
        null)
      : null;
    return {
      cli: expectation.cli,
      tier: expectation.tier,
      skipped: null,
      spawnedAt: capture?.spawnedAt ?? null,
      firstNexusToolAt: capture
        ? input.firstNexusToolAt(capture.sessionId)
        : null,
      handoffAt,
    };
  });
}

/**
 * CLIs advisor credenciadas sem handoff físico. Missão done com qualquer uma
 * delas fecha o gate com `advisor-absent` em vez de um invariante genérico.
 */
export function realMissionAdvisorsMissingHandoff(
  participation: RealMissionParticipation,
): RealMissionE2EAdvisorCli[] {
  return participation
    .filter((row) => row.skipped === null && row.handoffAt === null)
    .map((row) => row.cli);
}
