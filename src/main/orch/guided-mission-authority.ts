import {
  isEngineGeneratedSquadId,
  isMissionRuntimeSquadId,
  type Mission,
  type Squad,
} from "../../shared/orch-types";
import {
  classifyStandardMissionTopology,
  type StandardMissionTopology,
} from "../../shared/mission-topology";
import { getSquad } from "./squad-store";

type GuidedMissionAuthoritySubject = Pick<
  Mission,
  "intentContract" | "squadId"
>;

const HUMAN_GUIDED_INTENT_SOURCES = new Set([
  "typed",
  "voice",
  "imported-issue",
]);

type SquadResolver = (squadId: string) => Squad | null;

/**
 * A mission-runtime squad (immutable launch snapshot of a saved team) joins
 * the guided policy only when its roster is delivery-shaped — it has at least
 * one executor for the plan's mutation slot. Research/review-only saved
 * squads keep their orchestrator-authored planning route, which the guided
 * executor→reviewer graph would invalidate.
 */
function missionRuntimeSquadIsDeliveryShaped(
  squadId: string,
  resolveSquad: SquadResolver,
): boolean {
  const squad = resolveSquad(squadId);
  return Boolean(
    squad?.agents.some((agent) => agent.category === "executor"),
  );
}

/**
 * Identifies the Main-owned entrypoints that authorize the deterministic
 * Guided v2 graph: a beginner squad synthesized by Nexus, a physically
 * sealed plan→standard promotion, or a saved-team launch snapshot
 * (mission-runtime) whose roster carries an executor. Before the last case,
 * Modo Squad missions fell into an orchestrator-authored planning route that
 * routinely died unsealed ("workflow_authority_revoked"), leaving the mission
 * dispatched with zero tasks forever. Research/review-only saved squads stay
 * outside this policy.
 */
export function hasMainOwnedGuidedDeliveryAuthority(
  mission: GuidedMissionAuthoritySubject,
  resolveSquad: SquadResolver = getSquad,
): boolean {
  return Boolean(
    mission.intentContract?.promotedPlan ||
      (mission.squadId &&
        (isEngineGeneratedSquadId(mission.squadId) ||
          (isMissionRuntimeSquadId(mission.squadId) &&
            missionRuntimeSquadIsDeliveryShaped(
              mission.squadId,
              resolveSquad,
            )))),
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
