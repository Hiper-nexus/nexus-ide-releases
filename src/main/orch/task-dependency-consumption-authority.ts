import { createHash } from "node:crypto";
import { z } from "zod";
import { ScopedStoreBinding, ScopedStoreCorruptionError } from "./scoped-store";
import {
  taskDispatchIdSchema,
  taskDispatchRowSchema,
  taskDispatchTokenHash,
  type TaskDispatchRecord,
} from "./task-dispatch-codec";
import { assertTaskDispatchMissionLifecycleAuthority } from "./task-dispatch-handoff-authority";
import { getTaskDispatchFromDatabase } from "./task-dispatch-persistence";
import { assertPhysicalTaskHandoffAuthority } from "./task-dispatch-physical-handoff-authority";
import { assertSealedTaskDispatchPlanAuthority } from "./task-dispatch-sealed-plan-authority";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const dependencyInputSchema = z
  .object({
    taskId: taskDispatchIdSchema,
    handoffId: taskDispatchIdSchema,
    summary: z.string().min(1).max(8_000),
    summarySha256: sha256Schema,
  })
  .strict();

const recordInputSchema = z
  .object({
    taskId: taskDispatchIdSchema,
    revision: z.number().int().positive(),
    leaseToken: z.string().min(1).max(4_096),
    sessionId: taskDispatchIdSchema,
    workerIncarnationId: taskDispatchIdSchema,
    acceptedPrompt: z.string().min(1).max(262_144),
    dependencies: z.array(dependencyInputSchema).max(64),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.dependencies.map((dependency) => dependency.taskId))
        .size === input.dependencies.length,
    { message: "dependency consumption task ids must be unique" },
  );

export interface RecordTaskDependencyConsumptionInput {
  readonly taskId: string;
  readonly revision: number;
  readonly leaseToken: string;
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly acceptedPrompt: string;
  readonly dependencies: readonly {
    readonly taskId: string;
    readonly handoffId: string;
    readonly summary: string;
    readonly summarySha256: string;
  }[];
}

interface RawDependency {
  readonly mission_id: string;
  readonly state: string;
  readonly session_id: string | null;
  readonly worker_incarnation_id: string | null;
  readonly handoff_id: string | null;
  readonly handoff_accepted_at: number | null;
  readonly completed_at: number | null;
  readonly worker_id: string;
  readonly handoff_status: string;
  readonly authority_origin: string;
  readonly summary: string;
  readonly receipt_mission_id: string | null;
  readonly receipt_session_id: string | null;
  readonly receipt_worker_incarnation_id: string | null;
  readonly tool_name: string | null;
}

/**
 * Persist the exact dependency results physically accepted in a worker prompt.
 *
 * The scheduler invokes this from the prompt-acceptance callback after the
 * pane has been bound to the dispatch. A fast worker may submit its own exact
 * physical handoff before the callback runs; that handoff is accepted as the
 * terminal prompt proof and pins `consumed_at` to its immutable correlated
 * audit-intent instant. The receipt issue and acceptance happen milliseconds
 * later, so using either one here would place prompt consumption after the
 * consumer's own invocation and make the final chronology impossible. The
 * sealed task metadata and every
 * physical predecessor receipt are independently re-read in the same SQLite
 * transaction; a caller cannot acknowledge a different dependency, handoff,
 * worker incarnation or prompt.
 */
