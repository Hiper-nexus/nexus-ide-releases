import {
  REAL_MISSION_E2E_EXECUTOR_NAME,
  REAL_MISSION_E2E_ORCHESTRATOR_NAME,
  REAL_MISSION_E2E_QA_NAME,
  REAL_MISSION_E2E_REVIEWER_NAME,
  REAL_MISSION_E2E_SQUAD_ID,
} from "../shared/real-mission-e2e";
import {
  isAutomatedReviewerAgentName,
  isContextDraftReviewerAgentName,
} from "./orch/prevc-reviewer-profile";
import { getAgentSessionInfo } from "./pty/pty-manager";

export type PhysicalPtyAgent = NonNullable<
  ReturnType<typeof getAgentSessionInfo>
>;
export type RealMissionPhysicalPtyAgent = PhysicalPtyAgent & {
  readonly role: "orchestrator" | "worker";
};
export type RealMissionPhysicalPtyIdentity =
  | "orchestrator"
  | "executor"
  | "reviewer"
  | "qa"
  | `advisor:${string}`;
export type RealMissionPhysicalPtyInspection =
  | { readonly kind: "unrelated" }
  | { readonly kind: "deferred" }
  | { readonly kind: "violation" }
  | {
      readonly kind: "accepted";
      readonly identity: RealMissionPhysicalPtyIdentity;
      readonly agent: RealMissionPhysicalPtyAgent;
    };

export type RealMissionPhysicalPtyReplacementDecision =
  | "accept"
  | "defer"
  | "reject";

export interface RealMissionPhysicalPtyReplacement {
  readonly identity: RealMissionPhysicalPtyIdentity;
  readonly priorSessionId: string;
  readonly priorAgent: RealMissionPhysicalPtyAgent;
  readonly nextSessionId: string;
  readonly nextAgent: RealMissionPhysicalPtyAgent;
}

export type AuthorizeRealMissionPhysicalPtyReplacement = (
  replacement: RealMissionPhysicalPtyReplacement,
) => RealMissionPhysicalPtyReplacementDecision;

/**
 * Uma CLI advisor esperada pelo harness (não-skipped): a sessão física dela é
 * aceita pelo gate com identidade `advisor:<cli>` e registrada na prova de
 * participação — nunca no conjunto PTY codex de quatro panes.
 */
export interface RealMissionAdvisorPtyExpectation {
  readonly cli: string;
  readonly agentName: string;
}

/**
 * Accept only the main-owned identity actually attached to the physical PTY.
 * Scheduler workers intentionally do not carry a squadId: their durable
 * authority is missionId + workerIncarnationId. The legacy-squad
 * orchestrator carries squadId, while the production main-owned bootstrap
 * carries the exact approved authority seal instead. Both are real runtime
 * paths and neither may be replaced with generated evidence. O orquestrador
 * físico é a CLI da variante (codex ou claude); os workers do pipeline são
 * sempre codex.
 */
export function isRealMissionPhysicalPtyAgent(
  sessionId: string,
  missionId: string,
  agent: PhysicalPtyAgent | null,
  orchestratorCli: "codex" | "claude" = "codex",
): agent is RealMissionPhysicalPtyAgent {
  if (
    !agent ||
    agent.sessionId !== sessionId ||
    agent.missionId !== missionId ||
    (agent.role !== "orchestrator" && agent.role !== "worker")
  ) {
    return false;
  }
  if (agent.role === "orchestrator") {
    return (
      agent.adapterId === orchestratorCli &&
      agent.agentName === REAL_MISSION_E2E_ORCHESTRATOR_NAME &&
      (agent.squadId === REAL_MISSION_E2E_SQUAD_ID ||
        (agent.source === "pending" &&
          agent.authoritySeal?.intentVersion === 1 &&
          /^[a-f0-9]{64}$/u.test(agent.authoritySeal.squadRevisionHash)))
    );
  }
  return (
    agent.adapterId === "codex" &&
    (agent.agentName === REAL_MISSION_E2E_EXECUTOR_NAME ||
      agent.agentName === REAL_MISSION_E2E_REVIEWER_NAME ||
      agent.agentName === REAL_MISSION_E2E_QA_NAME) &&
    Boolean(agent.workerIncarnationId)
  );
}

