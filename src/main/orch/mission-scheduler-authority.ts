import type { Mission } from "../../shared/orch-types";
import type { ScopedMissionStore } from "./mission-store";
import { missionRequiresGuidedPrevc } from "./guided-mission-authority";

export function missionSchedulerHasKickoffAuthority(
  missions: Pick<ScopedMissionStore, "hasCurrentKickoffAcceptance">,
  missionId: string,
): boolean {
  return missions.hasCurrentKickoffAcceptance(missionId);
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
 * PREVC proof across the asynchronous boundary. Callers may start durable
 * scheduler effects only after this function resolves.
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
  readonly runGuidedBridge: () => Promise<unknown>;
  readonly completeLegacy: (intentVersion: number) => void;
}): Promise<"guided" | "legacy" | "none"> {
  const mission = input.mission;
  if (!mission || mission.status !== "running") return "none";
  if (missionRequiresGuidedPrevc(mission)) {
    await input.runGuidedBridge();
    return "guided";
  }
  const intentVersion = mission.intentContract?.intentVersion;
  if (intentVersion === undefined) return "none";
  input.completeLegacy(intentVersion);
  return "legacy";
}
