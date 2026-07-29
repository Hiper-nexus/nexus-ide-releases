import { createHash } from "node:crypto";
import { z } from "zod";
import {
  hasCurrentApprovedDispatchContract,
  missionIntentContractSchema,
} from "../../shared/mission-intent";
import { hasTeamReadOnlyFanoutDomain } from "../../shared/mission-topology";
import { PRIOR_MISSION_MEMORY_SEPARATOR } from "../../shared/mission-result-format";
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
import { assertTaskQualityReceiptAuthority } from "./task-dispatch-quality-receipt-authority";
import { missionRequiresGuidedPrevc } from "./guided-mission-authority";
import {
  inspectCurrentAgentTransportPhysicalReceipt,
  type AgentTransportPhysicalReceipt,
} from "./http-mcp-boundary";
import { physicalAgentActionPayloadSha256 } from "./handoff-payload-identity";
import {
  parseFanoutFinalOutput,
  persistFanoutConsolidationReceipt,
  readVerifiedFanoutConsolidation,
  verifiedFanoutAckTime,
} from "./fanout-consolidation-receipt-authority";

export interface CompleteMissionFromVerifiedPlanInput {
  readonly missionId: string;
  readonly intentVersion: number;
}

export interface RecordFanoutMissionConsolidationInput
  extends CompleteMissionFromVerifiedPlanInput {
  readonly orchestratorSessionId: string;
  readonly finalOutput: string;
  readonly physicalReceipt: AgentTransportPhysicalReceipt;
}

type VerifiedPlanAuthorityMode =
  | "inspect-guided"
  | "record-fanout-consolidation"
  | "complete-legacy";

const MAX_VISIBLE_MISSION_RESULT_CHARS = 65_536;
function boundedFanoutLearnings(
  finalOutput: string,
  priorLearnings: string,
): string {
  const available =
    MAX_VISIBLE_MISSION_RESULT_CHARS -
    finalOutput.length -
    PRIOR_MISSION_MEMORY_SEPARATOR.length;
  if (!priorLearnings.trim() || available <= 0) return finalOutput;
  return (
    finalOutput +
    PRIOR_MISSION_MEMORY_SEPARATOR +
    priorLearnings.slice(-available)
  );
}

/**
 * One physical authority proof serves both completion owners. Guided PREVC
 * uses the read-only mode and leaves the mission running; legacy completion
 * performs its CAS in the same SQLite transaction as the proof.
 */
