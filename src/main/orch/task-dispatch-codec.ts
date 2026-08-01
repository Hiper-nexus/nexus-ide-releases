import { createHash } from "node:crypto";
import { z } from "zod";
import { squadAgentSchema } from "../../shared/orch-types";
import type { ScheduleOwnership } from "./mission-scheduler";
import {
  ScopedStoreCorruptionError,
  type ScopeCoordinates,
} from "./scoped-store";

export const EMPTY_GIT_DIFF_SHA256 = createHash("sha256")
  .update("")
  .digest("hex");

export const taskDispatchIdSchema = z.string().min(1).max(256);
export const taskDispatchStateSchema = z.enum([
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
]);
export const taskDispatchOwnershipSchema = z
  .object({
    files: z.array(z.string()),
    symbols: z.array(z.string()),
    domains: z.array(z.string()),
  })
  .strict();
export const taskDispatchExecutionModeSchema = z.enum([
  "isolated_worktree",
  "same_checkout",
  "read_only",
]);
export const taskDispatchWorkerCategorySchema = z.enum([
  "executor",
  "reviewer",
  "scout",
  "architect",
]);
export const taskDispatchRouteContractSchema = z
  .object({
    adapterId: taskDispatchIdSchema,
    model: z.string().max(512).optional(),
    effort: z.string().max(128).optional(),
  })
  .strict();
export const sealedPlanDispatchSchema = z
  .object({
    missionId: taskDispatchIdSchema,
    intentVersion: z.number().int().nonnegative(),
    rosterHash: z.string().regex(/^[a-f0-9]{64}$/),
    tasks: z
      .array(
        z
          .object({
            taskId: taskDispatchIdSchema,
            title: z.string().min(1).max(1_024),
            detail: z.string().max(65_536),
            agentRef: taskDispatchIdSchema,
            agentCategory: taskDispatchWorkerCategorySchema,
          })
          .passthrough(),
      )
      .min(1)
      .max(64),
  })
  .passthrough();
export const sealedRosterDispatchSchema = z
  .object({
    version: z.literal(1),
    agents: z.array(squadAgentSchema).min(1).max(128),
  })
  .strict();
export const taskQualityReceiptProofSchema = z
  .object({
    projectId: taskDispatchIdSchema,
    checkoutId: taskDispatchIdSchema,
    missionId: taskDispatchIdSchema,
    contractHash: z.string().regex(/^[a-f0-9]{64}$/),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/),
    baseSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    workerHeadSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    integrationHeadSha: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    diffHash: z.string().regex(/^[a-f0-9]{64}$/),
    workflowRevision: z.number().int().positive(),
    sensorEvidenceIds: z.array(taskDispatchIdSchema).max(256),
    reviewEvidenceIds: z.array(taskDispatchIdSchema).min(1).max(256),
    reviewerIds: z.array(taskDispatchIdSchema).min(1).max(16),
    advisories: z
      .array(z.literal("no-required-project-sensors"))
      .max(1),
  })
  .strict();
/**
 * Provider hit kinds elegíveis ao waiver advisory (rate-limit/auth/transient).
 * `quota` nunca dispensa uma task: a janela longa de uso exige a espera-pela-irmã
 * ou intervenção do usuário, nunca uma conclusão sintética.
 */
export const taskProviderWaiverHitKindSchema = z.enum([
  "quota",
  "rate-limit",
  "auth",
  "transient",
]);
/**
 * CAS binding de um waiver `advisory_provider_unavailable`: a exceção só vale
 * para a missão/intent/revisão exata e para a encarnação física exata do worker
 * que detectou o hit — um recibo forjado ou reaproveitado não casa com a linha.
 */
export const taskProviderWaiverBindingSchema = z
  .object({
    missionId: taskDispatchIdSchema,
    intentVersion: z.number().int().nonnegative(),
    taskId: taskDispatchIdSchema,
    /** Revisão do dispatch no instante do waiver (pré-incremento do CAS). */
    revision: z.number().int().positive(),
    sessionId: taskDispatchIdSchema,
    workerIncarnationId: taskDispatchIdSchema,
    adapterId: taskDispatchIdSchema,
    hitKind: taskProviderWaiverHitKindSchema,
    /** sha256 do texto da causa detectada pelo limit-detector. */
    causeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /**
     * Reply guard (design do block/buzz): registro humano-legível de que a
     * task NUNCA executou e por quê o roster não a resgatou (esgotado,
     * orçamento de reroute consumido, janela curta). Todo waiver novo o
     * carrega; opcional apenas para receipts persistidos antes do guard.
     */
    reason: z.string().min(1).max(2_000).optional(),
  })
  .strict();
/**
 * Diretiva durável de reroute dentro do roster selado. Só o coordenador a
 * grava (após provar o esgotamento físico terminal do worker) e só o claim a
 * honra: o dispatch re-claimado deve vir exatamente como `toAgentRef`, um
 * agente do MESMO roster selado e da MESMA categoria do agente original.
 * `exhaustedAdapterIds` limita a cadeia — cada CLI do roster é tentada no
 * máximo uma vez por intentVersion.
 */
