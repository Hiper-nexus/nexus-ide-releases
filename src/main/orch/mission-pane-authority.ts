import { createHash } from "node:crypto";
import type {
  Mission,
  MissionPaneAuthoritySeal,
  Squad,
} from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import { hasCurrentDispatchAuthority } from "../../shared/mission-intent";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";

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

export function createMissionPaneAuthoritySeal(input: {
  readonly mission: Mission;
  readonly squad: Squad;
  readonly contextRevision?: string;
  readonly contractHash?: string;
}): MissionPaneAuthoritySeal | null {
  const { mission, squad } = input;
  const intentVersion = mission.intentVersion ?? 0;
  const intentContract = mission.intentContract;
  if (
    !intentContract ||
    intentVersion <= 0 ||
    !hasCurrentDispatchAuthority(mission)
  ) {
    return null;
  }
  const squadRevisionHash = snapshotSquadAuthority(squad).hash;
  if (
    !mission.squadId ||
    squad.id !== mission.squadId ||
    intentContract.squadRevisionHash !== squadRevisionHash
  ) {
    return null;
  }
  const intentContractHash = sha256(intentContract);
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
  squad: Squad,
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
