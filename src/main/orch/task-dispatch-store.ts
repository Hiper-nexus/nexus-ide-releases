import { z } from "zod";
import type { ProjectExecutionScope } from "../../shared/types";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from "./scoped-store";
import {
  taskDispatchIdSchema as idSchema,
  taskDispatchRouteContractSchema as routeContractSchema,
  sealedPlanDispatchSchema,
  taskDispatchRowSchema as rowSchema,
  taskDispatchTokenHash as tokenHash,
  taskIntegrationReceiptSchema,
  taskDispatchRecordFromRow,
  type ClaimedTaskDispatch,
  type TaskDispatchFencedMutation as FencedMutation,
  type TaskDispatchRecord,
  type TaskDispatchState,
  type TaskIntegrationReceipt,
} from "./task-dispatch-codec";
import {
  claimTaskDispatch,
  type TaskDispatchClaimInput,
} from "./task-dispatch-claim-authority";
import {
  acceptTaskDispatchHandoff,
  assertTaskDispatchMissionLifecycleAuthority,
  blockTaskDispatchFromHandoff,
  type AcceptTaskDispatchHandoffInput,
  type BlockTaskDispatchFromHandoffInput,
} from "./task-dispatch-handoff-authority";
import {
  blockTaskDispatchMission,
  getTaskDispatchFromDatabase,
  getTaskDispatchRow,
} from "./task-dispatch-persistence";
import {
  completeMissionFromVerifiedTaskPlan,
  type CompleteMissionFromVerifiedPlanInput,
} from "./task-dispatch-mission-completion-authority";

export { taskIntegrationReceiptSchema };
export type {
  ClaimedTaskDispatch,
  TaskDispatchRecord,
  TaskDispatchState,
  TaskIntegrationReceipt,
};

