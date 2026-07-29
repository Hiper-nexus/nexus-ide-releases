import { z } from "zod";
import { squadAgentSchema } from "../../shared/orch-types";
import {
  ownershipsIntersect,
  requiresExclusiveSlot,
  type ScheduleOwnership,
} from "./mission-scheduler";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";
import {
  supportsAdvisoryParticipationCli,
  supportsMechanicallyReadOnlyCli,
  supportsMechanicallyWorkspaceWriteCli,
} from "./mission-scheduler-plan";
import { getOrchSettings } from "../persistence/settings-store";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import { isRoutableModelResolution } from "./task-router";
import { ScopedStoreBinding, ScopedStoreCorruptionError } from "./scoped-store";
import {
  sealedPlanDispatchSchema,
  sealedRosterDispatchSchema,
  taskDispatchExecutionModeSchema,
  taskDispatchIdSchema,
  taskDispatchOwnershipSchema,
  taskDispatchRouteContractSchema,
  taskDispatchTokenHash,
  taskDispatchWorkerCategorySchema,
  type ClaimedTaskDispatch,
  type TaskDispatchRouteContract,
  type TaskDispatchWorkerCategory,
} from "./task-dispatch-codec";
import { assertTaskDispatchMissionLifecycleAuthority } from "./task-dispatch-handoff-authority";
import {
  getTaskDispatchFromDatabase,
  getTaskDispatchRow,
} from "./task-dispatch-persistence";

export interface TaskDispatchClaimInput {
  readonly missionId: string;
  readonly taskId: string;
  readonly intentVersion: number;
  readonly workerId: string;
  readonly leaseOwner: string;
  readonly leaseMs: number;
  readonly maxWorkers?: number;
  readonly ownership?: ScheduleOwnership;
  readonly executionMode?: z.infer<typeof taskDispatchExecutionModeSchema>;
  readonly agentRef?: string;
  readonly agentCategory?: TaskDispatchWorkerCategory;
  readonly rosterHash?: string;
  readonly routeContract?: TaskDispatchRouteContract;
}

