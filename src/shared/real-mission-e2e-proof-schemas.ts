import { z } from "zod";

import {
  REAL_MISSION_E2E_ADVISORS,
  REAL_MISSION_E2E_CTA,
  REAL_MISSION_E2E_EXECUTOR_ID,
  REAL_MISSION_E2E_QA_ID,
  REAL_MISSION_E2E_REVIEWER_ID,
  REAL_MISSION_E2E_SQUAD_ID,
} from "./real-mission-e2e-contract";
import {
  gitShaSchema,
  idSchema,
  sha256Schema,
  timestampSchema,
} from "./real-mission-e2e-wire";

export const missionProofSchema = z
  .object({
    id: idSchema,
    status: z.enum(["pending", "running", "blocked", "done", "failed"]),
    intentState: z.string().min(1).max(64).nullable(),
    intentVersion: z.number().int().nonnegative(),
    squadId: idSchema,
    squadSourceId: z.literal(REAL_MISSION_E2E_SQUAD_ID),
    squadSourceRevisionHash: sha256Schema,
    squadRevisionHash: sha256Schema,
    approvedAt: timestampSchema.nullable(),
    dispatchedAt: timestampSchema.nullable(),
  })
  .strict();

export const missionInventoryProofSchema = z
  .object({
    evidenceOrigin: z.literal("main-owned-mission-store-inventory"),
    selectedMissionId: idSchema.nullable(),
    observedMissionCount: z.number().int().nonnegative().max(64),
    observedMissionIds: z.array(idSchema).max(64),
    finalMissionCount: z.number().int().nonnegative().max(64),
    finalMissionIds: z.array(idSchema).max(64),
    exactSingleProductMission: z.boolean(),
  })
  .strict()
  .superRefine((inventory, context) => {
    const observed = new Set(inventory.observedMissionIds);
    const final = new Set(inventory.finalMissionIds);
    if (
      inventory.observedMissionCount !== inventory.observedMissionIds.length ||
      observed.size !== inventory.observedMissionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["observedMissionIds"],
        message: "observed mission inventory cardinality is invalid",
      });
    }
    if (
      inventory.finalMissionCount !== inventory.finalMissionIds.length ||
      final.size !== inventory.finalMissionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalMissionIds"],
        message: "final mission inventory cardinality is invalid",
      });
    }
  });

export const kickoffProofSchema = z
  .object({
    sessionId: idSchema.nullable(),
    idleAt: timestampSchema.nullable(),
    busyAt: timestampSchema.nullable(),
    ptyDataAt: timestampSchema.nullable(),
    ptyChunkSha256: sha256Schema.nullable(),
  })
  .strict();

export const paneProofSchema = z
  .object({
    role: z.enum(["orchestrator", "worker"]),
    paneId: idSchema,
    sessionId: idSchema.nullable(),
    adapterId: idSchema,
    agentRef: idSchema,
    workerIncarnationId: idSchema.nullable(),
    readOnly: z.boolean().nullable(),
    nativeReadOnly: z.boolean().nullable(),
    ptySpawnedAt: timestampSchema.nullable(),
    ptyDataAt: timestampSchema.nullable(),
    ptyChunkSha256: sha256Schema.nullable(),
  })
  .strict();

const guidedPlannerIdSchema = z
  .enum(["guided-execution", "guided-quality-gate"])
  .or(z.string().regex(/^guided-review-[A-Za-z0-9._:-]{1,220}$/u))
  .or(z.string().regex(/^guided-advisory-[A-Za-z0-9._:-]{1,220}$/u));

