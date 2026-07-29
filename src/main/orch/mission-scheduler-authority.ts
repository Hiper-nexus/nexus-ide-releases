import type { Handoff, Mission } from "../../shared/orch-types";
import {
  hasTeamReadOnlyFanoutDomain,
  type StandardMissionTopology,
} from "../../shared/mission-topology";
import type { ScopedMissionStore } from "./mission-store";
import { missionRequiresGuidedPrevc } from "./guided-mission-authority";
import type {
  TaskDispatchRecord,
  TaskDispatchState,
} from "./task-dispatch-codec";

const SCHEDULER_PROGRESS_STATES = new Set<TaskDispatchState>([
  "claimed",
  "routed",
  "spawning",
  "running",
  "handoff_ready",
  "merging",
  "completed",
  "suspended",
]);

const SCHEDULER_HANDOFF_STATES = new Set<TaskDispatchState>([
  "handoff_ready",
  "merging",
  "completed",
]);

type SchedulerProgressDispatch = Pick<
  TaskDispatchRecord,
  "missionId" | "intentVersion" | "state"
>;

type SchedulerHandoffDispatch = Pick<
  TaskDispatchRecord,
  | "missionId"
  | "intentVersion"
  | "revision"
  | "state"
  | "sessionId"
  | "workerIncarnationId"
  | "workerId"
  | "handoffId"
  | "handoffAcceptedAt"
>;

type SchedulerCompletionDispatch = Pick<
  TaskDispatchRecord,
  "missionId" | "intentVersion" | "executionMode" | "ownership"
>;

/**
 * Completion topology comes from the persisted dispatch projection of the
 * sealed plan. Goal text is proposal-time input and may be reclassified by a
 * later release; it must never change the completion owner after approval.
 *
 * Only a non-empty, all-marker wave is fan-out. Empty or fully unmarked
 * projections remain delivery; a mixed immutable projection is invalid and
 * cannot select either completion owner.
 */
export function missionSchedulerCompletionTopology(
  mission: Mission,
  dispatches: readonly SchedulerCompletionDispatch[],
): StandardMissionTopology | null {
  const intentVersion = mission.intentVersion ?? 0;
  const current = dispatches.filter(
    (dispatch) =>
      dispatch.missionId === mission.id &&
      dispatch.intentVersion === intentVersion,
  );
  if (current.length === 0) return "delivery";
  const markerCount = current.filter((dispatch) =>
    hasTeamReadOnlyFanoutDomain(dispatch.ownership.domains),
  ).length;
  if (markerCount === 0) return "delivery";
  if (markerCount === current.length) return "team-read-only-fanout";
  return null;
}

export function missionSchedulerHasKickoffAuthority(
  missions: Pick<ScopedMissionStore, "hasCurrentKickoffAcceptance">,
  missionId: string,
): boolean {
  return missions.hasCurrentKickoffAcceptance(missionId);
}

export function missionHasSchedulerProgress(
  mission: Mission,
  hasCurrentKickoffAcceptance: boolean,
  dispatches: readonly SchedulerProgressDispatch[],
): boolean {
  if (
    mission.status !== "running" ||
    !mission.orchestratorSessionId ||
    !hasCurrentKickoffAcceptance
  ) {
    return false;
  }
  const intentVersion = mission.intentVersion ?? 0;
  return dispatches.some(
    (dispatch) =>
      dispatch.missionId === mission.id &&
      dispatch.intentVersion === intentVersion &&
      SCHEDULER_PROGRESS_STATES.has(dispatch.state),
  );
}

export function findCurrentSchedulerOwnedHandoffDispatch(
  mission: Mission,
  hasCurrentKickoffAcceptance: boolean,
  handoff: Handoff,
  dispatches: readonly SchedulerHandoffDispatch[],
): SchedulerHandoffDispatch | null {
  if (
    !missionHasSchedulerProgress(
      mission,
      hasCurrentKickoffAcceptance,
      dispatches,
    ) ||
    handoff.missionId !== mission.id ||
    handoff.status !== "success" ||
    handoff.authorityOrigin !== "agent" ||
    !handoff.sessionId ||
    !handoff.workerIncarnationId ||
    !handoff.fromAgent ||
    !handoff.mcpProvenance
  ) {
    return null;
  }
  const provenance = handoff.mcpProvenance;
  if (
    provenance.receiptId !== provenance.toolCallId ||
    provenance.toolName !== "nexus_handoff_submit" ||
    (provenance.source !== "http-mcp" &&
      provenance.source !== "pty-stream") ||
    provenance.missionId !== mission.id ||
    provenance.sessionId !== handoff.sessionId ||
    provenance.workerIncarnationId !== handoff.workerIncarnationId ||
    provenance.issuedAt > handoff.createdAt
  ) {
    return null;
  }
  const intentVersion = mission.intentVersion ?? 0;
  const matches = dispatches.filter(
    (dispatch) =>
      dispatch.missionId === mission.id &&
      dispatch.intentVersion === intentVersion &&
      Number.isInteger(dispatch.revision) &&
      dispatch.revision > 0 &&
      SCHEDULER_HANDOFF_STATES.has(dispatch.state) &&
      dispatch.handoffId === handoff.id &&
      dispatch.sessionId === handoff.sessionId &&
      dispatch.workerIncarnationId === handoff.workerIncarnationId &&
      dispatch.workerId === handoff.fromAgent &&
      dispatch.handoffAcceptedAt !== undefined &&
      dispatch.handoffAcceptedAt >= handoff.createdAt,
  );
  return matches.length === 1 ? matches[0]! : null;
}

export async function validateMissionMergeWithLifecycleFence<T>(input: {
  readonly assertCurrentAuthority: () => void;
  readonly validate: () => Promise<T> | T;
}): Promise<T> {
  input.assertCurrentAuthority();
  const result = await input.validate();
  // The validation may run sensors/reviewers for minutes. The synchronous
  // recheck after its final await is the last main-thread step before
  // MergeQueue performs the Git CAS.
  input.assertCurrentAuthority();
  return result;
}

/**
 * Await non-mutating provider/account preparation without carrying a stale
 * intent/plan/squad proof across the asynchronous boundary. Callers may start
 * durable scheduler effects only after this function resolves.
 */
export async function awaitMissionSchedulerAuthorityFence<T>(input: {
  readonly assertCurrentAuthority: () => void;
  readonly prepare: () => Promise<T>;
}): Promise<T> {
  input.assertCurrentAuthority();
  const result = await input.prepare();
  input.assertCurrentAuthority();
  return result;
}

/**
 * Completion fork after scheduling/merge reconciliation. Guided missions can
 * only enter the PREVC handoff bridge; the legacy verified-plan shortcut is
 * structurally unreachable for them.
 */
export async function reconcileMissionCompletionAfterSchedulerTick(input: {
  readonly mission: Mission | null;
  readonly dispatches: readonly SchedulerCompletionDispatch[];
  readonly runGuidedBridge: () => Promise<unknown>;
  readonly completeLegacy: (intentVersion: number) => void;
}): Promise<"guided" | "legacy" | "none"> {
  const mission = input.mission;
  if (!mission || mission.status !== "running") return "none";
  const topology = missionSchedulerCompletionTopology(
    mission,
    input.dispatches,
  );
  if (topology === null) return "none";
  if (missionRequiresGuidedPrevc(mission, topology)) {
    await input.runGuidedBridge();
    return "guided";
  }
  const intentVersion = mission.intentContract?.intentVersion;
  if (intentVersion === undefined) return "none";
  input.completeLegacy(intentVersion);
  return "legacy";
}