export const taskProviderRerouteDirectiveSchema = z
  .object({
    version: z.literal(1),
    /** agentRef selado no plano (nunca muda ao longo da cadeia de reroutes). */
    fromAgentRef: taskDispatchIdSchema,
    /** Agente alternativo do mesmo roster que assume a task. */
    toAgentRef: taskDispatchIdSchema,
    /** CLIs já provadas mortas para esta task nesta intentVersion. */
    exhaustedAdapterIds: z.array(taskDispatchIdSchema).min(1).max(32),
    reason: z.string().min(1).max(4_000),
    reroutedAt: z.number().int().nonnegative(),
  })
  .strict();

export const taskIntegrationReceiptSchema = z
  .object({
    kind: z.enum([
      "worktree_integrated",
      "worktree_validated_no_change",
      "isolated_advisory_validated",
      "same_checkout_validated",
      "read_only_validated",
      "advisory_provider_unavailable",
    ]),
    reference: z.string().min(1).max(2_048),
    completedAt: z.number().int().nonnegative(),
    evidenceIds: z.array(taskDispatchIdSchema).max(256).optional(),
    /**
     * Main-derived proof for a promoted worktree candidate. Callers omit it:
     * TaskDispatchStore derives it from durable PREVC and physical Git rows.
     * A persisted integrated/final-QA receipt without it cannot authorize
     * mission completion.
     */
    qualityProof: taskQualityReceiptProofSchema.optional(),
    /**
     * Identity binding of the provider-unavailable waiver. Never a handoff:
     * the task ends without output exactly because the provider stayed down.
     */
    waiver: taskProviderWaiverBindingSchema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.qualityProof &&
      receipt.kind !== "worktree_integrated" &&
      receipt.kind !== "worktree_validated_no_change"
    ) {
      context.addIssue({
        code: "custom",
        path: ["qualityProof"],
        message:
          "quality proof is exclusive to integrated or final no-change receipts",
      });
    }
    if (
      receipt.kind === "advisory_provider_unavailable" &&
      !receipt.waiver
    ) {
      context.addIssue({
        code: "custom",
        path: ["waiver"],
        message: "provider-unavailable waiver requires its exact CAS binding",
      });
    }
    if (
      receipt.kind !== "advisory_provider_unavailable" &&
      receipt.waiver
    ) {
      context.addIssue({
        code: "custom",
        path: ["waiver"],
        message:
          "waiver binding is exclusive to advisory_provider_unavailable receipts",
      });
    }
  });

export type TaskIntegrationReceipt = z.infer<
  typeof taskIntegrationReceiptSchema
>;
export type TaskProviderWaiverBinding = z.infer<
  typeof taskProviderWaiverBindingSchema
>;
export type TaskProviderWaiverHitKind = z.infer<
  typeof taskProviderWaiverHitKindSchema
>;
export type TaskQualityReceiptProof = z.infer<
  typeof taskQualityReceiptProofSchema
>;
export type TaskDispatchState = z.infer<typeof taskDispatchStateSchema>;
export type TaskDispatchExecutionMode = z.infer<
  typeof taskDispatchExecutionModeSchema
>;
export type TaskDispatchWorkerCategory = z.infer<
  typeof taskDispatchWorkerCategorySchema
>;
export type TaskDispatchRouteContract = z.infer<
  typeof taskDispatchRouteContractSchema
>;
export type TaskProviderRerouteDirective = z.infer<
  typeof taskProviderRerouteDirectiveSchema
>;