function physicalPtyIdentity(
  agent: RealMissionPhysicalPtyAgent,
): RealMissionPhysicalPtyIdentity {
  if (agent.role === "orchestrator") return "orchestrator";
  if (agent.agentName === REAL_MISSION_E2E_EXECUTOR_NAME) return "executor";
  if (agent.agentName === REAL_MISSION_E2E_REVIEWER_NAME) return "reviewer";
  return "qa";
}

/**
 * Identidade advisor de uma sessão física: worker read_only da missão cuja
 * CLI e nome casam exatamente com uma advisor esperada (não-skipped). Advisors
 * skipped estão fora do roster — uma sessão com a identidade delas é violação.
 */
function advisorPtyIdentity(
  missionId: string,
  agent: PhysicalPtyAgent | null,
  expectedAdvisors: readonly RealMissionAdvisorPtyExpectation[],
): RealMissionPhysicalPtyIdentity | null {
  if (
    !agent ||
    agent.missionId !== missionId ||
    agent.role !== "worker" ||
    !agent.workerIncarnationId
  ) {
    return null;
  }
  const advisor = expectedAdvisors.find(
    (candidate) =>
      candidate.cli === agent.adapterId &&
      candidate.agentName === agent.agentName,
  );
  return advisor ? `advisor:${advisor.cli}` : null;
}

/**
 * Stateful exact-roster fence. A mission may bind one current physical
 * session to each approved identity and no others. Advisor retries are the
 * only replaceable identity and require an external durable + physical proof;
 * the default remains fail-closed.
 */
export class ExactRealMissionPhysicalPtyGate {
  readonly #missionId: string;
  readonly #orchestratorCli: "codex" | "claude";
  readonly #expectedAdvisors: readonly RealMissionAdvisorPtyExpectation[];
  readonly #authorizeReplacement:
    | AuthorizeRealMissionPhysicalPtyReplacement
    | undefined;
  readonly #sessionByIdentity = new Map<
    RealMissionPhysicalPtyIdentity,
    string
  >();
  readonly #agentByIdentity = new Map<
    RealMissionPhysicalPtyIdentity,
    RealMissionPhysicalPtyAgent
  >();
  readonly #identityBySession = new Map<
    string,
    RealMissionPhysicalPtyIdentity
  >();

  constructor(
    missionId: string,
    expectedAdvisors: readonly RealMissionAdvisorPtyExpectation[] = [],
    orchestratorCli: "codex" | "claude" = "codex",
    authorizeReplacement?: AuthorizeRealMissionPhysicalPtyReplacement,
  ) {
    this.#missionId = missionId;
    this.#expectedAdvisors = expectedAdvisors;
    this.#orchestratorCli = orchestratorCli;
    this.#authorizeReplacement = authorizeReplacement;
  }

  get acceptedSessionCount(): number {
    return this.#sessionByIdentity.size;
  }