export const planProofSchema = z
  .object({
    version: z.literal(1),
    squadId: idSchema,
    planHash: sha256Schema,
    rosterHash: sha256Schema,
    tasks: z
      .array(
        z
          .object({
            plannerId: guidedPlannerIdSchema,
            taskId: idSchema,
            agentRef: z.enum([
              REAL_MISSION_E2E_EXECUTOR_ID,
              REAL_MISSION_E2E_REVIEWER_ID,
              REAL_MISSION_E2E_QA_ID,
              ...REAL_MISSION_E2E_ADVISORS.map((advisor) => advisor.id),
            ]),
            agentCategory: z.enum(["executor", "reviewer", "scout"]),
            executionMode: z.enum(["isolated_worktree", "read_only"]),
            dependsOn: z.array(idSchema).max(2),
          })
          .strict(),
      )
      // Cadeia completa: 5 scouts + executor + revisor codex + 2 reviewers
      // advisor + QA. Advisors skipped encolhem a cadeia; a exatidão fica no
      // invariante de PASS do envelope.
      .max(10),
  })
  .strict()
  .nullable();

const worktreeIntegratedReceiptSchema = z
  .object({
    kind: z.literal("worktree_integrated"),
    reference: gitShaSchema,
    completedAt: timestampSchema,
    evidenceIds: z.array(idSchema).max(256).optional(),
  })
  .strict();

const noChangeReferenceSchema = z
  .string()
  .regex(/^no-change:[a-f0-9]{40,64}:[a-f0-9]{64}$/u);

const worktreeNoChangeReceiptSchema = z
  .object({
    kind: z.literal("worktree_validated_no_change"),
    reference: noChangeReferenceSchema,
    completedAt: timestampSchema,
    evidenceIds: z.array(idSchema).min(1).max(256),
  })
  .strict();

/** Main-owned completion for harness read_only workers (reviewer/QA/advisors). */
const readOnlyValidatedReceiptSchema = z
  .object({
    kind: z.literal("read_only_validated"),
    reference: z.string().regex(/^[a-f0-9]{64}$/u),
    completedAt: timestampSchema,
    evidenceIds: z.array(idSchema).min(1).max(256),
  })
  .strict();

export const dispatchProofSchema = z
  .object({
    taskId: idSchema,
    plannerId: guidedPlannerIdSchema.nullable(),
    agentRef: idSchema.nullable(),
    agentCategory: z
      .enum(["executor", "reviewer", "scout", "architect"])
      .nullable(),
    executionMode: z.enum(["isolated_worktree", "same_checkout", "read_only"]),
    dependsOn: z.array(idSchema).max(64),
    state: z.enum([
      "claimed",
      "routed",
      "spawning",
      "running",
      "handoff_ready",
      "merging",
      "completed",
      "blocked",
      "failed",
      "suspended",
      "superseded",
    ]),
    routeReservationId: idSchema.nullable(),
    routeConsumedAt: timestampSchema.nullable(),
    routeConsumerMatches: z.boolean(),
    workerIncarnationId: idSchema.nullable(),
    sessionId: idSchema.nullable(),
    handoffId: idSchema.nullable(),
    handoffAcceptedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    integrationReceipt: z
      .discriminatedUnion("kind", [
        worktreeIntegratedReceiptSchema,
        worktreeNoChangeReceiptSchema,
        readOnlyValidatedReceiptSchema,
      ])
      .nullable(),
  })
  .strict();

const physicalHandoffReceiptSchema = z
  .object({
    receiptId: idSchema,
    handoffId: idSchema,
    toolCallId: idSchema,
    toolName: z.literal("nexus_handoff_submit"),
    source: z.literal("http-mcp"),
    missionId: idSchema,
    sessionId: idSchema,
    workerIncarnationId: idSchema.nullable(),
    authoritySha256: sha256Schema,
    worktreeHeadSha: gitShaSchema.nullable(),
    issuedAt: timestampSchema,
    worktreeHeadIntegrated: z.boolean(),
  })
  .strict();

