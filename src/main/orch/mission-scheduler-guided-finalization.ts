import type { ProjectExecutionScope } from "../../shared/types";
import type {
  MergeValidationContext,
  MergeValidationDecision,
} from "../runtime/merge-queue";
import { MergeValidationRejectedError } from "../runtime/merge-queue";
import type { PreparedWorktreeNoChangeValidation } from "../runtime/worktree-contract";
import {
  EMPTY_GIT_DIFF_SHA256,
  type TaskDispatchRecord,
} from "./task-dispatch-codec";
import {
  hasGuidedDeliveryTaskDomain,
  parseGuidedTaskKind,
} from "./guided-task-kind";
import { validateMissionMergeWithLifecycleFence } from "./mission-scheduler-authority";
import { MissionSchedulerDispatchAuthorityError } from "./mission-scheduler-dispatch-transaction";

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const GIT_SHA = /^[a-f0-9]{40,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return (
    expected.size === left.length && right.every((value) => expected.has(value))
  );
}

function guidedTaskKindForDispatch(
  dispatch: TaskDispatchRecord,
): ReturnType<typeof parseGuidedTaskKind> {
  try {
    return parseGuidedTaskKind({
      agentCategory: dispatch.agentCategory,
      executionMode:
        dispatch.executionMode === "same_checkout"
          ? undefined
          : dispatch.executionMode,
      domains: dispatch.ownership.domains,
      label: dispatch.taskId,
    });
  } catch {
    // Eligibility predicates never grant authority to malformed projections.
    // The sealed store boundary reports the durable corruption separately.
    return null;
  }
}

export function isGuidedNoChangeQualityGate(
  dispatch: TaskDispatchRecord,
): boolean {
  return guidedTaskKindForDispatch(dispatch) === "quality-gate";
}

export function isGuidedIsolatedAdvisory(
  dispatch: TaskDispatchRecord,
): boolean {
  return guidedTaskKindForDispatch(dispatch) === "isolated-advisory";
}

export function isGuidedDeliveryOwnership(
  domains: readonly string[],
): boolean {
  return hasGuidedDeliveryTaskDomain(domains);
}

export interface GuidedNoChangeQualityGateDeps {
  prepare(): PreparedWorktreeNoChangeValidation | null;
  beginMerge(revision: number): TaskDispatchRecord;
  assertAuthority(): TaskDispatchRecord;
  validate(
    context: MergeValidationContext,
  ): Promise<MergeValidationDecision> | MergeValidationDecision;
  markValidated(prepared: PreparedWorktreeNoChangeValidation): void;
  complete(
    revision: number,
    receipt: {
      readonly kind: "worktree_validated_no_change";
      readonly reference: string;
      readonly completedAt: number;
      readonly evidenceIds: readonly string[];
    },
  ): void;
  now(): number;
}

export interface GuidedIsolatedAdvisoryDeps {
  prepare(): PreparedWorktreeNoChangeValidation | null;
  beginMerge(revision: number): TaskDispatchRecord;
  assertAuthority(): TaskDispatchRecord;
  markValidated(prepared: PreparedWorktreeNoChangeValidation): void;
  complete(revision: number, reference: string): void;
}

/**
 * Finalize the compatibility confinement used by advisory CLIs that cannot be
 * launched under a mechanical read-only sandbox.
 *
 * This path is deliberately disjoint from MergeQueue. The disposable
 * worktree must still be the exact clean integration HEAD and the exact
 * physical MCP worker handoff must bind that HEAD in the store. A commit,
 * dirty file or drift is a terminal contract violation, never a candidate to
 * integrate.
 */