export function claimTaskDispatch(
  binding: ScopedStoreBinding,
  input: TaskDispatchClaimInput,
): ClaimedTaskDispatch {
  const missionId = taskDispatchIdSchema.parse(input.missionId);
  const taskId = taskDispatchIdSchema.parse(input.taskId);
  const workerId = taskDispatchIdSchema.parse(input.workerId);
  const leaseOwner = taskDispatchIdSchema.parse(input.leaseOwner);
  const intentVersion = z
    .number()
    .int()
    .nonnegative()
    .parse(input.intentVersion);
  const leaseMs = z
    .number()
    .int()
    .positive()
    .max(60 * 60_000)
    .parse(input.leaseMs);
  const maxWorkers =
    input.maxWorkers === undefined
      ? undefined
      : z.number().int().positive().max(64).parse(input.maxWorkers);
  const ownership = taskDispatchOwnershipSchema.parse(
    input.ownership ?? {
      files: [],
      symbols: [],
      domains: [],
    },
  );
  const executionMode = taskDispatchExecutionModeSchema.parse(
    input.executionMode ?? "isolated_worktree",
  );
  const agentRef =
    input.agentRef === undefined
      ? undefined
      : taskDispatchIdSchema.parse(input.agentRef);
  const agentCategory =
    input.agentCategory === undefined
      ? undefined
      : taskDispatchWorkerCategorySchema.parse(input.agentCategory);
  const rosterHash =
    input.rosterHash === undefined
      ? undefined
      : z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(input.rosterHash);
  const routeContract =
    input.routeContract === undefined
      ? undefined
      : taskDispatchRouteContractSchema.parse(input.routeContract);
  const now = binding.now();
  const leaseToken = binding.makeId("dispatch-lease");
  const dispatchId = binding.makeId("task-dispatch");
  const workerIncarnationId = binding.makeId("worker-incarnation");
  const db = binding.writeDatabase();

  const record = db
    .transaction(() => {
      const mission = db
        .prepare(`SELECT status, intent_version FROM missions WHERE id = ?`)
        .get(missionId) as
        { status: string; intent_version: number } | undefined;
      if (!mission) throw new Error(`missão não encontrada: ${missionId}`);
      if (mission.status !== "running") {
        throw new Error("task dispatch exige missão running");
      }
      if (mission.intent_version !== intentVersion) {
        throw new Error(
          `intentVersion obsoleta: missão=${mission.intent_version}, dispatch=${intentVersion}`,
        );
      }
      assertTaskDispatchMissionLifecycleAuthority(
        db,
        missionId,
        intentVersion,
      );
      const plan = db
        .prepare(
          `SELECT squad_id, roster_hash, roster_snapshot_json, planner_json, plan_hash
         FROM mission_task_plans
         WHERE mission_id = ? AND intent_version = ?`,
        )
        .get(missionId, intentVersion) as
        | {
            squad_id: string | null;
            roster_hash: string | null;
            roster_snapshot_json: string | null;
            planner_json: string;
            plan_hash: string;
          }
        | undefined;
      let sealedEntry:
        z.infer<typeof sealedPlanDispatchSchema>["tasks"][number] | null = null;
      let sealedAgent: z.infer<typeof squadAgentSchema> | null = null;
      let sealedOrchestratorCli: string | undefined;
      if (plan) {
        if (!plan.squad_id || !plan.roster_hash || !plan.roster_snapshot_json) {
          throw new Error(
            "plano legado sem roster selado; replaneje a missão antes do dispatch",
          );
        }
        if (!agentRef || !agentCategory || !rosterHash || !routeContract) {
          throw new Error(
            "dispatch de plano selado exige agente, categoria, rosterHash e rota exata",
          );
        }
        if (rosterHash !== plan.roster_hash) {
          throw new Error("dispatch rosterHash diverge do plano selado");
        }
        try {
          if (
            taskDispatchTokenHash(plan.planner_json) !== plan.plan_hash ||
            taskDispatchTokenHash(plan.roster_snapshot_json) !==
              plan.roster_hash
          ) {
            throw new Error(
              "hash do plano/roster selado diverge do conteúdo persistido",
            );
          }
          const envelope = sealedPlanDispatchSchema.parse(
            JSON.parse(plan.planner_json),
          );
          const roster = sealedRosterDispatchSchema.parse(
            JSON.parse(plan.roster_snapshot_json),
          );
          if (
            envelope.missionId !== missionId ||
            envelope.intentVersion !== intentVersion ||
            envelope.rosterHash !== plan.roster_hash
          ) {
            throw new Error("coordenadas do plano selado divergem do dispatch");
          }
          sealedEntry =
            envelope.tasks.find((entry) => entry.taskId === taskId) ?? null;
          if (!sealedEntry) {
            throw new Error(
              `task ${taskId} não pertence ao plano selado atual`,
            );
          }
          const agentMatches = roster.agents.filter(
            (candidate) => candidate.id === sealedEntry!.agentRef,
          );
          if (agentMatches.length !== 1) {
            throw new Error(
              "agente do plano não possui identidade canônica no roster",
            );
          }
          sealedAgent = agentMatches[0]!;
          sealedOrchestratorCli = roster.agents.find(
            (candidate) => candidate.category === "orchestrator",
          )?.cli;
        } catch (error) {
          if (error instanceof ScopedStoreCorruptionError) throw error;
          throw new ScopedStoreCorruptionError("sealed dispatch contract", {
            cause: error,
          });
        }
        if (
          sealedEntry.agentRef !== agentRef ||
          sealedEntry.agentCategory !== agentCategory ||
          sealedAgent.id !== agentRef ||
          sealedAgent.category !== agentCategory
        ) {
          throw new Error("dispatch agente/categoria diverge do plano selado");
        }
        if (workerId !== sealedAgent.agentName) {
          throw new Error("dispatch workerId diverge do agentName selado");
        }
        if (sealedAgent.cli === "claude") {
          // One Claude process per mission. Autopilot may use it as a writer
          // when the orchestrator is another CLI; Hardened keeps read_only.
          const operatorChoice = isOperatorChoicePolicy(
            getOrchSettings().squadCliPolicy,
          );
          if (
            sealedOrchestratorCli === "claude" ||
            (!operatorChoice && executionMode !== "read_only")
          ) {
            throw new Error("reserveClaude proíbe Claude OAuth como worker");
          }
        }
        if (routeContract.adapterId !== sealedAgent.cli) {
          throw new Error("dispatch provider diverge da CLI do roster selado");
        }
        if (
          executionMode === "read_only" &&
          !supportsMechanicallyReadOnlyCli(routeContract.adapterId) &&
          !supportsAdvisoryParticipationCli(routeContract.adapterId)
        ) {
          throw new Error(
            "dispatch read_only exige CLI mecanicamente confinada ou advisor MCP",
          );
        }
        if (
          executionMode === "isolated_worktree" &&
          !supportsMechanicallyWorkspaceWriteCli(
            routeContract.adapterId,
            isOperatorChoicePolicy(getOrchSettings().squadCliPolicy),
          )
        ) {
          throw new Error(
            "dispatch isolated_worktree exige CLI com sandbox de workspace confiável",
          );
        }
        if (
          sealedAgent.model &&
          !isRoutableModelResolution(
            sealedAgent.model,
            routeContract.model,
          )
        ) {
          throw new Error(
            "dispatch modelo diverge da família do roster selado",
          );
        }
        if (routeContract.effort !== sealedAgent.effort) {
          throw new Error("dispatch effort diverge do roster selado");
        }
      }
      const task = db
        .prepare(
          `SELECT mission_id, status, title, detail FROM tasks WHERE id = ?`,
        )
        .get(taskId) as
        | {
            mission_id: string | null;
            status: string;
            title: string;
            detail: string;
          }
        | undefined;
      if (!task || task.mission_id !== missionId) {
        throw new Error(`task ${taskId} não pertence à missão ${missionId}`);
      }
      if (sealedEntry) {
        if (
          task.title !== sealedEntry.title ||
          task.detail !== sealedEntry.detail
        ) {
          throw new Error("task row diverge do receipt selado");
        }
        const schedule = decodeTaskScheduleDetail(task.detail).meta;
        if (
          !schedule ||
          schedule.agentRef !== agentRef ||
          schedule.agentCategory !== agentCategory ||
          schedule.executionMode !== executionMode ||
          JSON.stringify(
            taskDispatchOwnershipSchema.parse(schedule.ownership),
          ) !== JSON.stringify(ownership)
        ) {
          throw new Error(
            "dispatch execução/ownership diverge do contrato selado",
          );
        }
      }
      const existing = getTaskDispatchRow(db, taskId);
      if (existing && existing.state !== "superseded") {
        throw new Error(
          `task ${taskId} já foi reservada por dispatch ativo (${existing.state})`,
        );
      }
      if (
        existing &&
        (existing.handoff_id !== null ||
          existing.handoff_accepted_at !== null ||
          existing.integration_receipt_json !== null ||
          existing.completed_at !== null)
      ) {
        throw new ScopedStoreCorruptionError(
          "superseded dispatch contains a completion receipt",
        );
      }
      if (existing && existing.lease_expires_at > now) {
        throw new Error(
          `capacity_wait: retry técnico de ${taskId} aguarda até ` +
            `${existing.lease_expires_at}`,
        );
      }
      const activeRows = db
        .prepare(
          `SELECT ownership_json FROM task_dispatch_queue
         WHERE mission_id = ? AND state IN (
           'claimed', 'routed', 'spawning', 'running', 'handoff_ready', 'merging'
         )`,
        )
        .all(missionId) as Array<{ ownership_json: string }>;
      if (maxWorkers !== undefined && activeRows.length >= maxWorkers) {
        throw new Error(
          `maxWorkers=${maxWorkers} já está reservado por dispatches duráveis`,
        );
      }
      for (const active of activeRows) {
        let activeOwnership: ScheduleOwnership;
        try {
          activeOwnership = taskDispatchOwnershipSchema.parse(
            JSON.parse(active.ownership_json),
          );
        } catch (error) {
          throw new ScopedStoreCorruptionError("task dispatch ownership", {
            cause: error,
          });
        }
        if (
          requiresExclusiveSlot(ownership) ||
          requiresExclusiveSlot(activeOwnership) ||
          ownershipsIntersect(ownership, activeOwnership)
        ) {
          throw new Error("ownership da task conflita com dispatch ativo");
        }
      }
      if (task.status !== "pending") {
        throw new Error(
          `task ${taskId} não está pending (status=${task.status})`,
        );
      }

      const taskUpdate = db
        .prepare(
          `UPDATE tasks SET status = 'running', updated_at = ?
         WHERE id = ? AND mission_id = ? AND status = 'pending'`,
        )
        .run(now, taskId, missionId);
      if (taskUpdate.changes !== 1) {
        throw new Error(`claim concorrente perdeu a task ${taskId}`);
      }
      const leaseTokenHash = taskDispatchTokenHash(leaseToken);
      const routeContractJson = routeContract
        ? JSON.stringify(routeContract)
        : null;
      if (existing) {
        const retried = db
          .prepare(
            `UPDATE task_dispatch_queue
                SET id = ?, mission_id = ?, intent_version = ?,
                    revision = revision + 1, attempt = attempt + 1,
                    state = 'claimed', lease_token_hash = ?, lease_owner = ?,
                    lease_expires_at = ?, route_reservation_id = NULL,
                    adapter_id = NULL, model = NULL, effort = NULL,
                    worker_id = ?, worker_incarnation_id = ?,
                    ownership_json = ?, execution_mode = ?,
                    agent_ref = ?, agent_category = ?, roster_hash = ?,
                    route_contract_json = ?, pane_id = NULL, session_id = NULL,
                    handoff_id = NULL, handoff_accepted_at = NULL,
                    integration_receipt_json = NULL, completed_at = NULL,
                    last_heartbeat_at = NULL, last_error = NULL, updated_at = ?
              WHERE task_id = ? AND state = 'superseded'
                AND handoff_id IS NULL AND handoff_accepted_at IS NULL
                AND integration_receipt_json IS NULL AND completed_at IS NULL`,
          )
          .run(
            dispatchId,
            missionId,
            intentVersion,
            leaseTokenHash,
            leaseOwner,
            now + leaseMs,
            workerId,
            workerIncarnationId,
            JSON.stringify(ownership),
            executionMode,
            agentRef ?? null,
            agentCategory ?? null,
            rosterHash ?? null,
            routeContractJson,
            now,
            taskId,
          );
        if (retried.changes !== 1) {
          throw new Error(`retry concorrente perdeu a task ${taskId}`);
        }
      } else {
        db.prepare(
          `INSERT INTO task_dispatch_queue (
             id, task_id, mission_id, intent_version, revision, attempt, state,
             lease_token_hash, lease_owner, lease_expires_at, worker_id,
             worker_incarnation_id,
             ownership_json, execution_mode, agent_ref, agent_category,
             roster_hash, route_contract_json,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, 1, 'claimed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          dispatchId,
          taskId,
          missionId,
          intentVersion,
          leaseTokenHash,
          leaseOwner,
          now + leaseMs,
          workerId,
          workerIncarnationId,
          JSON.stringify(ownership),
          executionMode,
          agentRef ?? null,
          agentCategory ?? null,
          rosterHash ?? null,
          routeContractJson,
          now,
          now,
        );
      }
      return getTaskDispatchFromDatabase(db, taskId, binding.coordinates);
    })
    .immediate();

  if (!record) throw new Error(`dispatch ${dispatchId} não persistido`);
  binding.emitChange();
  if (record.workerIncarnationId !== workerIncarnationId) {
    throw new ScopedStoreCorruptionError("worker incarnation claim");
  }
  return { ...record, leaseToken, workerIncarnationId };
}
