import { z } from "zod";
import { squadAgentSchema } from "../../shared/orch-types";
import {
  ownershipsIntersect,
  requiresExclusiveSlot,
  type ScheduleOwnership,
} from "./mission-scheduler";
import {
  assertConcurrentIsolatedWorktreeDisjoint,
  hasWavePackDisjointFilesDomain,
} from "../../shared/mission-wave-pack";
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
  taskProviderRerouteDirectiveSchema,
  type ClaimedTaskDispatch,
  type TaskDispatchRouteContract,
  type TaskDispatchWorkerCategory,
  type TaskProviderRerouteDirective,
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
      const existing = getTaskDispatchRow(db, taskId);
      // A diretiva durável de reroute só vale para a MESMA intentVersion e só
      // sobre a retomada de um dispatch superseded pelo coordenador. Uma
      // geração nova do plano volta ao agente selado original.
      let reroute: TaskProviderRerouteDirective | null = null;
      if (
        existing?.provider_reroute_json &&
        existing.intent_version === intentVersion
      ) {
        try {
          reroute = taskProviderRerouteDirectiveSchema.parse(
            JSON.parse(existing.provider_reroute_json),
          );
        } catch (error) {
          throw new ScopedStoreCorruptionError("task provider reroute", {
            cause: error,
          });
        }
      }
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
          // Sob diretiva de reroute, a identidade vinculada é o agente
          // ALTERNATIVO — que precisa ter identidade canônica no MESMO
          // roster selado. Sem diretiva, é o agente selado da entry.
          const boundAgentRef = reroute
            ? reroute.toAgentRef
            : sealedEntry.agentRef;
          const agentMatches = roster.agents.filter(
            (candidate) => candidate.id === boundAgentRef,
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
        if (reroute) {
          if (agentRef !== reroute.toAgentRef) {
            throw new Error(
              "dispatch re-roteado exige exatamente o agente alternativo da diretiva durável",
            );
          }
          if (sealedEntry.agentRef !== reroute.fromAgentRef) {
            throw new Error(
              "diretiva de reroute divergiu do agentRef selado do plano",
            );
          }
        } else if (sealedEntry.agentRef !== agentRef) {
          throw new Error("dispatch agente/categoria diverge do plano selado");
        }
        if (
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
        // O detail selado sempre carrega o agentRef ORIGINAL do plano; um
        // reroute nunca reescreve o receipt, só a vinculação do dispatch.
        if (
          !schedule ||
          schedule.agentRef !== sealedEntry.agentRef ||
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
          `SELECT task_id, ownership_json, execution_mode FROM task_dispatch_queue
         WHERE mission_id = ? AND state IN (
           'claimed', 'routed', 'spawning', 'running', 'handoff_ready', 'merging'
         )`,
        )
        .all(missionId) as Array<{
          task_id: string;
          ownership_json: string;
          execution_mode: string;
        }>;
      if (maxWorkers !== undefined && activeRows.length >= maxWorkers) {
        throw new Error(
          `maxWorkers=${maxWorkers} já está reservado por dispatches duráveis`,
        );
      }
      const activeParsed = activeRows.map((active) => {
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
        return {
          taskId: active.task_id,
          executionMode: active.execution_mode,
          ownership: activeOwnership,
        };
      });
      // P0-3 seam B: durable file-disjointness backstop for the real fan-out.
      // A claim that carries the disjoint-files marker must not share a file
      // with any already-active isolated_worktree writer that also carries the
      // marker — proved at the dispatch ledger before a second worktree is
      // physically reserved, independent of the domain heuristic below.
      // Shared-inventory wave-pack writers (files = merge permit, no marker)
      // overlap by design and are deliberately excluded from this guard.
      if (
        executionMode === "isolated_worktree" &&
        hasWavePackDisjointFilesDomain(ownership.domains)
      ) {
        assertConcurrentIsolatedWorktreeDisjoint([
          { taskId, executionMode, ownership: { files: ownership.files } },
          ...activeParsed
            .filter(
              (active) =>
                active.executionMode === "isolated_worktree" &&
                hasWavePackDisjointFilesDomain(active.ownership.domains),
            )
            .map((active) => ({
              taskId: active.taskId,
              executionMode: active.executionMode,
              ownership: { files: active.ownership.files },
            })),
        ]);
      }
      for (const active of activeParsed) {
        // Match selectDisjointWave: exclusive quality-gate / sequential-only
        // tasks must not be fenced by parallel-eligible advisors still active
        // (guided-advisory scouts, etc.). Block only when an exclusive peer is
        // already active or expanded ownership actually intersects — otherwise
        // a stuck Grok scout permanently blocks QA claim after reviewer merge
        // (release E2E: "ownership da task conflita com dispatch ativo").
        // Do NOT treat `requiresExclusiveSlot(claim)` alone as conflict with
        // every active row.
        if (
          requiresExclusiveSlot(active.ownership) ||
          ownershipsIntersect(ownership, active.ownership)
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
      // A diretiva honrada permanece na linha claimada (auditoria + base para
      // estender a cadeia se a CLI alternativa também morrer). Uma diretiva de
      // geração anterior — ou sem plano selado que a valide — nunca sobrevive
      // ao claim.
      const rerouteJson = plan && reroute ? JSON.stringify(reroute) : null;
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
                    route_contract_json = ?, provider_reroute_json = ?,
                    pane_id = NULL, session_id = NULL,
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
            rerouteJson,
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
