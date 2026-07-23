import { z } from "zod";
import {
  hasCurrentApprovedDispatchContract,
  missionIntentContractSchema,
} from "../../shared/mission-intent";
import { ScopedStoreBinding, ScopedStoreCorruptionError } from "./scoped-store";
import {
  sealedPlanDispatchSchema,
  sealedRosterDispatchSchema,
  taskDispatchIdSchema,
  taskDispatchRowSchema,
  taskDispatchTokenHash,
  taskIntegrationReceiptSchema,
} from "./task-dispatch-codec";
import { assertTaskDispatchMissionLifecycleAuthority } from "./task-dispatch-handoff-authority";

export interface CompleteMissionFromVerifiedPlanInput {
  readonly missionId: string;
  readonly intentVersion: number;
}

export function completeMissionFromVerifiedTaskPlan(
  binding: ScopedStoreBinding,
  input: CompleteMissionFromVerifiedPlanInput,
): boolean {
  const missionId = taskDispatchIdSchema.parse(input.missionId);
  const intentVersion = z
    .number()
    .int()
    .nonnegative()
    .parse(input.intentVersion);
  const now = binding.now();
  const db = binding.writeDatabase();
  const completed = db
    .transaction(() => {
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
      assertTaskDispatchMissionLifecycleAuthority(
        db,
        missionId,
        intentVersion,
      );
      if (
        intent.intentVersion !== intentVersion ||
        intent.lane !== "standard"
      ) {
        return false;
      }
      // PREVC completion has stronger receipt requirements and is advanced by
      // mission-driver; never turn task receipts into a PREVC bypass.
      const frozen = db
        .prepare(
          `SELECT 1 AS present FROM mission_contracts WHERE mission_id = ?`,
        )
        .get(missionId);
      if (frozen !== undefined) return false;

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
        throw new ScopedStoreCorruptionError(
          "mission completion roster hash",
        );
      }
      let plan: z.infer<typeof sealedPlanDispatchSchema>;
      let roster: z.infer<typeof sealedRosterDispatchSchema>;
      try {
        plan = sealedPlanDispatchSchema.parse(JSON.parse(rawPlan.planner_json));
        roster = sealedRosterDispatchSchema.parse(
          JSON.parse(rawPlan.roster_snapshot_json),
        );
      } catch (error) {
        throw new ScopedStoreCorruptionError(
          "mission completion plan receipt",
          {
            cause: error,
          },
        );
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
            throw new ScopedStoreCorruptionError(
              "mission completion dispatch",
              {
                cause: error,
              },
            );
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
      const rosterById = new Map(
        roster.agents.map((agent) => [agent.id, agent]),
      );
      if (rosterById.size !== roster.agents.length) {
        throw new ScopedStoreCorruptionError(
          "mission completion roster identity",
        );
      }
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
          !row.session_id
        ) {
          return false;
        }
        const receipt = taskIntegrationReceiptSchema.parse(
          JSON.parse(row.integration_receipt_json),
        );
        if (
          (row.execution_mode === "isolated_worktree" &&
            receipt.kind !== "worktree_integrated") ||
          (row.execution_mode === "read_only" &&
            receipt.kind !== "read_only_validated") ||
          row.execution_mode === "same_checkout"
        ) {
          return false;
        }
        const task = db
          .prepare(`SELECT status FROM tasks WHERE id = ? AND mission_id = ?`)
          .get(entry.taskId, missionId) as { status: string } | undefined;
        if (task?.status !== "done") return false;
        const delivery = db
          .prepare(
            `SELECT h.status, h.session_id, h.worker_incarnation_id,
                  h.delivered, h.delivery_state,
                  EXISTS (
                    SELECT 1 FROM handoff_delivery_attempts AS attempt
                    WHERE attempt.handoff_id = h.id
                      AND attempt.mission_id = h.mission_id
                      AND attempt.state = 'accepted'
                      AND attempt.accepted_at IS NOT NULL
                      AND attempt.orchestrator_session_id = ?
                  ) AS accepted_attempt
           FROM handoffs AS h WHERE h.id = ? AND h.mission_id = ?`,
          )
          .get(mission.orch_session_id, row.handoff_id, missionId) as
          | {
              status: string;
              session_id: string | null;
              worker_incarnation_id: string | null;
              delivered: number;
              delivery_state: string;
              accepted_attempt: number;
            }
          | undefined;
        if (
          !delivery ||
          delivery.status !== "success" ||
          delivery.session_id !== row.session_id ||
          delivery.worker_incarnation_id !== row.worker_incarnation_id ||
          delivery.delivered !== 1 ||
          delivery.delivery_state === "queued" ||
          delivery.accepted_attempt !== 1
        ) {
          return false;
        }
      }

      const note =
        `## Conclusão automática verificada\nO motor Nexus integrou e validou ` +
        `${plan.tasks.length} task(s) do plano ${rawPlan.plan_hash.slice(0, 12)}, ` +
        "com handoffs entregues e receipts duráveis.";
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
    })
    .immediate();
  if (completed) binding.emitChange();
  return completed;
}
