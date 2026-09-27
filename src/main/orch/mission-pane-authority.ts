import { createHash } from "node:crypto";
import type {
  Mission,
  MissionPaneAuthoritySeal,
  Squad,
} from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  missionIntentAuthoritySnapshot,
  type MissionIntentContract,
} from "../../shared/mission-intent";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import { getOrchSettings } from "../persistence/settings-store";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { isFreeAgentChoiceContract } from "./free-agent-choice";

/**
 * Missão em modo livre sem squad ("o Jev monta o squad"): o selo amarra a
 * intenção aprovada + workflow; a metade de squad é esta constante. Missão
 * COM squad nunca cai aqui — continua exigindo o hash do roster aprovado.
 * É um SHA-256 porque o store persistente só aceita hash hex de 64 chars.
 */
export const FREE_MODE_NO_SQUAD_REVISION_HASH = createHash("sha256")
  .update("nexus:free-agent-choice:no-squad")
  .digest("hex");

function canonicalJson(value: unknown): string {
  if (value === undefined) return '"<undefined>"';
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Hash format carried by every main-owned physical mission authority seal. */
export function hashMissionIntentContract(value: unknown): string {
  return sha256(value);
}

/** Stable hash of the operator-approved contract, excluding runtime ledger. */
export function hashMissionIntentAuthority(
  contract: MissionIntentContract,
): string {
  return sha256(missionIntentAuthoritySnapshot(contract));
}

function hasPendingMainOwnedStartAuthority(mission: Mission): boolean {
  const contract = mission.intentContract;
  return Boolean(
    mission.status === "pending" &&
      mission.intentState === "ready_to_start" &&
      !mission.orchestratorSessionId &&
      hasCurrentApprovedDispatchContract(mission) &&
      Number.isSafeInteger(contract?.dispatchedAt) &&
      (contract?.dispatchedAt ?? 0) > 0 &&
      /^[a-f0-9]{64}$/i.test(contract?.approvalReviewSha256 ?? ""),
  );
}

export function createMissionPaneAuthoritySeal(input: {
  readonly mission: Mission;
  readonly squad: Squad | null;
  readonly contextRevision?: string;
  readonly contractHash?: string;
}): MissionPaneAuthoritySeal | null {
  const { mission, squad } = input;
  const intentVersion = mission.intentVersion ?? 0;
  const intentContract = mission.intentContract;
  if (
    !intentContract ||
    intentVersion <= 0 ||
    !hasCurrentDispatchAuthority(mission) &&
    !hasPendingMainOwnedStartAuthority(mission)
  ) {
    return null;
  }
  if (!squad) {
    if (mission.squadId || !isFreeAgentChoiceContract(intentContract)) {
      return null;
    }
  } else if (!mission.squadId || squad.id !== mission.squadId) {
    return null;
  }
  const squadRevisionHash = squad
    ? snapshotSquadAuthority(squad).hash
    : FREE_MODE_NO_SQUAD_REVISION_HASH;
  // Hardened: seal dies if the approved squad hash drifted (reapprove).
  // Autopilot libre: bind to the live squad hash so the first pane is not
  // blocked by catalog churn after the operator already approved the mission.
  if (
    squad &&
    intentContract.squadRevisionHash !== squadRevisionHash &&
    !isOperatorChoicePolicy(getOrchSettings().squadCliPolicy)
  ) {
    return null;
  }
  const intentContractHash = hashMissionIntentAuthority(intentContract);
  return Object.freeze({
    intentVersion,
    intentContractHash,
    // Consult/ops missions may not own a frozen PREVC contract. Their exact
    // approved intent hash is still a fail-closed revision binding.
    contextRevision: input.contextRevision ?? intentContractHash,
    contractHash: input.contractHash ?? intentContractHash,
    squadRevisionHash,
  });
}

/** Resolve the current main-owned workflow binding, with intent hash fallback. */
export function resolveMissionPaneAuthoritySeal(
  scope: Readonly<ProjectExecutionScope>,
  mission: Mission,
  squad: Squad | null,
): MissionPaneAuthoritySeal | null {
  let contextRevision: string | undefined;
  let contractHash: string | undefined;
  try {
    const stored = getContextWorkflowService({ ...scope }).getMissionWorkflow(
      mission.id,
    ).contract?.contract;
    contextRevision = stored?.contextRevision;
    contractHash = stored?.contractHash;
  } catch {
    // A lane without PREVC workflow binds to its approved intent below.
  }
  return createMissionPaneAuthoritySeal({
    mission,
    squad,
    contextRevision,
    contractHash,
  });
}

export function sameMissionPaneAuthoritySeal(
  left: MissionPaneAuthoritySeal | null | undefined,
  right: MissionPaneAuthoritySeal | null | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.intentVersion === right.intentVersion &&
      left.intentContractHash === right.intentContractHash &&
      left.contextRevision === right.contextRevision &&
      left.contractHash === right.contractHash &&
      left.squadRevisionHash === right.squadRevisionHash,
  );
}

/**
 * A PREVC freeze/refreeze may rotate only the workflow half of an existing
 * orchestrator grant. Intent and squad identity remain the approval boundary;
 * a different value in any of these fields requires a new user approval.
 */
export function sameMissionPaneApprovalSeal(
  left: MissionPaneAuthoritySeal | null | undefined,
  right: MissionPaneAuthoritySeal | null | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.intentVersion === right.intentVersion &&
      left.intentContractHash === right.intentContractHash &&
      left.squadRevisionHash === right.squadRevisionHash,
  );
}