const physicalAuditIntentSchema = z
  .object({
    invocationId: idSchema,
    toolName: z.literal("nexus_handoff_submit"),
    source: z.literal("http-mcp"),
    sessionId: idSchema,
    missionId: idSchema,
    scope: z
      .object({
        projectId: idSchema,
        checkoutId: idSchema,
      })
      .strict(),
    occurredAt: timestampSchema,
  })
  .strict();

const deliveryAttemptProofSchema = z
  .object({
    id: idSchema,
    handoffId: idSchema,
    missionId: idSchema,
    orchestratorSessionId: idSchema,
    attemptNo: z.number().int().positive(),
    state: z.enum(["reserved", "pasted", "accepted", "failed"]),
    startedAt: timestampSchema,
    acceptDeadlineAt: timestampSchema.nullable(),
    acceptedAt: timestampSchema.nullable(),
    failedAt: timestampSchema.nullable(),
    failureCode: z.string().max(256).nullable(),
  })
  .strict();

export const handoffProofSchema = z
  .object({
    id: idSchema,
    sessionId: idSchema.nullable(),
    workerIncarnationId: idSchema.nullable(),
    fromAgent: z.string().min(1).max(256).nullable(),
    authorityOrigin: z.enum(["agent", "operator-confirmed"]).nullable(),
    summarySha256: sha256Schema,
    physicalReceipt: physicalHandoffReceiptSchema.nullable(),
    auditIntent: physicalAuditIntentSchema.nullable(),
    status: z.enum([
      "success",
      "partial",
      "blocked",
      "failed",
      "progress",
      "stalled",
    ]),
    deliveryState: z.enum(["queued", "submitted", "acknowledged", "consumed"]),
    delivered: z.boolean(),
    consumedAt: timestampSchema.nullable(),
    consumedBySessionId: idSchema.nullable(),
    consumedDeliveryAttemptId: idSchema.nullable(),
    deliveryAttempts: z.array(deliveryAttemptProofSchema).max(32),
  })
  .strict();

export const dependencyConsumptionProofSchema = z
  .object({
    missionId: idSchema,
    consumerTaskId: idSchema,
    dependencyTaskId: idSchema,
    handoffId: idSchema,
    consumerSessionId: idSchema,
    consumerWorkerIncarnationId: idSchema,
    promptSha256: sha256Schema,
    handoffSummarySha256: sha256Schema,
    consumedAt: timestampSchema,
  })
  .strict();

export const durableHandoffSetSchema = z
  .object({
    count: z.number().int().nonnegative().max(64),
    ids: z.array(idSchema).max(64),
  })
  .strict();

/**
 * Recibo de participação de uma CLI advisor: PTY físico (spawn), primeira
 * tool nexus_* na fronteira HTTP MCP e submissão do handoff. Advisors sem
 * credencial materializável entram como `skipped: "no-credential"` (via env
 * NEXUS_REAL_MISSION_ADVISOR_SKIP); na variante orquestrador Claude, a advisor
 * claude entra como `skipped: "orchestrator-reserved"` (reserveClaude: um
 * único processo Claude na missão). Skipped ficam fora da exigência de PASS.
 */
export const advisorParticipationProofSchema = z
  .object({
    cli: z.enum(["grok", "kimi", "agy", "opencode", "claude", "glm"]),
    tier: z.enum(["mechanically-confined", "advisory-unconfined"]),
    skipped: z.enum(["no-credential", "orchestrator-reserved"]).nullable(),
    spawnedAt: timestampSchema.nullable(),
    firstNexusToolAt: timestampSchema.nullable(),
    handoffAt: timestampSchema.nullable(),
  })
  .strict();

export const physicalPtySetSchema = z
  .object({
    count: z.number().int().nonnegative().max(16),
    ids: z.array(idSchema).max(16),
  })
  .strict();

const workflowStageSchema = z.enum([
  "planning",
  "review-primary",
  "review-secondary",
  "execution",
  "validation-primary",
  "validation-secondary",
  "confirmation",
  "complete",
]);