  inspect(
    sessionId: string,
    agent: PhysicalPtyAgent | null,
  ): RealMissionPhysicalPtyInspection {
    if (agent?.missionId !== this.#missionId) return { kind: "unrelated" };
    let identity: RealMissionPhysicalPtyIdentity;
    let acceptedAgent: RealMissionPhysicalPtyAgent;
    if (
      isRealMissionPhysicalPtyAgent(
        sessionId,
        this.#missionId,
        agent,
        this.#orchestratorCli,
      )
    ) {
      identity = physicalPtyIdentity(agent);
      acceptedAgent = agent;
    } else {
      // advisorPtyIdentity só aceita role "worker" com encarnação: a sessão
      // advisor entra na cerca exata sem nunca virar prova do pipeline codex.
      const advisorIdentity = advisorPtyIdentity(
        this.#missionId,
        agent,
        this.#expectedAdvisors,
      );
      if (advisorIdentity === null) {
        // Production merge-council / context-draft reviewers spawn canonical
        // mission-bound PTYs (reviewer-codex-N-<hex>). They are not part of the
        // four-pane E2E roster proof, but aborting them as violations kills the
        // merge while candidate-validating. Treat them as unrelated.
        if (
          agent.readOnly === true &&
          (isAutomatedReviewerAgentName(agent.agentName, agent.adapterId) ||
            isContextDraftReviewerAgentName(agent.agentName, agent.adapterId))
        ) {
          return { kind: "unrelated" };
        }
        return { kind: "violation" };
      }
      identity = advisorIdentity;
      acceptedAgent = agent as RealMissionPhysicalPtyAgent;
    }
    const priorSession = this.#sessionByIdentity.get(identity);
    const priorIdentity = this.#identityBySession.get(sessionId);
    if (priorIdentity !== undefined && priorIdentity !== identity) {
      return { kind: "violation" };
    }
    if (priorSession !== undefined && priorSession !== sessionId) {
      // An exit tap for the exact retired session may arrive after the new
      // binding. It cannot regain authority or replace the current session.
      if (priorIdentity === identity) return { kind: "unrelated" };
      const priorAgent = this.#agentByIdentity.get(identity);
      if (!priorAgent || !this.#authorizeReplacement) {
        return { kind: "violation" };
      }
      // Advisors require a distinct worker incarnation. Orchestrator technical
      // recovery has no incarnation — the authorize callback proves the prior
      // PTY is gone and the next pane is still the exact E2E Maestro.
      // Workers (executor/reviewer/QA) remain non-replaceable.
      if (identity.startsWith("advisor:")) {
        if (
          !priorAgent.workerIncarnationId ||
          !acceptedAgent.workerIncarnationId ||
          priorAgent.workerIncarnationId ===
            acceptedAgent.workerIncarnationId
        ) {
          return { kind: "violation" };
        }
      } else if (identity !== "orchestrator") {
        return { kind: "violation" };
      }
      const decision = this.#authorizeReplacement({
        identity,
        priorSessionId: priorSession,
        priorAgent,
        nextSessionId: sessionId,
        nextAgent: acceptedAgent,
      });
      if (decision === "defer") return { kind: "deferred" };
      if (decision !== "accept") return { kind: "violation" };
    }
    this.#sessionByIdentity.set(identity, sessionId);
    this.#agentByIdentity.set(identity, acceptedAgent);
    this.#identityBySession.set(sessionId, identity);
    return { kind: "accepted", identity, agent: acceptedAgent };
  }
}

export interface KickoffCapture {
  sessionId: string | null;
  idleAt: number | null;
  busyAt: number | null;
  ptyDataAt: number | null;
  ptyChunkSha256: string | null;
}

export interface PhysicalPtyCapture {
  readonly role: "orchestrator" | "worker";
  readonly workerIncarnationId: string | null;
  readonly readOnly: boolean;
  readonly nativeReadOnly: boolean | null;
  readonly spawnedAt: number;
  dataAt: number | null;
  ptyChunkSha256: string | null;
}

export function hasCorrelatedPhysicalWorkerData(
  dispatches: readonly {
    readonly sessionId?: string;
    readonly workerIncarnationId?: string;
  }[],
  captures: ReadonlyMap<
    string,
    {
      readonly role: "orchestrator" | "worker";
      readonly workerIncarnationId: string | null;
      readonly dataAt: number | null;
      readonly ptyChunkSha256: string | null;
    }
  >,
): boolean {
  return dispatches.some((dispatch) => {
    if (!dispatch.sessionId || !dispatch.workerIncarnationId) return false;
    const physical = captures.get(dispatch.sessionId);
    return (
      physical?.role === "worker" &&
      physical.workerIncarnationId === dispatch.workerIncarnationId &&
      physical.dataAt !== null &&
      physical.ptyChunkSha256 !== null
    );
  });
}