export function recordTaskDependencyPromptConsumption(
  binding: ScopedStoreBinding,
  rawInput: RecordTaskDependencyConsumptionInput,
): TaskDispatchRecord {
  const input = recordInputSchema.parse(rawInput);
  const promptSha256 = createHash("sha256")
    .update(input.acceptedPrompt)
    .digest("hex");
  const now = binding.now();
  const db = binding.writeDatabase();
  const record = db
    .transaction(() => {
      const current = db
        .prepare(`SELECT * FROM task_dispatch_queue WHERE task_id = ?`)
        .get(input.taskId);
      const parsedCurrent = current
        ? taskDispatchRowSchema.parse(current)
        : undefined;
      const exactLeaseAndWorker = Boolean(
        parsedCurrent &&
          parsedCurrent.lease_token_hash ===
            taskDispatchTokenHash(input.leaseToken) &&
          parsedCurrent.session_id === input.sessionId &&
          parsedCurrent.worker_incarnation_id === input.workerIncarnationId,
      );
      const runningPromptProof = Boolean(
        parsedCurrent &&
          parsedCurrent.state === "running" &&
          parsedCurrent.revision === input.revision &&
          exactLeaseAndWorker,
      );
      const terminalHandoffPromptProof = Boolean(
        parsedCurrent &&
          ["handoff_ready", "merging", "completed"].includes(
            parsedCurrent.state,
          ) &&
          parsedCurrent.revision >= input.revision &&
          exactLeaseAndWorker &&
          parsedCurrent.handoff_id &&
          parsedCurrent.handoff_accepted_at !== null,
      );
      if (!parsedCurrent || (!runningPromptProof && !terminalHandoffPromptProof)) {
        throw new Error(
          "dependency consumption lost dispatch/session/incarnation authority",
        );
      }
      assertTaskDispatchMissionLifecycleAuthority(
        db,
        parsedCurrent.mission_id,
        parsedCurrent.intent_version,
      );
      const sealed = assertSealedTaskDispatchPlanAuthority(db, parsedCurrent);
      if (
        sealed.schedule.dependsOn.length !== input.dependencies.length ||
        sealed.schedule.dependsOn.some(
          (taskId, index) => taskId !== input.dependencies[index]?.taskId,
        )
      ) {
        throw new Error(
          "dependency consumption diverges from the sealed dependency edges",
        );
      }
      let terminalHandoffAuditIntentAt: number | null = null;
      if (terminalHandoffPromptProof) {
        // The consumer's own exact MCP handoff proves that this physical
        // session/incarnation completed the argv-delivered dependency prompt.
        // Its immutable audit intent is the earliest durable physical point
        // of the invocation, and the only authority allowed to recover this
        // race without placing consumption after the consumer's own handoff.
        const terminalPhysical = assertPhysicalTaskHandoffAuthority(
          db,
          binding.coordinates,
          {
            missionId: parsedCurrent.mission_id,
            handoffId: parsedCurrent.handoff_id!,
            sessionId: input.sessionId,
            workerIncarnationId: input.workerIncarnationId,
            workerId: parsedCurrent.worker_id,
            noLaterThan: parsedCurrent.handoff_accepted_at!,
            requireCorrelatedAuditIntent: true,
            expectedStatus: "success",
          },
        );
        if (terminalPhysical.auditIntentOccurredAt === undefined) {
          throw new Error(
            "terminal dependency recovery requires correlated audit intent time",
          );
        }
        terminalHandoffAuditIntentAt = terminalPhysical.auditIntentOccurredAt;
      }
      const consumedAt = terminalHandoffAuditIntentAt ?? now;

      const existing = db
        .prepare(
          `SELECT dependency_task_id, handoff_id, consumer_session_id,
                  consumer_worker_incarnation_id, prompt_sha256,
                  handoff_summary_sha256, consumed_at
           FROM task_dependency_consumption_receipts
           WHERE mission_id = ? AND consumer_task_id = ?
           ORDER BY dependency_task_id ASC`,
        )
        .all(parsedCurrent.mission_id, input.taskId) as Array<{
        readonly dependency_task_id: string;
        readonly handoff_id: string;
        readonly consumer_session_id: string;
        readonly consumer_worker_incarnation_id: string;
        readonly prompt_sha256: string;
        readonly handoff_summary_sha256: string;
        readonly consumed_at: number;
      }>;
      let replay = false;
      if (existing.length > 0) {
        const expectedByTask = new Map(
          input.dependencies.map((dependency) => [
            dependency.taskId,
            dependency,
          ]),
        );
        if (
          existing.length !== input.dependencies.length ||
          existing.some((receipt) => {
            const expected = expectedByTask.get(receipt.dependency_task_id);
            return (
              !expected ||
              receipt.handoff_id !== expected.handoffId ||
              receipt.consumer_session_id !== input.sessionId ||
              receipt.consumer_worker_incarnation_id !==
                input.workerIncarnationId ||
              receipt.prompt_sha256 !== promptSha256 ||
              receipt.handoff_summary_sha256 !== expected.summarySha256 ||
              receipt.consumed_at > now
            );
          })
        ) {
          throw new Error(
            "dependency consumption conflicts with an immutable prior receipt",
          );
        }
        replay = true;
      }
      const existingByTask = new Map(
        existing.map((receipt) => [receipt.dependency_task_id, receipt]),
      );

      const insert = db.prepare(
        `INSERT INTO task_dependency_consumption_receipts
           (mission_id, consumer_task_id, dependency_task_id, handoff_id,
            consumer_session_id, consumer_worker_incarnation_id,
            prompt_sha256, handoff_summary_sha256, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const dependency of input.dependencies) {
        const source = db
          .prepare(
            `SELECT dispatch.mission_id, dispatch.state, dispatch.session_id,
                    dispatch.worker_incarnation_id, dispatch.handoff_id,
                    dispatch.handoff_accepted_at, dispatch.completed_at,
                    dispatch.worker_id,
                    handoff.status AS handoff_status,
                    handoff.authority_origin, handoff.summary,
                    receipt.mission_id AS receipt_mission_id,
                    receipt.session_id AS receipt_session_id,
                    receipt.worker_incarnation_id AS receipt_worker_incarnation_id,
                    receipt.tool_name
             FROM task_dispatch_queue AS dispatch
             JOIN handoffs AS handoff ON handoff.id = dispatch.handoff_id
             LEFT JOIN handoff_mcp_receipts AS receipt
               ON receipt.handoff_id = handoff.id
             WHERE dispatch.task_id = ?`,
          )
          .get(dependency.taskId) as RawDependency | undefined;
        if (
          !source ||
          source.mission_id !== parsedCurrent.mission_id ||
          source.state !== "completed" ||
          source.handoff_id !== dependency.handoffId ||
          !source.session_id ||
          !source.worker_incarnation_id ||
          source.handoff_accepted_at === null ||
          source.completed_at === null ||
          source.handoff_accepted_at > source.completed_at ||
          source.completed_at > consumedAt ||
          source.handoff_status !== "success" ||
          source.authority_origin !== "agent" ||
          source.receipt_mission_id !== parsedCurrent.mission_id ||
          source.receipt_session_id !== source.session_id ||
          source.receipt_worker_incarnation_id !==
            source.worker_incarnation_id ||
          source.tool_name !== "nexus_handoff_submit"
        ) {
          throw new Error(
            `dependency consumption lacks a completed physical handoff for ${dependency.taskId}`,
          );
        }
        try {
          const physical = assertPhysicalTaskHandoffAuthority(
            db,
            binding.coordinates,
            {
              missionId: parsedCurrent.mission_id,
              handoffId: dependency.handoffId,
              sessionId: source.session_id,
              workerIncarnationId: source.worker_incarnation_id,
              workerId: source.worker_id,
              noLaterThan: source.handoff_accepted_at,
              requireCorrelatedAuditIntent: true,
              expectedStatus: "success",
            },
          );
          if (physical.issuedAt > source.handoff_accepted_at) {
            throw new Error(
              `dependency physical handoff chronology diverged for ${dependency.taskId}`,
            );
          }
        } catch (error) {
          if (error instanceof ScopedStoreCorruptionError) throw error;
          throw new Error(
            `dependency consumption lacks audited physical authority for ${dependency.taskId}`,
            { cause: error },
          );
        }
        const actualSummarySha256 = createHash("sha256")
          .update(source.summary.trim())
          .digest("hex");
        const safeSummary = source.summary
          .trim()
          .replace(
            /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/gu,
            " ",
          );
        if (
          actualSummarySha256 !== dependency.summarySha256 ||
          !safeSummary.startsWith(dependency.summary)
        ) {
          throw new Error(
            `dependency consumption summary changed for ${dependency.taskId}`,
          );
        }
        if (
          !input.acceptedPrompt.includes(JSON.stringify(dependency.summary))
        ) {
          throw new Error(
            `dependency consumption prompt omitted ${dependency.taskId}`,
          );
        }
        const prior = existingByTask.get(dependency.taskId);
        if (
          prior &&
          (prior.handoff_id !== dependency.handoffId ||
            prior.consumed_at < source.completed_at ||
            prior.consumed_at > now)
        ) {
          throw new Error(
            "dependency consumption conflicts with physical predecessor chronology",
          );
        }
        if (!replay) {
          insert.run(
            parsedCurrent.mission_id,
            input.taskId,
            dependency.taskId,
            dependency.handoffId,
            input.sessionId,
            input.workerIncarnationId,
            promptSha256,
            dependency.summarySha256,
            consumedAt,
          );
        }
      }
      return getTaskDispatchFromDatabase(db, input.taskId, binding.coordinates);
    })
    .immediate();
  if (!record) {
    throw new ScopedStoreCorruptionError(
      "dependency consumption dispatch disappeared",
    );
  }
  if (input.dependencies.length > 0) binding.emitChange();
  return record;
}