const missionDriverBindingSchema = z
  .object({
    missionId: idSchema,
    contextRevision: sha256Schema,
    contractHash: sha256Schema,
    baseSha: gitShaSchema,
    headSha: gitShaSchema,
    diffHash: sha256Schema,
    workflowRevision: z.number().int().positive(),
  })
  .strict();

const missionDriverStepReceiptSchema = z
  .object({
    stepId: idSchema,
    fromStage: workflowStageSchema,
    toStage: workflowStageSchema,
    workflowRevisionBefore: z.number().int().positive(),
    workflowRevisionAfter: z.number().int().positive(),
    evidenceIds: z.array(idSchema).min(1).max(256),
    evidenceBinding: missionDriverBindingSchema,
    completedAt: timestampSchema,
  })
  .strict();

const missionDriverMilestoneSchema = z
  .object({
    stepId: idSchema,
    label: z.string().min(1).max(1_024),
    status: z.literal("done"),
    evidenceIds: z.array(idSchema).min(1).max(64),
  })
  .strict();

export const missionDriverCompletionProofSchema = z
  .object({
    origin: z.literal("mission-driver-prevc"),
    missionId: idSchema,
    intentVersion: z.number().int().nonnegative(),
    orchestratorSessionId: idSchema,
    planHash: sha256Schema,
    taskCount: z.number().int().positive().max(64),
    completedAt: timestampSchema,
    driver: z
      .object({
        revision: z.number().int().positive(),
        runStartedAt: timestampSchema,
        attemptCount: z.number().int().positive(),
        lastAttemptAt: timestampSchema,
        lastSuccessAt: timestampSchema,
        lastActionKind: z.literal("complete"),
        lastOutcome: z.literal("success"),
        updatedAt: timestampSchema,
      })
      .strict(),
    workflow: z
      .object({
        stage: z.literal("complete"),
        revision: z.number().int().positive(),
        route: z.array(workflowStageSchema).min(2).max(8),
        binding: z
          .object({
            missionId: idSchema,
            contractHash: sha256Schema,
            contextHash: sha256Schema,
            baseSha: gitShaSchema,
            headSha: gitShaSchema,
            diffHash: sha256Schema,
          })
          .strict(),
      })
      .strict(),
    milestones: z.array(missionDriverMilestoneSchema).min(1).max(256),
    stepReceipts: z.array(missionDriverStepReceiptSchema).min(1).max(256),
  })
  .strict()
  .nullable();

export const repositoryProofSchema = z
  .object({
    initialHeadSha: gitShaSchema.nullable(),
    finalHeadSha: gitShaSchema.nullable(),
    resultSha256: sha256Schema.nullable(),
    commitCount: z.number().int().nonnegative(),
    clean: z.boolean(),
    changedBeforeWorker: z.boolean(),
    exactSingleCommit: z.boolean(),
  })
  .strict();

export const failureSchema = z
  .object({
    code: z.enum([
      "setup-failed",
      "renderer-failed",
      "observer-invalid",
      "mission-blocked",
      "mission-failed",
      "invariant-failed",
      "timeout",
      "app-error",
      "mcp-prompt-detected",
      "advisor-absent",
    ]),
    reason: z
      .enum([
        "boot_timeout",
        "timeout",
        "session_exited",
        "write_failed",
        "authority_lost",
      ])
      .nullable(),
    /**
     * Operator-facing block detail from the mission description (worker
     * dispatch fence). Kickoff reasons stay in `reason`; this field is free
     * text so the gate never loses "why" when the workspace is deleted.
     */
    detail: z.string().max(4_000).nullable().optional(),
    cta: z.literal(REAL_MISSION_E2E_CTA),
    snapshot: z
      .object({
        missionStatus: z
          .enum(["pending", "running", "blocked", "done", "failed"])
          .nullable(),
        paneCount: z.number().int().nonnegative(),
        dispatchCount: z.number().int().nonnegative(),
        handoffCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
