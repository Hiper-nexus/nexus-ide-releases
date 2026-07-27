import {
  REAL_MISSION_E2E_EXECUTOR_NAME,
  REAL_MISSION_E2E_ORCHESTRATOR_NAME,
  REAL_MISSION_E2E_QA_NAME,
  REAL_MISSION_E2E_REVIEWER_NAME,
  REAL_MISSION_E2E_SQUAD_ID,
} from "../shared/real-mission-e2e";
import { getAgentSessionInfo } from "./pty/pty-manager";

export type PhysicalPtyAgent = NonNullable<
  ReturnType<typeof getAgentSessionInfo>
>;
export type RealMissionPhysicalPtyAgent = PhysicalPtyAgent & {
  readonly role: "orchestrator" | "worker";
};
export type RealMissionPhysicalPtyIdentity =
  "orchestrator" | "executor" | "reviewer" | "qa";
export type RealMissionPhysicalPtyInspection =
  | { readonly kind: "unrelated" }
  | { readonly kind: "violation" }
  | {
      readonly kind: "accepted";
      readonly identity: RealMissionPhysicalPtyIdentity;
      readonly agent: RealMissionPhysicalPtyAgent;
    };

/**
 * Accept only the main-owned identity actually attached to the physical PTY.
 * Scheduler workers intentionally do not carry a squadId: their durable
 * authority is missionId + workerIncarnationId. The legacy-squad
 * orchestrator carries squadId, while the production main-owned bootstrap
 * carries the exact approved authority seal instead. Both are real runtime
 * paths and neither may be replaced with generated evidence.
 */
export function isRealMissionPhysicalPtyAgent(
  sessionId: string,
  missionId: string,
  agent: PhysicalPtyAgent | null,
): agent is RealMissionPhysicalPtyAgent {
  if (
    !agent ||
    agent.sessionId !== sessionId ||
    agent.missionId !== missionId ||
    agent.adapterId !== "codex" ||
    (agent.role !== "orchestrator" && agent.role !== "worker")
  ) {
    return false;
  }
  if (agent.role === "orchestrator") {
    return (
      agent.agentName === REAL_MISSION_E2E_ORCHESTRATOR_NAME &&
      (agent.squadId === REAL_MISSION_E2E_SQUAD_ID ||
        (agent.source === "pending" &&
          agent.authoritySeal?.intentVersion === 1 &&
          /^[a-f0-9]{64}$/u.test(agent.authoritySeal.squadRevisionHash)))
    );
  }
  return (
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
 * Stateful exact-roster fence. A mission may bind one physical session to
 * each approved identity and no others, including sequential replacements.
 */
export class ExactRealMissionPhysicalPtyGate {
  readonly #missionId: string;
  readonly #sessionByIdentity = new Map<
    RealMissionPhysicalPtyIdentity,
    string
  >();
  readonly #identityBySession = new Map<
    string,
    RealMissionPhysicalPtyIdentity
  >();

  constructor(missionId: string) {
    this.#missionId = missionId;
  }

  get acceptedSessionCount(): number {
    return this.#sessionByIdentity.size;
  }

  inspect(
    sessionId: string,
    agent: PhysicalPtyAgent | null,
  ): RealMissionPhysicalPtyInspection {
    if (agent?.missionId !== this.#missionId) return { kind: "unrelated" };
    if (!isRealMissionPhysicalPtyAgent(sessionId, this.#missionId, agent)) {
      return { kind: "violation" };
    }
    const identity = physicalPtyIdentity(agent);
    const priorSession = this.#sessionByIdentity.get(identity);
    const priorIdentity = this.#identityBySession.get(sessionId);
    if (
      (priorSession !== undefined && priorSession !== sessionId) ||
      (priorIdentity !== undefined && priorIdentity !== identity)
    ) {
      return { kind: "violation" };
    }
    this.#sessionByIdentity.set(identity, sessionId);
    this.#identityBySession.set(sessionId, identity);
    return { kind: "accepted", identity, agent };
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
