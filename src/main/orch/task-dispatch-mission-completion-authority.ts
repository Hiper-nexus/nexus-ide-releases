import { createHash } from "node:crypto";
import { z } from "zod";
import {
  hasCurrentApprovedDispatchContract,
  missionIntentContractSchema,
} from "../../shared/mission-intent";
import { ScopedStoreBinding, ScopedStoreCorruptionError } from "./scoped-store";
import {
  EMPTY_GIT_DIFF_SHA256,
  sealedPlanDispatchSchema,
  sealedRosterDispatchSchema,
  taskDispatchIdSchema,
  taskDispatchRowSchema,
  taskDispatchTokenHash,
  taskIntegrationReceiptSchema,
} from "./task-dispatch-codec";
import { assertTaskDispatchMissionLifecycleAuthority } from "./task-dispatch-handoff-authority";
import { assertPhysicalTaskHandoffAuthority } from "./task-dispatch-physical-handoff-authority";
import {
  assertIntegratedPhysicalGitAuthority,
  assertNoChangePhysicalGitAuthority,
  assertReadOnlyPhysicalGitAuthority,
} from "./task-dispatch-physical-git-authority";
import { assertSealedTaskDispatchPlanAuthority } from "./task-dispatch-sealed-plan-authority";
import { missionRequiresGuidedPrevc } from "./guided-mission-authority";

export interface CompleteMissionFromVerifiedPlanInput {
  readonly missionId: string;
  readonly intentVersion: number;
}

type VerifiedPlanAuthorityMode = "inspect-guided" | "complete-legacy";

/**
 * One physical authority proof serves both completion owners. Guided PREVC
 * uses the read-only mode and leaves the mission running; legacy completion
 * performs its CAS in the same SQLite transaction as the proof.
 */