export function finalizeGuidedIsolatedAdvisory(
  input: {
    readonly scope: ProjectExecutionScope;
    readonly missionId: string;
    readonly taskId: string;
    readonly dispatch: TaskDispatchRecord;
  },
  deps: GuidedIsolatedAdvisoryDeps,
): boolean {
  if (!isGuidedIsolatedAdvisory(input.dispatch)) return false;
  if (
    input.dispatch.missionId !== input.missionId ||
    input.dispatch.taskId !== input.taskId ||
    input.dispatch.projectId !== input.scope.projectId ||
    input.dispatch.checkoutId !== input.scope.checkoutId
  ) {
    throw new MissionSchedulerDispatchAuthorityError(
      "guided isolated advisory diverged from the authorized task identity",
    );
  }
  const prepared = deps.prepare();
  if (!prepared) {
    throw new MissionSchedulerDispatchAuthorityError(
      "guided isolated advisory produced committed changes; its disposable worktree is never integrated",
    );
  }
  if (
    prepared.record.projectId !== input.scope.projectId ||
    prepared.record.checkoutId !== input.scope.checkoutId ||
    prepared.record.rootRealPath !== input.scope.rootRealPath ||
    prepared.record.missionId !== input.missionId ||
    prepared.record.taskId !== input.taskId ||
    prepared.record.workerId !== input.dispatch.workerId ||
    !sameStringSet(
      prepared.record.ownership.files,
      input.dispatch.ownership.files,
    ) ||
    !sameStringSet(
      prepared.record.ownership.symbols,
      input.dispatch.ownership.symbols,
    ) ||
    !sameStringSet(
      prepared.record.ownership.domains,
      input.dispatch.ownership.domains,
    ) ||
    prepared.taskHeadSha !== prepared.integrationHeadSha ||
    prepared.changedFiles.length !== 0 ||
    !GIT_SHA.test(prepared.taskHeadSha) ||
    !SHA256.test(prepared.diffHash) ||
    prepared.diffHash !== EMPTY_GIT_DIFF_SHA256
  ) {
    throw new MissionSchedulerDispatchAuthorityError(
      "guided isolated advisory preparation diverged from the authorized task identity",
    );
  }
  let dispatch = input.dispatch;
  if (dispatch.state === "handoff_ready") {
    dispatch = deps.beginMerge(dispatch.revision);
  }
  if (dispatch.state !== "merging") {
    throw new MissionSchedulerDispatchAuthorityError(
      "guided isolated advisory requires handoff_ready or merging dispatch",
    );
  }
  const assertCurrentAuthority = () => {
    const current = deps.assertAuthority();
    if (
      current.state !== "merging" ||
      current.id !== input.dispatch.id ||
      current.projectId !== input.dispatch.projectId ||
      current.checkoutId !== input.dispatch.checkoutId ||
      current.missionId !== input.dispatch.missionId ||
      current.taskId !== input.dispatch.taskId ||
      current.intentVersion !== input.dispatch.intentVersion ||
      current.workerId !== input.dispatch.workerId ||
      current.workerIncarnationId !== input.dispatch.workerIncarnationId ||
      current.handoffId !== input.dispatch.handoffId ||
      current.agentRef !== input.dispatch.agentRef ||
      !isGuidedIsolatedAdvisory(current)
    ) {
      throw new MissionSchedulerDispatchAuthorityError(
        "guided isolated advisory lifecycle authority was revoked",
      );
    }
    return current;
  };
  assertCurrentAuthority();
  deps.markValidated(prepared);
  const current = assertCurrentAuthority();
  deps.complete(
    current.revision,
    `advisory-no-change:${prepared.taskHeadSha}:${prepared.diffHash}`,
  );
  return true;
}

/**
 * Complete the conditional green branch of the guided QA wave.
 *
 * A normal executor or a QA worktree with a real diff returns false and keeps
 * the ordinary MergeQueue path. Only an exact reviewer/domain contract, clean
 * unchanged Git identity, green main-owned sensors and independent review can
 * mint the no-change receipt.
 */