export const taskDispatchRowSchema = z
  .object({
    id: taskDispatchIdSchema,
    task_id: taskDispatchIdSchema,
    mission_id: taskDispatchIdSchema,
    intent_version: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    attempt: z.number().int().positive(),
    state: taskDispatchStateSchema,
    lease_token_hash: z.string().regex(/^[a-f0-9]{64}$/),
    lease_owner: z.string().min(1).max(256),
    lease_expires_at: z.number().int().nonnegative(),
    route_reservation_id: taskDispatchIdSchema.nullable(),
    adapter_id: taskDispatchIdSchema.nullable(),
    model: z.string().max(512).nullable(),
    effort: z.string().max(128).nullable(),
    worker_id: taskDispatchIdSchema,
    worker_incarnation_id: taskDispatchIdSchema.nullable(),
    ownership_json: z.string(),
    execution_mode: taskDispatchExecutionModeSchema,
    agent_ref: taskDispatchIdSchema.nullable(),
    agent_category: taskDispatchWorkerCategorySchema.nullable(),
    roster_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    route_contract_json: z.string().nullable(),
    provider_reroute_json: z.string().nullable(),
    pane_id: taskDispatchIdSchema.nullable(),
    session_id: taskDispatchIdSchema.nullable(),
    handoff_id: taskDispatchIdSchema.nullable(),
    handoff_accepted_at: z.number().int().nonnegative().nullable(),
    integration_receipt_json: z.string().nullable(),
    completed_at: z.number().int().nonnegative().nullable(),
    last_heartbeat_at: z.number().int().nonnegative().nullable(),
    last_error: z.string().max(65_536).nullable(),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

export type TaskDispatchRow = z.infer<typeof taskDispatchRowSchema>;

export interface TaskDispatchRecord {
  readonly id: string;
  readonly taskId: string;
  readonly missionId: string;
  readonly intentVersion: number;
  readonly revision: number;
  readonly attempt: number;
  readonly state: TaskDispatchState;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: number;
  readonly routeReservationId?: string;
  readonly adapterId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly workerId: string;
  /** Main-issued nonce for this exact physical worker generation. */
  readonly workerIncarnationId?: string;
  readonly ownership: ScheduleOwnership;
  readonly executionMode: TaskDispatchExecutionMode;
  readonly agentRef?: string;
  readonly agentCategory?: TaskDispatchWorkerCategory;
  readonly rosterHash?: string;
  readonly routeContract?: TaskDispatchRouteContract;
  readonly providerReroute?: TaskProviderRerouteDirective;
  readonly paneId?: string;
  readonly sessionId?: string;
  readonly handoffId?: string;
  readonly handoffAcceptedAt?: number;
  readonly integrationReceipt?: TaskIntegrationReceipt;
  readonly completedAt?: number;
  readonly lastHeartbeatAt?: number;
  readonly lastError?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly projectId: string;
  readonly checkoutId: string;
}

export interface ClaimedTaskDispatch extends TaskDispatchRecord {
  readonly leaseToken: string;
  readonly workerIncarnationId: string;
}

export interface TaskDispatchFencedMutation {
  readonly taskId: string;
  readonly revision: number;
  readonly leaseToken: string;
}

/**
 * Physical proof that THIS exact worker incarnation delivered its handoff:
 * the durable dispatch binds the handoff id to the same mission, session and
 * worker incarnation. Providers that exit by themselves right after printing
 * the handoff block (AGY) must complete bootstrap on this fact instead of
 * terminalizing on the exit observation.
 */
export function hasBoundHandoffForExactDispatchWorker(
  dispatch: TaskDispatchRecord | null,
  identity: {
    readonly missionId: string;
    readonly sessionId: string | null;
    readonly workerIncarnationId: string;
  },
): boolean {
  return Boolean(
    dispatch &&
      dispatch.handoffId !== undefined &&
      dispatch.missionId === identity.missionId &&
      dispatch.workerIncarnationId === identity.workerIncarnationId &&
      (identity.sessionId === null ||
        dispatch.sessionId === identity.sessionId),
  );
}

export function taskDispatchTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseTaskDispatchDatabaseRow(raw: unknown): TaskDispatchRow {
  try {
    return taskDispatchRowSchema.parse(raw);
  } catch (error) {
    throw new ScopedStoreCorruptionError("task dispatch", { cause: error });
  }
}

export function taskDispatchRecordFromParsedRow(
  row: TaskDispatchRow,
  coordinates: ScopeCoordinates,
): TaskDispatchRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    missionId: row.mission_id,
    intentVersion: row.intent_version,
    revision: row.revision,
    attempt: row.attempt,
    state: row.state,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    routeReservationId: row.route_reservation_id ?? undefined,
    adapterId: row.adapter_id ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    workerId: row.worker_id,
    workerIncarnationId: row.worker_incarnation_id ?? undefined,
    ownership: taskDispatchOwnershipSchema.parse(
      JSON.parse(row.ownership_json),
    ),
    executionMode: row.execution_mode,
    agentRef: row.agent_ref ?? undefined,
    agentCategory: row.agent_category ?? undefined,
    rosterHash: row.roster_hash ?? undefined,
    routeContract: row.route_contract_json
      ? taskDispatchRouteContractSchema.parse(
          JSON.parse(row.route_contract_json),
        )
      : undefined,
    providerReroute: row.provider_reroute_json
      ? taskProviderRerouteDirectiveSchema.parse(
          JSON.parse(row.provider_reroute_json),
        )
      : undefined,
    paneId: row.pane_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    handoffId: row.handoff_id ?? undefined,
    handoffAcceptedAt: row.handoff_accepted_at ?? undefined,
    integrationReceipt: row.integration_receipt_json
      ? taskIntegrationReceiptSchema.parse(
          JSON.parse(row.integration_receipt_json),
        )
      : undefined,
    completedAt: row.completed_at ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...coordinates,
  };
}

export function taskDispatchRecordFromRow(
  raw: unknown,
  coordinates: ScopeCoordinates,
): TaskDispatchRecord {
  try {
    return taskDispatchRecordFromParsedRow(
      taskDispatchRowSchema.parse(raw),
      coordinates,
    );
  } catch (error) {
    throw new ScopedStoreCorruptionError("task dispatch", { cause: error });
  }
}