export class TaskDispatchStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  claim(input: TaskDispatchClaimInput): ClaimedTaskDispatch {
    return claimTaskDispatch(this.#binding, input);
  }
  attachRoute(
    input: FencedMutation & {
      readonly routeReservationId: string;
      readonly adapterId: string;
      readonly model?: string;
      readonly effort?: string;
    },
  ): TaskDispatchRecord {
    const current = this.get(input.taskId);
    if (current?.routeContract) {
      const actual = routeContractSchema.parse({
        adapterId: input.adapterId,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
      });
      if (
        actual.adapterId !== current.routeContract.adapterId ||
        actual.model !== current.routeContract.model ||
        actual.effort !== current.routeContract.effort
      ) {
        throw new Error(
          "route contract diverge do agente/roster selado; nenhum provider substituto foi aceito",
        );
      }
    }
    return this.#fencedTransition(input, ["claimed"], "routed", {
      route_reservation_id: idSchema.parse(input.routeReservationId),
      adapter_id: idSchema.parse(input.adapterId),
      model: input.model ?? null,
      effort: input.effort ?? null,
    });
  }

  markSpawning(input: FencedMutation): TaskDispatchRecord {
    return this.#fencedTransition(input, ["routed"], "spawning");
  }

  bindSpawn(
    input: FencedMutation & {
      readonly paneId: string;
      readonly sessionId: string;
      readonly workerIncarnationId: string;
    },
  ): TaskDispatchRecord {
    this.#assertWorkerIncarnation(
      this.#getRequiredCurrent(input.taskId),
      input.workerIncarnationId,
    );
    return this.#fencedTransition(input, ["routed", "spawning"], "running", {
      pane_id: idSchema.parse(input.paneId),
      session_id: idSchema.parse(input.sessionId),
      last_heartbeat_at: this.#binding.now(),
    });
  }

  acceptHandoff(input: AcceptTaskDispatchHandoffInput): TaskDispatchRecord {
    return acceptTaskDispatchHandoff(this.#binding, input);
  }

  blockFromHandoff(
    input: BlockTaskDispatchFromHandoffInput,
  ): TaskDispatchRecord {
    return blockTaskDispatchFromHandoff(this.#binding, input);
  }

  /**
   * Synchronous main-owned fence for an external effect that is about to run.
   * Receipt mutations repeat the same check transactionally.
   */
  assertLifecycleAuthority(input: {
    readonly taskId: string;
    readonly missionId?: string;
    readonly intentVersion?: number;
    readonly expectedStates?: readonly TaskDispatchState[];
  }): TaskDispatchRecord {
    const taskId = idSchema.parse(input.taskId);
    const db = this.#binding.readDatabase();
    const current = this.#getRow(db, taskId);
    if (!current) throw new Error(`dispatch não encontrado: ${taskId}`);
    if (input.missionId && current.mission_id !== idSchema.parse(input.missionId)) {
      throw new Error("dispatch pertence a outra missão");
    }
    if (
      input.intentVersion !== undefined &&
      current.intent_version !==
        z.number().int().nonnegative().parse(input.intentVersion)
    ) {
      throw new Error("dispatch pertence a outra intentVersion");
    }
    if (
      input.expectedStates &&
      !input.expectedStates.includes(current.state)
    ) {
      throw new Error(
        `dispatch sem autoridade de efeito no estado ${current.state}`,
      );
    }
    this.#assertCurrentIntent(db, current);
    return this.#fromRow(current);
  }

  /** Persist the main-owned merge intent before the external Git effect. */
  beginMerge(input: {
    readonly taskId: string;
    readonly revision: number;
  }): TaskDispatchRecord {
    const taskId = idSchema.parse(input.taskId);
    const revision = z.number().int().positive().parse(input.revision);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const record = db
      .transaction(() => {
        const current = this.#getRow(db, taskId);
        if (!current) throw new Error(`dispatch não encontrado: ${taskId}`);
        this.#assertCurrentIntent(db, current);
        const result = db
          .prepare(
            `UPDATE task_dispatch_queue
         SET state = 'merging', revision = revision + 1, updated_at = ?
         WHERE task_id = ? AND revision = ?
           AND handoff_id IS NOT NULL AND state = 'handoff_ready'`,
          )
          .run(now, taskId, revision);
        if (result.changes !== 1) {
          throw new Error("beginMerge perdeu CAS ou não tinha handoff aceito");
        }
        return this.#getFromDatabase(db, taskId);
      })
      .immediate();
    if (!record) throw new Error("dispatch desapareceu após beginMerge");
    this.#binding.emitChange();
    return record;
  }

  /** Main-only completion after the durable merge/finalizer succeeded. */
  completeByCoordinator(input: {
    readonly taskId: string;
    readonly revision: number;
    readonly receipt: TaskIntegrationReceipt;
  }): TaskDispatchRecord {
    const taskId = idSchema.parse(input.taskId);
    const revision = z.number().int().positive().parse(input.revision);
    const receipt = taskIntegrationReceiptSchema.parse(input.receipt);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const record = db
      .transaction(() => {
        const current = this.#getRow(db, taskId);
        if (!current || !["handoff_ready", "merging"].includes(current.state)) {
          throw new Error(
            "coordinator complete exige handoff aceito e merge/validação",
          );
        }
        this.#assertCurrentIntent(db, current);
        if (!current.handoff_id || current.revision !== revision) {
          throw new Error(
            "coordinator complete perdeu CAS ou não tinha handoff",
          );
        }
        if (current.execution_mode !== "isolated_worktree") {
          throw new Error(
            "receipt externo/sintético é proibido para same_checkout/read_only",
          );
        }
        if (receipt.kind !== "worktree_integrated") {
          throw new Error(
            `receipt ${receipt.kind} inválido para isolated_worktree; esperado worktree_integrated`,
          );
        }
        const result = db
          .prepare(
            `UPDATE task_dispatch_queue
         SET state = 'completed', revision = revision + 1,
             integration_receipt_json = ?, completed_at = ?, updated_at = ?
         WHERE task_id = ? AND revision = ?
           AND handoff_id IS NOT NULL AND state IN ('handoff_ready', 'merging')`,
          )
          .run(
            JSON.stringify(receipt),
            receipt.completedAt,
            now,
            taskId,
            revision,
          );
        if (result.changes !== 1) {
          throw new Error(
            "coordinator complete perdeu CAS ou não tinha handoff/merge",
          );
        }
        const taskUpdate = db
          .prepare(
            `UPDATE tasks SET status = 'done', updated_at = ?
         WHERE id = ? AND status = 'running'`,
          )
          .run(now, taskId);
        if (taskUpdate.changes !== 1) {
          throw new Error("task não estava running na conclusão integrada");
        }
        return this.#getFromDatabase(db, taskId);
      })
      .immediate();
    if (!record)
      throw new Error("dispatch desapareceu após coordinator complete");
    this.#binding.emitChange();
    return record;
  }

  /**
   * Read-only completion is derived inside the store from a current trusted
   * handoff. Callers cannot mint a `read_only_validated` receipt themselves.
   */
  completeReadOnlyFromTrustedHandoff(input: {
    readonly taskId: string;
    readonly revision: number;
  }): TaskDispatchRecord {
    const taskId = idSchema.parse(input.taskId);
    const revision = z.number().int().positive().parse(input.revision);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const record = db
      .transaction(() => {
        const current = this.#getRow(db, taskId);
        if (
          !current ||
          current.execution_mode !== "read_only" ||
          current.state !== "handoff_ready" ||
          current.revision !== revision ||
          !current.handoff_id ||
          !current.session_id
        ) {
          throw new Error("read-only complete exige handoff_ready exato");
        }
        this.#assertCurrentIntent(db, current);
        const evidence = db
          .prepare(
            `SELECT h.id, h.evidence_ids_json, h.context_revision,
                h.contract_hash, h.workflow_revision
         FROM handoffs AS h
         JOIN mission_contracts AS c ON c.mission_id = h.mission_id
         JOIN workflow_states AS w ON w.mission_id = h.mission_id
         WHERE h.id = ? AND h.mission_id = ? AND h.session_id = ?
           AND h.worker_incarnation_id = ?
           AND h.status = 'success' AND h.evidence_trusted = 1
           AND h.context_revision = c.context_revision
           AND h.contract_hash = c.contract_hash
           AND h.workflow_revision = w.revision`,
          )
          .get(
            current.handoff_id,
            current.mission_id,
            current.session_id,
            current.worker_incarnation_id,
          ) as
          | {
              id: string;
              evidence_ids_json: string;
              context_revision: string;
              contract_hash: string;
              workflow_revision: number;
            }
          | undefined;
        if (!evidence) {
          throw new Error(
            "read-only handoff não possui evidência Nexus confiável e atual",
          );
        }
        let evidenceIds: string[];
        try {
          evidenceIds = z
            .array(idSchema)
            .min(1)
            .max(256)
            .parse(JSON.parse(evidence.evidence_ids_json));
        } catch (error) {
          throw new ScopedStoreCorruptionError("read-only handoff evidence", {
            cause: error,
          });
        }
        const reference = tokenHash(
          JSON.stringify({
            missionId: current.mission_id,
            taskId: current.task_id,
            handoffId: evidence.id,
            contextRevision: evidence.context_revision,
            contractHash: evidence.contract_hash,
            workflowRevision: evidence.workflow_revision,
            evidenceIds: [...evidenceIds].sort(),
          }),
        );
        const receipt: TaskIntegrationReceipt = {
          kind: "read_only_validated",
          reference,
          completedAt: now,
          evidenceIds,
        };
        const updated = db
          .prepare(
            `UPDATE task_dispatch_queue
         SET state = 'completed', revision = revision + 1,
             integration_receipt_json = ?, completed_at = ?, updated_at = ?
         WHERE task_id = ? AND revision = ? AND state = 'handoff_ready'
           AND execution_mode = 'read_only'`,
          )
          .run(JSON.stringify(receipt), now, now, taskId, revision);
        if (updated.changes !== 1)
          throw new Error("read-only complete perdeu CAS");
        const taskUpdate = db
          .prepare(
            `UPDATE tasks SET status = 'done', updated_at = ?
         WHERE id = ? AND status = 'running'`,
          )
          .run(now, taskId);
        if (taskUpdate.changes !== 1) {
          throw new Error("read-only task não estava running");
        }
        return this.#getFromDatabase(db, taskId);
      })
      .immediate();
    if (!record)
      throw new Error("dispatch desapareceu após read-only complete");
    this.#binding.emitChange();
    return record;
  }

  /**
   * Finish a standard mission only from the complete durable chain: sealed plan
   * -> exact dispatch -> accepted handoff delivery -> coordinator integration
   * receipt. Once the PREVC driver has taken ownership (any mission_step_receipt
   * row — receipts only exist under a frozen workflow) the mission is left to
   * the driver and never completed here. A contract frozen ONLY so merge
   * validation can run (additive PREVC: every integrated candidate already
   * passed sensors + independent review under that contract) does NOT block
   * completion — blocking it wedged fully-integrated missions permanently
   * running/blocked (release gate + field audit 17/07).
   */
  completeMissionFromVerifiedPlan(
    input: CompleteMissionFromVerifiedPlanInput,
  ): boolean {
    return completeMissionFromVerifiedTaskPlan(this.#binding, input);
  }

  /**
   * A worktree reservation persisted before materialization is an uncertain
   * main-owned effect, not a worker failure. Only the exact pre-spawn claim may
   * be blocked here; no lease token or automatic respawn can override it.
   */
  blockWorktreeCreationFailureByCoordinator(input: {
    readonly taskId: string;
    readonly revision: number;
    readonly reason: string;
  }): TaskDispatchRecord {
    const taskId = idSchema.parse(input.taskId);
    const revision = z.number().int().positive().parse(input.revision);
    const reason = input.reason.trim().slice(0, 65_536);
    if (!reason) {
      throw new Error(
        "motivo da falha de criação do worktree é obrigatório",
      );
    }
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const record = db
      .transaction(() => {
        const current = this.#getRow(db, taskId);
        if (!current) throw new Error(`dispatch não encontrado: ${taskId}`);
        if (current.state === "blocked") {
          return this.#getFromDatabase(db, taskId);
        }
        if (current.integration_receipt_json || current.state === "completed") {
          throw new Error(
            "falha de criação do worktree não pode apagar receipt concluído",
          );
        }
        this.#assertCurrentIntent(db, current);
        if (current.state !== "claimed" || current.revision !== revision) {
          throw new Error(
            "block worktree creation perdeu CAS ou dispatch saiu do pre-spawn",
          );
        }
        const updated = db
          .prepare(
            `UPDATE task_dispatch_queue
             SET state = 'blocked', last_error = ?, revision = revision + 1,
                 updated_at = ?
             WHERE task_id = ? AND revision = ?
               AND integration_receipt_json IS NULL
               AND state = 'claimed'`,
          )
          .run(reason, now, taskId, revision);
        if (updated.changes !== 1) {
          throw new Error("block worktree creation perdeu CAS");
        }
        db.prepare(
          `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`,
        ).run(now, taskId);
        this.#blockMission(db, current.mission_id, reason, now);
        return this.#getFromDatabase(db, taskId);
      })
      .immediate();
    if (!record) {
      throw new Error(
        "dispatch desapareceu após block worktree creation failure",
      );
    }
    this.#binding.emitChange();
    return record;
  }

  /**
   * Projects a terminal main-owned merge failure back into the durable mission
   * lifecycle. This is intentionally distinct from worker failure: the handoff
   * remains accepted, no integration receipt is minted or erased, and the exact
   * dispatch revision fences runtime and restart reconciliation.
   */
  blockMergeFailureByCoordinator(input: {
    readonly taskId: string;
    readonly revision: number;
    readonly reason: string;
  }): TaskDispatchRecord {
    const taskId = idSchema.parse(input.taskId);
    const revision = z.number().int().positive().parse(input.revision);
    const reason = input.reason.trim().slice(0, 65_536);
    if (!reason) throw new Error("motivo da falha terminal de merge é obrigatório");
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const record = db
      .transaction(() => {
        const current = this.#getRow(db, taskId);
        if (!current) throw new Error(`dispatch não encontrado: ${taskId}`);
        if (current.state === "blocked") {
          return this.#getFromDatabase(db, taskId);
        }
        if (current.integration_receipt_json || current.state === "completed") {
          throw new Error(
            "falha de merge não pode apagar um receipt de integração concluído",
          );
        }
        this.#assertCurrentIntent(db, current);
        if (
          !["handoff_ready", "merging"].includes(current.state) ||
          current.revision !== revision
        ) {
          throw new Error(
            "block merge failure perdeu CAS ou dispatch não está em merge",
          );
        }
        const updated = db
          .prepare(
            `UPDATE task_dispatch_queue
         SET state = 'blocked', last_error = ?, revision = revision + 1,
             updated_at = ?
         WHERE task_id = ? AND revision = ?
           AND integration_receipt_json IS NULL
           AND state IN ('handoff_ready', 'merging')`,
          )
          .run(reason, now, taskId, revision);
        if (updated.changes !== 1) {
          throw new Error("block merge failure perdeu CAS");
        }
        db.prepare(
          `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`,
        ).run(now, taskId);
        this.#blockMission(db, current.mission_id, reason, now);
        return this.#getFromDatabase(db, taskId);
      })
      .immediate();
    if (!record) {
      throw new Error("dispatch desapareceu após block merge failure");
    }
    this.#binding.emitChange();
    return record;
  }

  /** Legacy same-checkout has no attributable diff/baseline: fail closed. */
  blockUnvalidatedByCoordinator(input: {
    readonly taskId: string;
    readonly revision: number;
    readonly reason: string;
  }): TaskDispatchRecord {
    const taskId = idSchema.parse(input.taskId);
    const revision = z.number().int().positive().parse(input.revision);
    const reason = input.reason.trim().slice(0, 65_536);
    if (!reason) throw new Error("motivo do bloqueio é obrigatório");
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const record = db
      .transaction(() => {
        const current = this.#getRow(db, taskId);
        if (!current || current.state !== "handoff_ready") {
          throw new Error("block unvalidated exige handoff_ready");
        }
        this.#assertCurrentIntent(db, current);
        const updated = db
          .prepare(
            `UPDATE task_dispatch_queue
         SET state = 'blocked', last_error = ?, revision = revision + 1,
             updated_at = ?
         WHERE task_id = ? AND revision = ? AND state = 'handoff_ready'`,
          )
          .run(reason, now, taskId, revision);
        if (updated.changes !== 1)
          throw new Error("block unvalidated perdeu CAS");
        db.prepare(
          `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`,
        ).run(now, taskId);
        this.#blockMission(db, current.mission_id, reason, now);
        return this.#getFromDatabase(db, taskId);
      })
      .immediate();
    if (!record) throw new Error("dispatch desapareceu após block unvalidated");
    this.#binding.emitChange();
    return record;
  }

  /**
   * A sealed task can fail before a dispatch row exists (for example its exact
   * roster CLI is unavailable). Persist that as one honest mission block; do
   * not leave the scheduler retrying or mutate the immutable task receipt.
   */
  blockBeforeClaim(input: {
    readonly missionId: string;
    readonly taskId: string;
    readonly intentVersion: number;
    readonly reason: string;
  }): boolean {
    const missionId = idSchema.parse(input.missionId);
    const taskId = idSchema.parse(input.taskId);
    const intentVersion = z
      .number()
      .int()
      .nonnegative()
      .parse(input.intentVersion);
    const reason = input.reason.trim().slice(0, 65_536);
    if (!reason)
      throw new Error("motivo do bloqueio pré-dispatch é obrigatório");
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const changed = db
      .transaction(() => {
        const mission = db
          .prepare(`SELECT status, intent_version FROM missions WHERE id = ?`)
          .get(missionId) as
          | {
              status: string;
              intent_version: number;
            }
          | undefined;
        if (!mission) throw new Error(`missão não encontrada: ${missionId}`);
        if (mission.intent_version !== intentVersion) {
          throw new Error("blockBeforeClaim rejeitou intentVersion obsoleta");
        }
        const rawPlan = db
          .prepare(
            `SELECT planner_json FROM mission_task_plans
         WHERE mission_id = ? AND intent_version = ?`,
          )
          .get(missionId, intentVersion) as
          { planner_json: string } | undefined;
        if (!rawPlan)
          throw new Error("blockBeforeClaim exige plano selado atual");
        let planTaskIds: z.infer<typeof sealedPlanDispatchSchema>;
        try {
          planTaskIds = sealedPlanDispatchSchema.parse(
            JSON.parse(rawPlan.planner_json),
          );
        } catch (error) {
          throw new ScopedStoreCorruptionError("sealed task plan membership", {
            cause: error,
          });
        }
        if (!planTaskIds.tasks.some((entry) => entry.taskId === taskId)) {
          throw new Error(`task ${taskId} não pertence ao plano selado atual`);
        }
        const existingDispatch = db
          .prepare(
            `SELECT 1 AS present FROM task_dispatch_queue WHERE task_id = ?`,
          )
          .get(taskId);
        if (existingDispatch !== undefined) return false;
        const task = db
          .prepare(`SELECT mission_id, status FROM tasks WHERE id = ?`)
          .get(taskId) as
          { mission_id: string | null; status: string } | undefined;
        if (!task || task.mission_id !== missionId) {
          throw new Error(`task ${taskId} não pertence à missão ${missionId}`);
        }
        if (task.status === "failed" && mission.status === "blocked")
          return false;
        assertTaskDispatchMissionLifecycleAuthority(
          db,
          missionId,
          intentVersion,
        );
        if (task.status !== "pending") {
          throw new Error(
            `task ${taskId} não pode bloquear antes do claim (${task.status})`,
          );
        }
        const updated = db
          .prepare(
            `UPDATE tasks SET status = 'failed', updated_at = ?
         WHERE id = ? AND mission_id = ? AND status = 'pending'`,
          )
          .run(now, taskId, missionId);
        if (updated.changes !== 1)
          throw new Error("blockBeforeClaim perdeu CAS da task");
        this.#blockMission(db, missionId, reason, now);
        return true;
      })
      .immediate();
    if (changed) this.#binding.emitChange();
    return changed;
  }

  /** A bound live PTY is the only authority allowed to revive/renew a lease. */
  heartbeat(input: {
    readonly sessionId: string;
    readonly missionId: string;
    readonly workerIncarnationId: string;
    readonly dispatchId?: string;
    readonly leaseMs: number;
  }): TaskDispatchRecord {
    const sessionId = idSchema.parse(input.sessionId);
    const missionId = idSchema.parse(input.missionId);
    const workerIncarnationId = idSchema.parse(input.workerIncarnationId);
    const dispatchId =
      input.dispatchId === undefined
        ? undefined
        : idSchema.parse(input.dispatchId);
    const leaseMs = z
      .number()
      .int()
      .positive()
      .max(60 * 60_000)
      .parse(input.leaseMs);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const dispatchClause = dispatchId ? " AND id = ?" : "";
    const record = db
      .transaction(() => {
        const row = db
          .prepare(
            `SELECT task_id FROM task_dispatch_queue
             WHERE session_id = ? AND mission_id = ?
               AND worker_incarnation_id = ? AND state = 'running'${dispatchClause}`,
          )
          .get(
            sessionId,
            missionId,
            workerIncarnationId,
            ...(dispatchId ? [dispatchId] : []),
          ) as { task_id: string } | undefined;
        if (!row) {
          throw new Error(`nenhum dispatch running para a sessão ${sessionId}`);
        }
        const current = this.#getRow(db, row.task_id);
        if (!current) {
          throw new Error(`dispatch desapareceu para a sessão ${sessionId}`);
        }
        this.#assertCurrentIntent(db, current);
        const result = db
          .prepare(
            `UPDATE task_dispatch_queue
             SET last_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
             WHERE task_id = ? AND revision = ? AND state = 'running'`,
          )
          .run(
            now,
            now + leaseMs,
            now,
            current.task_id,
            current.revision,
          );
        if (result.changes !== 1) {
          throw new Error(`nenhum dispatch running para a sessão ${sessionId}`);
        }
        return this.#getFromDatabase(db, current.task_id);
      })
      .immediate();
    if (!record) throw new Error("dispatch desapareceu após heartbeat");
    this.#binding.emitChange();
    return record;
  }

  /**
   * Restart/lease recovery for an uncertain external effect. Never returns the
   * task to pending: a spawn that may have happened is blocked, not duplicated.
   */
  blockExpired(input: {
    readonly taskId: string;
    readonly revision: number;
    readonly reason: string;
  }): TaskDispatchRecord {
    const taskId = idSchema.parse(input.taskId);
    const revision = z.number().int().positive().parse(input.revision);
    const reason = input.reason.trim().slice(0, 65_536);
    if (!reason)
      throw new Error("motivo do bloqueio de dispatch é obrigatório");
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const record = db
      .transaction(() => {
        const current = this.#getRow(db, taskId);
        if (!current) throw new Error(`dispatch não encontrado: ${taskId}`);
        if (current.state === "blocked")
          return this.#getFromDatabase(db, taskId);
        this.#assertCurrentIntent(db, current);
        if (
          !["claimed", "routed", "spawning", "running"].includes(
            current.state,
          ) ||
          current.revision !== revision
        ) {
          throw new Error(
            "blockExpired perdeu CAS ou dispatch não está recuperável",
          );
        }
        if (current.lease_expires_at >= now) {
          throw new Error("dispatch ainda possui lease válida");
        }
        const updated = db
          .prepare(
            `UPDATE task_dispatch_queue
         SET state = 'blocked', last_error = ?, revision = revision + 1,
             updated_at = ?
         WHERE task_id = ? AND revision = ?
           AND state IN ('claimed', 'routed', 'spawning', 'running')
           AND lease_expires_at < ?`,
          )
          .run(reason, now, taskId, revision, now);
        if (updated.changes !== 1) throw new Error("blockExpired perdeu CAS");
        db.prepare(
          `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`,
        ).run(now, taskId);
        this.#blockMission(db, current.mission_id, reason, now);
        return this.#getFromDatabase(db, taskId);
      })
      .immediate();
    if (!record) throw new Error("dispatch desapareceu após blockExpired");
    this.#binding.emitChange();
    return record;
  }

  /** Exact PTY exit before a handoff is terminally uncertain and blocks. */
  blockSessionExit(input: {
    readonly sessionId: string;
    readonly workerIncarnationId: string;
    readonly reason: string;
  }): TaskDispatchRecord | null {
    const sessionId = idSchema.parse(input.sessionId);
    const workerIncarnationId = idSchema.parse(input.workerIncarnationId);
    const reason = input.reason.trim().slice(0, 65_536);
    if (!reason) throw new Error("motivo do encerramento é obrigatório");
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const record = db
      .transaction(() => {
        const current = db
          .prepare(
            `SELECT dispatch.task_id, dispatch.mission_id, dispatch.revision
         FROM task_dispatch_queue AS dispatch
         JOIN missions AS mission ON mission.id = dispatch.mission_id
         WHERE dispatch.session_id = ?
           AND dispatch.worker_incarnation_id = ?
           AND dispatch.state = 'running'
           AND dispatch.intent_version = mission.intent_version`,
          )
          .get(sessionId, workerIncarnationId) as
          | {
              task_id: string;
              mission_id: string;
              revision: number;
            }
          | undefined;
        if (!current) return null;
        const dispatch = this.#getRow(db, current.task_id);
        if (!dispatch) return null;
        this.#assertCurrentIntent(db, dispatch);
        const updated = db
          .prepare(
            `UPDATE task_dispatch_queue
         SET state = 'blocked', last_error = ?, revision = revision + 1,
             updated_at = ?
         WHERE task_id = ? AND revision = ? AND session_id = ?
           AND worker_incarnation_id = ? AND state = 'running'`,
          )
          .run(
            reason,
            now,
            current.task_id,
            current.revision,
            sessionId,
            workerIncarnationId,
          );
        if (updated.changes !== 1)
          throw new Error("session exit perdeu CAS do dispatch");
        db.prepare(
          `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`,
        ).run(now, current.task_id);
        this.#blockMission(db, current.mission_id, reason, now);
        return this.#getFromDatabase(db, current.task_id);
      })
      .immediate();
    if (record) this.#binding.emitChange();
    return record;
  }

  fail(input: FencedMutation & { readonly error: string }): TaskDispatchRecord {
    const message = input.error.slice(0, 65_536);
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    const hash = tokenHash(input.leaseToken);
    const record = db
      .transaction(() => {
        const current = this.#getRow(db, input.taskId);
        if (!current)
          throw new Error(`dispatch não encontrado: ${input.taskId}`);
        this.#assertFence(db, current, input.revision, hash);
        // A pane/session attached makes the effect uncertain: never put the task
        // back in pending and risk a duplicate worker. Surface blocked instead.
        const nextState: TaskDispatchState = current.session_id
          ? "blocked"
          : "failed";
        const update = db
          .prepare(
            `UPDATE task_dispatch_queue
         SET state = ?, last_error = ?, revision = revision + 1, updated_at = ?
         WHERE task_id = ? AND revision = ? AND lease_token_hash = ?`,
          )
          .run(nextState, message, now, input.taskId, input.revision, hash);
        if (update.changes !== 1)
          throw new Error("fail perdeu CAS do dispatch");
        db.prepare(
          `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`,
        ).run(now, input.taskId);
        this.#blockMission(db, current.mission_id, message, now);
        return this.#getFromDatabase(db, input.taskId);
      })
      .immediate();
    if (!record) throw new Error("dispatch desapareceu após fail");
    this.#binding.emitChange();
    return record;
  }

  get(rawTaskId: string): TaskDispatchRecord | null {
    return this.#getFromDatabase(
      this.#binding.readDatabase(),
      idSchema.parse(rawTaskId),
    );
  }

  list(rawMissionId?: string): TaskDispatchRecord[] {
    const db = this.#binding.readDatabase();
    const rows = rawMissionId
      ? db
          .prepare(
            `SELECT * FROM task_dispatch_queue WHERE mission_id = ?
           ORDER BY created_at ASC, id ASC`,
          )
          .all(idSchema.parse(rawMissionId))
      : db
          .prepare(
            `SELECT * FROM task_dispatch_queue ORDER BY created_at ASC, id ASC`,
          )
          .all();
    return rows.map((row) => this.#fromRow(row));
  }

  #fencedTransition(
    input: FencedMutation,
    expectedStates: readonly TaskDispatchState[],
    nextState: TaskDispatchState,
    fields: Readonly<Record<string, string | number | null>> = {},
  ): TaskDispatchRecord {
    const taskId = idSchema.parse(input.taskId);
    const revision = z.number().int().positive().parse(input.revision);
    const hash = tokenHash(input.leaseToken);
    const db = this.#binding.writeDatabase();
    const now = this.#binding.now();
    const record = db
      .transaction(() => {
        const current = this.#getRow(db, taskId);
        if (!current || !expectedStates.includes(current.state)) {
          throw new Error(
            `transição inválida de dispatch: ${current?.state ?? "missing"} → ${nextState}`,
          );
        }
        this.#assertFence(db, current, revision, hash);
        const assignments = [
          "state = ?",
          "revision = revision + 1",
          "updated_at = ?",
        ];
        const values: Array<string | number | null> = [nextState, now];
        for (const [column, value] of Object.entries(fields)) {
          if (
            ![
              "route_reservation_id",
              "adapter_id",
              "model",
              "effort",
              "pane_id",
              "session_id",
              "last_heartbeat_at",
            ].includes(column)
          ) {
            throw new Error(
              `unsupported dispatch transition field: ${column}`,
            );
          }
          assignments.push(`${column} = ?`);
          values.push(value);
        }
        values.push(taskId, revision, hash);
        const result = db
          .prepare(
            `UPDATE task_dispatch_queue SET ${assignments.join(", ")}
             WHERE task_id = ? AND revision = ? AND lease_token_hash = ?`,
          )
          .run(...values);
        if (result.changes !== 1) {
          throw new Error("fencing/lease CAS rejeitou o dispatch");
        }
        return this.#getFromDatabase(db, taskId);
      })
      .immediate();
    if (!record) {
      throw new Error("dispatch desapareceu após transição");
    }
    this.#binding.emitChange();
    return record;
  }

  #assertFence(
    db: ReturnType<ScopedStoreBinding["readDatabase"]>,
    current: z.infer<typeof rowSchema>,
    revision: number,
    hash: string,
  ): void {
    this.#assertCurrentIntent(db, current);
    if (current.revision !== revision || current.lease_token_hash !== hash) {
      throw new Error("fencing/lease token obsoleto para o dispatch");
    }
    if (current.lease_expires_at < this.#binding.now()) {
      throw new Error("lease expirada para o dispatch");
    }
  }

  #getRequiredCurrent(taskId: string): z.infer<typeof rowSchema> {
    const normalizedTaskId = idSchema.parse(taskId);
    const current = this.#getRow(
      this.#binding.readDatabase(),
      normalizedTaskId,
    );
    if (!current)
      throw new Error(`dispatch não encontrado: ${normalizedTaskId}`);
    return current;
  }

  #assertWorkerIncarnation(
    current: z.infer<typeof rowSchema>,
    rawWorkerIncarnationId: string,
  ): void {
    const workerIncarnationId = idSchema.parse(rawWorkerIncarnationId);
    if (
      !current.worker_incarnation_id ||
      current.worker_incarnation_id !== workerIncarnationId
    ) {
      throw new Error(
        "worker incarnation obsoleta: evento pertence a outra geração física",
      );
    }
  }

  #assertCurrentIntent(
    db: ReturnType<ScopedStoreBinding["readDatabase"]>,
    current: z.infer<typeof rowSchema>,
  ): void {
    assertTaskDispatchMissionLifecycleAuthority(
      db,
      current.mission_id,
      current.intent_version,
    );
  }

  #blockMission(
    db: ReturnType<ScopedStoreBinding["writeDatabase"]>,
    missionId: string,
    detail: string,
    now: number,
  ): void {
    blockTaskDispatchMission(db, missionId, detail, now);
  }

  #getRow(db: ReturnType<ScopedStoreBinding["readDatabase"]>, taskId: string) {
    return getTaskDispatchRow(db, taskId);
  }

  #getFromDatabase(
    db: ReturnType<ScopedStoreBinding["readDatabase"]>,
    taskId: string,
  ): TaskDispatchRecord | null {
    return getTaskDispatchFromDatabase(db, taskId, this.#binding.coordinates);
  }

  #fromRow(raw: unknown): TaskDispatchRecord {
    return taskDispatchRecordFromRow(raw, this.#binding.coordinates);
  }
}

export function createTaskDispatchStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): TaskDispatchStore {
  return new TaskDispatchStore(runtimeManager, scope, options);
}