function verifyCompletedTaskPlanAuthority(
  binding: ScopedStoreBinding,
  input:
    | CompleteMissionFromVerifiedPlanInput
    | RecordFanoutMissionConsolidationInput,
  mode: VerifiedPlanAuthorityMode,
): boolean {
  const missionId = taskDispatchIdSchema.parse(input.missionId);
  const intentVersion = z
    .number()
    .int()
    .nonnegative()
    .parse(input.intentVersion);
  const consolidation =
    mode === "record-fanout-consolidation"
      ? parseFanoutFinalOutput(
          (input as RecordFanoutMissionConsolidationInput).finalOutput,
        )
      : null;
  const consolidationInput =
    mode === "record-fanout-consolidation"
      ? (input as RecordFanoutMissionConsolidationInput)
      : null;
  const consolidationPayloadSha256 =
    consolidation && consolidationInput
      ? physicalAgentActionPayloadSha256("nexus_mission_set_status", {
          missionId,
          status: "done",
          note: consolidation.finalOutput,
        })
      : null;
  const consolidationExpectation =
    consolidationInput && consolidationPayloadSha256
      ? {
          projectId: binding.scope.projectId,
          checkoutId: binding.scope.checkoutId,
          missionId,
          sessionId: taskDispatchIdSchema.parse(
            consolidationInput.orchestratorSessionId,
          ),
          rawPayloadSha256: consolidationPayloadSha256,
        }
      : null;
  const inspectedConsolidationReceipt =
    consolidationInput && consolidationExpectation
      ? inspectCurrentAgentTransportPhysicalReceipt(
          consolidationInput.physicalReceipt,
          consolidationExpectation,
        )
      : null;
  if (
    inspectedConsolidationReceipt &&
    inspectedConsolidationReceipt.toolName !== "nexus_mission_set_status"
  ) {
    throw new Error(
      "fanout consolidation requires an exact physical nexus_mission_set_status receipt",
    );
  }
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
    const prevcReceipt = db
      .prepare(
        `SELECT 1 AS present FROM mission_step_receipts
           WHERE mission_id = ? LIMIT 1`,
      )
      .get(missionId);
    // Any immutable step receipt makes mission-driver the sole completion
    // authority, including non-guided/best-effort PREVC workflows.
    if (
      mode !== "inspect-guided" &&
      prevcReceipt !== undefined
    ) {
      return false;
    }

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
    let teamReadOnlyFanoutDispatches = 0;
    const completedDeliveries: Array<{
      readonly handoffId: string;
      readonly deliveryAttemptId: string;
      readonly acceptedAt: number;
      readonly consumedAt: number | null;
      readonly hasExactConsumption: boolean;
    }> = [];
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
      if (
        hasTeamReadOnlyFanoutDomain(sealed.schedule.ownership.domains)
      ) {
        teamReadOnlyFanoutDispatches += 1;
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
          assertTaskQualityReceiptAuthority({
            db,
            coordinates: binding.coordinates,
            rootRealPath: binding.scope.rootRealPath,
            missionId,
            physicalHeadSha: physical.worktreeHeadSha!,
            receipt,
            requireEmbeddedProof: true,
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
          assertTaskQualityReceiptAuthority({
            db,
            coordinates: binding.coordinates,
            rootRealPath: binding.scope.rootRealPath,
            missionId,
            physicalHeadSha: physical.worktreeHeadSha!,
            receipt,
            requireEmbeddedProof: true,
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
                  ) AS accepted_attempt_id,
                  (
                    SELECT attempt.accepted_at
                    FROM handoff_delivery_attempts AS attempt
                    WHERE attempt.handoff_id = h.id
                      AND attempt.mission_id = h.mission_id
                      AND attempt.state = 'accepted'
                      AND attempt.accepted_at IS NOT NULL
                      AND attempt.orchestrator_session_id = ?
                    ORDER BY attempt.accepted_at DESC, attempt.id DESC
                    LIMIT 1
                  ) AS accepted_at
           FROM handoffs AS h WHERE h.id = ? AND h.mission_id = ?`,
        )
        .get(
          mission.orch_session_id,
          mission.orch_session_id,
          row.handoff_id,
          missionId,
        ) as
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
            accepted_at: number | null;
          }
        | undefined;
      const hasExactConsumption =
        delivery?.delivery_state === "consumed" &&
        delivery.consumed_at !== null &&
        delivery.consumed_by_session === mission.orch_session_id &&
        delivery.consumed_delivery_attempt_id ===
          delivery.accepted_attempt_id;
      const isAwaitingExplicitConsumption =
        (delivery?.delivery_state === "submitted" ||
          delivery?.delivery_state === "acknowledged") &&
        delivery.consumed_at === null &&
        delivery.consumed_by_session === null &&
        delivery.consumed_delivery_attempt_id === null;
      if (
        !delivery ||
        delivery.status !== "success" ||
        delivery.session_id !== row.session_id ||
        delivery.worker_incarnation_id !== row.worker_incarnation_id ||
        delivery.delivered !== 1 ||
        !delivery.accepted_attempt_id ||
        delivery.accepted_at === null ||
        (!hasExactConsumption && !isAwaitingExplicitConsumption)
      ) {
        return false;
      }
      completedDeliveries.push({
        handoffId: row.handoff_id,
        deliveryAttemptId: delivery.accepted_attempt_id,
        acceptedAt: delivery.accepted_at,
        consumedAt: delivery.consumed_at,
        hasExactConsumption,
      });
    }
    if (
      teamReadOnlyFanoutDispatches > 0 &&
      teamReadOnlyFanoutDispatches < dispatchRows.length
    ) {
      // A marker is Main-owned topology authority, not decorative metadata.
      // A mixed immutable receipt is therefore neither delivery nor fan-out
      // and must never fall through to a saved squad's legacy completion.
      return false;
    }
    const sealedTopology =
      teamReadOnlyFanoutDispatches === dispatchRows.length
        ? "team-read-only-fanout"
        : "delivery";
    const guided = missionRequiresGuidedPrevc(
      {
        squadId: mission.squad_id ?? undefined,
        intentContract: intent,
      },
      sealedTopology,
    );
    if (mode === "inspect-guided" ? !guided : guided) {
      // The sealed plan decides the completion owner. Goal wording is not
      // reinterpreted after approval; mixed markers were rejected above.
      return false;
    }
    if (dependencyConsumptions.length !== expectedDependencyConsumptions) {
      return false;
    }
    let latestFanoutAckAt = 0;
    if (sealedTopology === "team-read-only-fanout") {
      for (const delivery of completedDeliveries) {
        if (
          !delivery.hasExactConsumption ||
          delivery.consumedAt === null
        ) {
          return false;
        }
        const ackAt = verifiedFanoutAckTime(db, binding, {
          missionId,
          orchestratorSessionId: mission.orch_session_id,
          handoffId: delivery.handoffId,
          deliveryAttemptId: delivery.deliveryAttemptId,
          acceptedAt: delivery.acceptedAt,
          consumedAt: delivery.consumedAt,
          now,
        });
        if (ackAt === null) return false;
        latestFanoutAckAt = Math.max(latestFanoutAckAt, ackAt);
      }
    }
    if (mode === "record-fanout-consolidation") {
      if (
        sealedTopology !== "team-read-only-fanout" ||
        !consolidation ||
        !consolidationInput ||
        !consolidationPayloadSha256 ||
        !consolidationExpectation ||
        !inspectedConsolidationReceipt ||
        consolidationInput.orchestratorSessionId !== mission.orch_session_id ||
        inspectedConsolidationReceipt.issuedAt < latestFanoutAckAt
      ) {
        return false;
      }
      return persistFanoutConsolidationReceipt(db, binding, {
        missionId,
        intentVersion,
        planHash: rawPlan.plan_hash,
        orchestratorSessionId: mission.orch_session_id,
        finalOutput: consolidation.finalOutput,
        maestroPerspective: consolidation.maestroPerspective,
        payloadSha256: consolidationPayloadSha256,
        now,
        physicalReceipt: consolidationInput.physicalReceipt,
        expectation: consolidationExpectation,
        inspected: inspectedConsolidationReceipt,
      });
    }
    if (mode === "inspect-guided") return true;

    const fanoutConsolidation =
      sealedTopology === "team-read-only-fanout"
        ? readVerifiedFanoutConsolidation(db, binding, {
            missionId,
            intentVersion,
            planHash: rawPlan.plan_hash,
            orchestratorSessionId: mission.orch_session_id,
            latestAckAt: latestFanoutAckAt,
            now,
          })
        : null;
    if (
      sealedTopology === "team-read-only-fanout" &&
      !fanoutConsolidation
    ) {
      return false;
    }

    const authorityNote =
      `## Conclusão automática verificada\nO motor Nexus integrou e validou ` +
      `${plan.tasks.length} task(s) do plano ${rawPlan.plan_hash.slice(0, 12)}, ` +
      (sealedTopology === "team-read-only-fanout"
        ? "com nexus_handoff_submit físicos, handoffs entregues, consumo " +
          "explicitamente reconhecido e receipts duráveis."
        : "com nexus_handoff_submit físicos, handoffs aceitos pela sessão " +
          "atual e receipts duráveis.");
    // The visible fan-out result is the product, not an append-only diagnostic.
    // Preserve it byte-for-byte within the same 64 KiB bound used by the
    // physical receipt. Prefixing old learnings used to truncate the newest
    // Maestro synthesis and made a successful mission appear to lose output.
    const learnings = fanoutConsolidation
      ? boundedFanoutLearnings(
          fanoutConsolidation.final_output,
          mission.learnings,
        )
      : `${mission.learnings}${mission.learnings.trim() ? "\n\n" : ""}${authorityNote}`
          .slice(0, 65_536);
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

interface FanoutReplayInput {
  readonly missionId: string;
  readonly orchestratorSessionId: string;
  readonly finalOutput: string;
}

function exactExistingFanoutConsolidation(
  binding: ScopedStoreBinding,
  input: FanoutReplayInput,
) {
  const db = binding.readDatabase();
  const mission = db
    .prepare(
      `SELECT status, intent_version, orch_session_id
       FROM missions WHERE id = ?`,
    )
    .get(input.missionId) as
    | {
        readonly status: string;
        readonly intent_version: number;
        readonly orch_session_id: string | null;
      }
    | undefined;
  if (
    mission?.status !== "done" ||
    mission.orch_session_id !== input.orchestratorSessionId
  ) {
    return null;
  }
  const plan = db
    .prepare(
      `SELECT plan_hash FROM mission_task_plans
       WHERE mission_id = ? AND intent_version = ?`,
    )
    .get(input.missionId, mission.intent_version) as
    | { readonly plan_hash: string }
    | undefined;
  const latestAck = db
    .prepare(
      `SELECT COALESCE(MAX(acknowledged_at), 0) AS at
       FROM handoff_ack_receipts
       WHERE mission_id = ? AND orchestrator_session_id = ?`,
    )
    .get(input.missionId, input.orchestratorSessionId) as {
    readonly at: number;
  };
  if (!plan) return null;
  const receipt = readVerifiedFanoutConsolidation(db, binding, {
    missionId: input.missionId,
    intentVersion: mission.intent_version,
    planHash: plan.plan_hash,
    orchestratorSessionId: input.orchestratorSessionId,
    latestAckAt: latestAck.at,
    now: binding.now(),
  });
  return receipt?.final_output === input.finalOutput
    ? { intentVersion: mission.intent_version, planHash: plan.plan_hash }
    : null;
}

export function hasExactFanoutConsolidationReplay(
  binding: ScopedStoreBinding,
  rawInput: FanoutReplayInput,
): boolean {
  const input = {
    missionId: taskDispatchIdSchema.parse(rawInput.missionId),
    orchestratorSessionId: taskDispatchIdSchema.parse(
      rawInput.orchestratorSessionId,
    ),
    finalOutput: parseFanoutFinalOutput(rawInput.finalOutput).finalOutput,
  };
  return exactExistingFanoutConsolidation(binding, input) !== null;
}

function replayFanoutMissionConsolidation(
  binding: ScopedStoreBinding,
  input: RecordFanoutMissionConsolidationInput,
): boolean {
  const consolidation = parseFanoutFinalOutput(input.finalOutput);
  const exact = exactExistingFanoutConsolidation(binding, {
    missionId: input.missionId,
    orchestratorSessionId: input.orchestratorSessionId,
    finalOutput: consolidation.finalOutput,
  });
  if (!exact) return false;
  const payloadSha256 = physicalAgentActionPayloadSha256(
    "nexus_mission_set_status",
    { missionId: input.missionId, status: "done", note: consolidation.finalOutput },
  );
  const expectation = {
    projectId: binding.scope.projectId,
    checkoutId: binding.scope.checkoutId,
    missionId: input.missionId,
    sessionId: input.orchestratorSessionId,
    rawPayloadSha256: payloadSha256,
  };
  const inspected = inspectCurrentAgentTransportPhysicalReceipt(
    input.physicalReceipt,
    expectation,
  );
  const db = binding.writeDatabase();
  return db.transaction(() => {
    const current = exactExistingFanoutConsolidation(binding, {
      missionId: input.missionId,
      orchestratorSessionId: input.orchestratorSessionId,
      finalOutput: consolidation.finalOutput,
    });
    if (
      !current ||
      current.intentVersion !== exact.intentVersion ||
      current.planHash !== exact.planHash
    ) {
      return false;
    }
    return persistFanoutConsolidationReceipt(db, binding, {
      ...input,
      ...consolidation,
      ...exact,
      payloadSha256,
      now: binding.now(),
      expectation,
      inspected,
    });
  }).immediate();
}

export function recordFanoutMissionConsolidation(
  binding: ScopedStoreBinding,
  input: RecordFanoutMissionConsolidationInput,
): boolean {
  const recorded = verifyCompletedTaskPlanAuthority(
    binding,
    input,
    "record-fanout-consolidation",
  );
  const replayed = recorded
    ? false
    : replayFanoutMissionConsolidation(binding, input);
  if (recorded || replayed) binding.emitChange();
  return recorded || replayed;
}