export async function finalizeGuidedNoChangeQualityGate(
  input: {
    readonly scope: ProjectExecutionScope;
    readonly missionId: string;
    readonly taskId: string;
    readonly dispatch: TaskDispatchRecord;
  },
  deps: GuidedNoChangeQualityGateDeps,
): Promise<boolean> {
  if (!isGuidedNoChangeQualityGate(input.dispatch)) return false;
  if (
    input.dispatch.missionId !== input.missionId ||
    input.dispatch.taskId !== input.taskId ||
    input.dispatch.projectId !== input.scope.projectId ||
    input.dispatch.checkoutId !== input.scope.checkoutId
  ) {
    throw new Error(
      "guided no-change dispatch diverged from the authorized task identity",
    );
  }
  const prepared = deps.prepare();
  if (!prepared) return false;
  if (
    prepared.record.projectId !== input.scope.projectId ||
    prepared.record.checkoutId !== input.scope.checkoutId ||
    prepared.record.rootRealPath !== input.scope.rootRealPath ||
    prepared.record.missionId !== input.missionId ||
    prepared.record.taskId !== input.taskId ||
    prepared.record.workerId !== input.dispatch.workerId ||
    !sameStringSet(
      prepared.record.ownership.files,
      input.dispatch.ownership.files,
    ) ||
    !sameStringSet(
      prepared.record.ownership.symbols,
      input.dispatch.ownership.symbols,
    ) ||
    !sameStringSet(
      prepared.record.ownership.domains,
      input.dispatch.ownership.domains,
    ) ||
    prepared.taskHeadSha !== prepared.integrationHeadSha ||
    prepared.changedFiles.length !== 0 ||
    !GIT_SHA.test(prepared.taskHeadSha) ||
    !SHA256.test(prepared.diffHash)
  ) {
    throw new Error(
      "guided no-change preparation diverged from the authorized task identity",
    );
  }
  let dispatch = input.dispatch;
  if (dispatch.state === "handoff_ready") {
    dispatch = deps.beginMerge(dispatch.revision);
  }
  if (dispatch.state !== "merging") {
    throw new Error(
      "guided no-change validation requires handoff_ready or merging dispatch",
    );
  }
  const assertCurrentAuthority = () => {
    const current = deps.assertAuthority();
    if (
      current.state !== "merging" ||
      current.id !== input.dispatch.id ||
      current.projectId !== input.dispatch.projectId ||
      current.checkoutId !== input.dispatch.checkoutId ||
      current.missionId !== input.dispatch.missionId ||
      current.taskId !== input.dispatch.taskId ||
      current.intentVersion !== input.dispatch.intentVersion ||
      current.workerId !== input.dispatch.workerId ||
      current.workerIncarnationId !== input.dispatch.workerIncarnationId ||
      current.handoffId !== input.dispatch.handoffId ||
      current.agentRef !== input.dispatch.agentRef ||
      !isGuidedNoChangeQualityGate(current)
    ) {
      throw new Error("guided no-change lifecycle authority was revoked");
    }
  };
  const context: MergeValidationContext = Object.freeze({
    phase: "candidate",
    scope: Object.freeze({ ...input.scope }),
    missionId: input.missionId,
    taskId: input.taskId,
    taskKey: prepared.record.taskKey,
    checkoutPath: prepared.record.worktreePath,
    integrationBaseSha: prepared.integrationHeadSha,
    taskHeadSha: prepared.taskHeadSha,
    candidateSha: prepared.taskHeadSha,
    diffHash: prepared.diffHash,
    changedFiles: Object.freeze([]),
    assertCurrentAuthority,
  });
  const decision = await validateMissionMergeWithLifecycleFence({
    assertCurrentAuthority,
    validate: () => deps.validate(context),
  });
  const evidenceIds = Object.freeze([...new Set(decision.evidenceIds)]);
  if (
    decision.sensorsPassed !== true ||
    decision.reviewPassed !== true ||
    evidenceIds.length === 0 ||
    evidenceIds.length > 256 ||
    evidenceIds.some((id) => !EVIDENCE_ID.test(id))
  ) {
    throw new MergeValidationRejectedError("candidate", evidenceIds);
  }
  assertCurrentAuthority();
  deps.markValidated(prepared);
  const current = deps.assertAuthority();
  deps.complete(current.revision, {
    kind: "worktree_validated_no_change",
    reference: `no-change:${prepared.taskHeadSha}:${prepared.diffHash}`,
    completedAt: deps.now(),
    evidenceIds,
  });
  return true;
}