function verifyCompletedTaskPlanAuthority(
  binding: ScopedStoreBinding,
  input: CompleteMissionFromVerifiedPlanInput,
  mode: VerifiedPlanAuthorityMode,
): boolean {
  const missionId = taskDispatchIdSchema.parse(input.missionId);
  const intentVersion = z
    .number()
    .int()
    .nonnegative()
    .parse(input.intentVersion);
  const now = binding.now();
  const db = binding.writeDatabase();
  const verification = db.transaction(() => {
    const mission = db
      .prepare(
        `SELECT status, intent_state, intent_version, intent_contract_json, learnings,
                orch_session_id, squad_id
         FROM missions WHERE id = ?`,
      )
      .get(missionId) as
      | {
          status: string;
          intent_state: string;
          intent_version: number;
          intent_contract_json: string | null;
          learnings: string;
          orch_session_id: string | null;
          squad_id: string | null;
        }
      | undefined;
    if (!mission || mission.status !== "running") return false;
    if (mission.intent_version !== intentVersion) return false;
    if (
      mission.intent_state !== "dispatched" &&
      mission.intent_state !== "executing" &&
      mission.intent_state !== "validating"
    ) {
      return false;
    }
    if (!mission.intent_contract_json) return false;
    if (!mission.orch_session_id) return false;
    let intent;
    try {
      intent = missionIntentContractSchema.parse(
        JSON.parse(mission.intent_contract_json),
      );
    } catch (error) {
      throw new ScopedStoreCorruptionError(
        "mission completion intent contract",
        { cause: error },
      );
    }
    if (
      !hasCurrentApprovedDispatchContract({
        intentContract: intent,
        intentVersion: mission.intent_version,
      })
    ) {
      return false;
    }
    assertTaskDispatchMissionLifecycleAuthority(db, missionId, intentVersion);
    if (intent.intentVersion !== intentVersion || intent.lane !== "standard") {
      return false;
    }
    const guided = missionRequiresGuidedPrevc({
      squadId: mission.squad_id ?? undefined,
      intentContract: intent,
    });
    if (mode === "inspect-guided" ? !guided : guided) {
      // Beginner guided completion is exclusively mission-driver-owned.
      // Task metadata and legacy receipts cannot opt it into auto-done.
      return false;
    }
    const prevcReceipt = db
      .prepare(
        `SELECT 1 AS present FROM mission_step_receipts
           WHERE mission_id = ? LIMIT 1`,
      )
      .get(missionId);
    // Any immutable step receipt makes mission-driver the sole completion
    // authority, including non-guided/best-effort PREVC workflows.
    if (mode === "complete-legacy" && prevcReceipt !== undefined) return false;

    const rawPlan = db
      .prepare(
        `SELECT plan_hash, planner_json, squad_id, roster_hash,
                  roster_snapshot_json
           FROM mission_task_plans
         WHERE mission_id = ? AND intent_version = ?`,
      )
      .get(missionId, intentVersion) as
      | {
          plan_hash: string;
          planner_json: string;
          squad_id: string | null;
          roster_hash: string | null;
          roster_snapshot_json: string | null;
        }
      | undefined;
    if (!rawPlan) return false;
    if (
      !mission.squad_id ||
      !rawPlan.squad_id ||
      !rawPlan.roster_hash ||
      !rawPlan.roster_snapshot_json
    ) {
      return false;
    }
    if (taskDispatchTokenHash(rawPlan.planner_json) !== rawPlan.plan_hash) {
      throw new ScopedStoreCorruptionError("mission completion plan hash");
    }
    if (
      taskDispatchTokenHash(rawPlan.roster_snapshot_json) !==
      rawPlan.roster_hash
    ) {
      throw new ScopedStoreCorruptionError("mission completion roster hash");
    }
    let plan: z.infer<typeof sealedPlanDispatchSchema>;
    let roster: z.infer<typeof sealedRosterDispatchSchema>;
    try {
      plan = sealedPlanDispatchSchema.parse(JSON.parse(rawPlan.planner_json));
      roster = sealedRosterDispatchSchema.parse(
        JSON.parse(rawPlan.roster_snapshot_json),
      );
    } catch (error) {
      throw new ScopedStoreCorruptionError("mission completion plan receipt", {
        cause: error,
      });
    }
    if (
      plan.missionId !== missionId ||
      plan.intentVersion !== intentVersion ||
      plan.squadId !== rawPlan.squad_id ||
      plan.rosterHash !== rawPlan.roster_hash ||
      mission.squad_id !== rawPlan.squad_id ||
      plan.tasks.length === 0
    ) {
      throw new ScopedStoreCorruptionError(
        "mission completion plan coordinates",
      );
    }
    const dispatchRows = db
      .prepare(
        `SELECT * FROM task_dispatch_queue
         WHERE mission_id = ? AND intent_version = ?`,
      )
      .all(missionId, intentVersion)
      .map((row) => {
        try {
          return taskDispatchRowSchema.parse(row);
        } catch (error) {
          throw new ScopedStoreCorruptionError("mission completion dispatch", {
            cause: error,
          });
        }
      });
    const plannedIds = new Set(plan.tasks.map((entry) => entry.taskId));
    if (
      dispatchRows.length !== plannedIds.size ||
      dispatchRows.some((row) => !plannedIds.has(row.task_id))
    ) {
      return false;
    }
    const dispatchByTask = new Map(
      dispatchRows.map((row) => [row.task_id, row]),
    );
    const dependencyConsumptions = db
      .prepare(
        `SELECT mission_id, consumer_task_id, dependency_task_id, handoff_id,
                  consumer_session_id, consumer_worker_incarnation_id,
                  prompt_sha256, handoff_summary_sha256, consumed_at
           FROM task_dependency_consumption_receipts
           WHERE mission_id = ?`,
      )
      .all(missionId) as Array<{
      mission_id: string;
      consumer_task_id: string;
      dependency_task_id: string;
      handoff_id: string;
      consumer_session_id: string;
      consumer_worker_incarnation_id: string;
      prompt_sha256: string;
      handoff_summary_sha256: string;
      consumed_at: number;
    }>;
    const dependencyConsumptionByEdge = new Map(
      dependencyConsumptions.map((receipt) => [
        `${receipt.consumer_task_id}\0${receipt.dependency_task_id}`,
        receipt,
      ]),
    );
    if (dependencyConsumptionByEdge.size !== dependencyConsumptions.length) {
      throw new ScopedStoreCorruptionError(
        "mission completion dependency consumption identity",
      );
    }
    const rosterById = new Map(roster.agents.map((agent) => [agent.id, agent]));
    if (rosterById.size !== roster.agents.length) {
      throw new ScopedStoreCorruptionError(
        "mission completion roster identity",
      );
    }
    let expectedDependencyConsumptions = 0;
    const physicalReceiptIds = new Set<string>();
    const physicalToolCallIds = new Set<string>();
    for (const entry of plan.tasks) {
      const row = dispatchByTask.get(entry.taskId);
      const rosterAgent = rosterById.get(entry.agentRef);
      if (
        !row ||
        !rosterAgent ||
        row.roster_hash !== rawPlan.roster_hash ||
        row.agent_ref !== entry.agentRef ||
        row.agent_category !== entry.agentCategory ||
        row.worker_id !== rosterAgent.agentName ||
        row.state !== "completed" ||
        !row.integration_receipt_json ||
        !row.handoff_id ||
        !row.session_id ||
        !row.worker_incarnation_id ||
        row.handoff_accepted_at === null ||
        row.completed_at === null
      ) {
        return false;
      }
      let sealed: ReturnType<typeof assertSealedTaskDispatchPlanAuthority>;
      try {
        sealed = assertSealedTaskDispatchPlanAuthority(db, row);
      } catch (error) {
        if (error instanceof ScopedStoreCorruptionError) throw error;
        return false;
      }
      if (
        sealed.entry.taskId !== entry.taskId ||
        sealed.entry.agentRef !== entry.agentRef ||
        sealed.entry.agentCategory !== entry.agentCategory ||
        sealed.task.status !== "done"
      ) {
        return false;
      }
      let physical;
      try {
        physical = assertPhysicalTaskHandoffAuthority(db, binding.coordinates, {
          missionId,
          handoffId: row.handoff_id,
          sessionId: row.session_id,
          workerIncarnationId: row.worker_incarnation_id,
          workerId: row.worker_id,
          noLaterThan: row.handoff_accepted_at,
          requireCorrelatedAuditIntent: true,
          expectedStatus: "success",
        });
      } catch (error) {
        if (error instanceof ScopedStoreCorruptionError) throw error;
        return false;
      }
      if (
        physicalReceiptIds.has(physical.receiptId) ||
        physicalToolCallIds.has(physical.toolCallId)
      ) {
        throw new ScopedStoreCorruptionError(
          "mission completion physical handoff identity",
        );
      }
      physicalReceiptIds.add(physical.receiptId);
      physicalToolCallIds.add(physical.toolCallId);
      let receipt: z.infer<typeof taskIntegrationReceiptSchema>;
      try {
        receipt = taskIntegrationReceiptSchema.parse(
          JSON.parse(row.integration_receipt_json),
        );
      } catch (error) {
        throw new ScopedStoreCorruptionError(
          "mission completion integration receipt",
          { cause: error },
        );
      }
      if (
        sealed.routeConsumedAt > row.handoff_accepted_at ||
        physical.issuedAt > row.handoff_accepted_at ||
        row.handoff_accepted_at > row.completed_at ||
        row.completed_at > now ||
        receipt.completedAt !== row.completed_at
      ) {
        return false;
      }
      const noChangeMatch = /^no-change:([a-f0-9]{40,64}):([a-f0-9]{64})$/.exec(
        receipt.reference,
      );
      const advisoryMatch =
        /^advisory-no-change:([a-f0-9]{40,64}):([a-f0-9]{64})$/.exec(
          receipt.reference,
        );
      const isolatedReceiptIsValid =
        receipt.kind === "worktree_integrated" ||
        (receipt.kind === "worktree_validated_no_change" &&
          sealed.schedule.guidedTaskKind === "quality-gate" &&
          (receipt.evidenceIds?.length ?? 0) > 0 &&
          noChangeMatch !== null) ||
        (receipt.kind === "isolated_advisory_validated" &&
          sealed.schedule.guidedTaskKind === "isolated-advisory" &&
          (receipt.evidenceIds?.length ?? 0) > 0 &&
          advisoryMatch?.[2] === EMPTY_GIT_DIFF_SHA256);
      if (
        (row.execution_mode === "isolated_worktree" &&
          !isolatedReceiptIsValid) ||
        (row.execution_mode === "read_only" &&
          receipt.kind !== "read_only_validated") ||
        row.execution_mode === "same_checkout"
      ) {
        return false;
      }
      try {
        if (receipt.kind === "worktree_integrated") {
          assertIntegratedPhysicalGitAuthority({
            rootRealPath: binding.scope.rootRealPath,
            workerHeadSha: physical.worktreeHeadSha,
            integratedHeadSha: receipt.reference,
            checkoutMayHaveAdvanced: true,
          });
        } else if (
          receipt.kind === "worktree_validated_no_change" &&
          noChangeMatch
        ) {
          assertNoChangePhysicalGitAuthority({
            rootRealPath: binding.scope.rootRealPath,
            workerHeadSha: physical.worktreeHeadSha,
            expectedHeadSha: noChangeMatch[1]!,
            checkoutMayHaveAdvanced: true,
          });
        } else if (
          receipt.kind === "isolated_advisory_validated" &&
          advisoryMatch
        ) {
          assertNoChangePhysicalGitAuthority({
            rootRealPath: binding.scope.rootRealPath,
            workerHeadSha: physical.worktreeHeadSha,
            expectedHeadSha: advisoryMatch[1]!,
            checkoutMayHaveAdvanced: true,
          });
        } else if (receipt.kind === "read_only_validated") {
          assertReadOnlyPhysicalGitAuthority({
            rootRealPath: binding.scope.rootRealPath,
            workerHeadSha: physical.worktreeHeadSha,
          });
        }
      } catch {
        return false;
      }
      expectedDependencyConsumptions += sealed.schedule.dependsOn.length;
      for (const dependencyTaskId of sealed.schedule.dependsOn) {
        const dependencyDispatch = dispatchByTask.get(dependencyTaskId);
        const consumption = dependencyConsumptionByEdge.get(
          `${entry.taskId}\0${dependencyTaskId}`,
        );
        if (
          !dependencyDispatch ||
          dependencyDispatch.state !== "completed" ||
          !dependencyDispatch.handoff_id ||
          dependencyDispatch.completed_at === null ||
          !row.session_id ||
          !row.worker_incarnation_id ||
          row.handoff_accepted_at === null ||
          !consumption ||
          consumption.mission_id !== missionId ||
          consumption.handoff_id !== dependencyDispatch.handoff_id ||
          consumption.consumer_session_id !== row.session_id ||
          consumption.consumer_worker_incarnation_id !==
            row.worker_incarnation_id ||
          consumption.consumed_at < dependencyDispatch.completed_at ||
          consumption.consumed_at > physical.issuedAt ||
          !/^[a-f0-9]{64}$/.test(consumption.prompt_sha256)
        ) {
          return false;
        }
        const dependencyHandoff = db
          .prepare(
            `SELECT summary FROM handoffs
               WHERE id = ? AND mission_id = ?`,
          )
          .get(dependencyDispatch.handoff_id, missionId) as
          { summary: string } | undefined;
        if (
          !dependencyHandoff ||
          createHash("sha256")
            .update(dependencyHandoff.summary.trim())
            .digest("hex") !== consumption.handoff_summary_sha256
        ) {
          return false;
        }
      }
      const delivery = db
        .prepare(
          `SELECT h.status, h.session_id, h.worker_incarnation_id,
                  h.delivered, h.delivery_state, h.consumed_at,
                  h.consumed_by_session, h.consumed_delivery_attempt_id,
                  (
                    SELECT attempt.id FROM handoff_delivery_attempts AS attempt
                    WHERE attempt.handoff_id = h.id
                      AND attempt.mission_id = h.mission_id
                      AND attempt.state = 'accepted'
                      AND attempt.accepted_at IS NOT NULL
                      AND attempt.orchestrator_session_id = ?
                    ORDER BY attempt.accepted_at DESC, attempt.id DESC
                    LIMIT 1
                  ) AS accepted_attempt_id
           FROM handoffs AS h WHERE h.id = ? AND h.mission_id = ?`,
        )
        .get(mission.orch_session_id, row.handoff_id, missionId) as
        | {
            status: string;
            session_id: string | null;
            worker_incarnation_id: string | null;
            delivered: number;
            delivery_state: string;
            consumed_at: number | null;
            consumed_by_session: string | null;
            consumed_delivery_attempt_id: string | null;
            accepted_attempt_id: string | null;
          }
        | undefined;
      if (
        !delivery ||
        delivery.status !== "success" ||
        delivery.session_id !== row.session_id ||
        delivery.worker_incarnation_id !== row.worker_incarnation_id ||
        delivery.delivered !== 1 ||
        delivery.delivery_state !== "consumed" ||
        delivery.consumed_at === null ||
        delivery.consumed_by_session !== mission.orch_session_id ||
        !delivery.accepted_attempt_id ||
        delivery.consumed_delivery_attempt_id !== delivery.accepted_attempt_id
      ) {
        return false;
      }
    }
    if (dependencyConsumptions.length !== expectedDependencyConsumptions) {
      return false;
    }
    if (mode === "inspect-guided") return true;

    const note =
      `## Conclusão automática verificada\nO motor Nexus integrou e validou ` +
      `${plan.tasks.length} task(s) do plano ${rawPlan.plan_hash.slice(0, 12)}, ` +
      "com nexus_handoff_submit físicos, handoffs entregues, consumo " +
      "explicitamente reconhecido e receipts duráveis.";
    const separator = mission.learnings.trim() ? "\n\n" : "";
    const learnings = `${mission.learnings}${separator}${note}`.slice(
      0,
      65_536,
    );
    const updated = db
      .prepare(
        `UPDATE missions
         SET status = 'done', intent_state = 'done', learnings = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND intent_version = ?
           AND intent_state IN ('dispatched', 'executing', 'validating')
           AND intent_contract_json = ? AND squad_id = ?`,
      )
      .run(
        learnings,
        now,
        missionId,
        intentVersion,
        mission.intent_contract_json,
        mission.squad_id,
      );
    if (updated.changes !== 1) {
      throw new Error("mission verified completion lost CAS");
    }
    return true;
  });
  return mode === "inspect-guided"
    ? verification.deferred()
    : verification.immediate();
}

/**
 * Read-only, restart-safe proof for the guided post-merge bridge. A durable
 * `completed` bit is insufficient: this replays the exact sealed plan/roster,
 * physical MCP handoffs, Git ancestry, dependency consumption and delivery
 * acknowledgements without mutating mission state.
 */
export function hasVerifiedGuidedTaskPlanAuthority(
  binding: ScopedStoreBinding,
  input: CompleteMissionFromVerifiedPlanInput,
): boolean {
  return verifyCompletedTaskPlanAuthority(binding, input, "inspect-guided");
}

export function completeMissionFromVerifiedTaskPlan(
  binding: ScopedStoreBinding,
  input: CompleteMissionFromVerifiedPlanInput,
): boolean {
  const completed = verifyCompletedTaskPlanAuthority(
    binding,
    input,
    "complete-legacy",
  );
  if (completed) binding.emitChange();
  return completed;
}
