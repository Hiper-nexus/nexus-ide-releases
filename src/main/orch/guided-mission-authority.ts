import {
  isEngineGeneratedSquadId,
  type Mission,
} from "../../shared/orch-types";
import {
  classifyStandardMissionTopology,
  type StandardMissionTopology,
} from "../../shared/mission-topology";

type GuidedMissionAuthoritySubject = Pick<
  Mission,
  "intentContract" | "squadId"
>;

const HUMAN_GUIDED_INTENT_SOURCES = new Set([
  "typed",
  "voice",
  "imported-issue",
]);

/**
 * Identifies the two Main-owned entrypoints that authorize the deterministic
 * Guided v2 graph: a beginner squad synthesized by Nexus, or a physically
 * sealed plan→standard promotion. A saved specialty squad without that
 * promotion receipt remains outside this policy.
 */
export function hasMainOwnedGuidedDeliveryAuthority(
  mission: GuidedMissionAuthoritySubject,
): boolean {
  return Boolean(
    mission.intentContract?.promotedPlan ||
      (mission.squadId && isEngineGeneratedSquadId(mission.squadId)),
  );
}

/**
 * Main-owned PREVC applicability for the beginner delivery path.
 *
 * This decision is intentionally mission-level. Task details are sealed work
 * instructions, not authority to opt a mission into or out of PREVC.
 */
export function missionRequiresGuidedPrevc(
  mission: GuidedMissionAuthoritySubject,
  sealedTopology?: StandardMissionTopology,
): boolean {
  const contract = mission.intentContract;
  const topology =
    sealedTopology ??
    classifyStandardMissionTopology(contract?.goal ?? "");
  return Boolean(
    contract &&
      (contract.lane ?? "standard") === "standard" &&
      HUMAN_GUIDED_INTENT_SOURCES.has(contract.source) &&
      !contract.requiredWorkerAgentRef &&
      topology !== "team-read-only-fanout" &&
      hasMainOwnedGuidedDeliveryAuthority(mission),
  );
}
