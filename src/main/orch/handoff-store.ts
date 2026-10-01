import type Database from "better-sqlite3";
import { emitAppEvent } from '../connectors/app-events';
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  hasCurrentApprovedDispatchContract,
  missionIntentContractSchema,
  reserveEffectfulSpend,
} from "../../shared/mission-intent";
import {
  handoffStatusSchema,
  handoffDeliveryStateSchema,
  type Handoff,
  type HandoffEvidenceBinding,
  type HandoffMcpProvenance,
} from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  parseWorkflowState,
  type EvidenceBinding,
} from "../context/prevc-engine";
import { parseReviewReport } from "../context/review-council";
import { parseTrustedEvidence } from "../context/sensor-broker";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import type { MissionEngine } from "./mission-engine";
import {
  retainAcceptedHandoffMemoryDistilledBestEffort,
  retainAcknowledgedHandoffMemoryBestEffort,
} from "../memory/trusted-memory";
import {
  encodeJsonArray,
  parseJsonArray,
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedEntity,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from "./scoped-store";
import {
  consumeAgentTransportPhysicalReceipt,
  inspectCurrentAgentTransportPhysicalReceipt,
  type AgentTransportPhysicalReceipt,
} from "./http-mcp-boundary";
import { markHandoffConsumedFromPhysicalAck } from "./handoff-physical-ack-authority";
import {
  commitTaskDispatchHandoffInTransaction,
  completeBlockedTaskDispatchHandoffPostCommit,
  resolveCommittedTaskDispatchHandoffReplayInTransaction,
} from "./task-dispatch-handoff-authority";
import { missionEngineForScope } from "./mission-engine-registry";
import { emitWorkerDecisionClarify } from "./worker-decision-clarify";
import type { TaskDispatchRecord } from "./task-dispatch-codec";
import { handoffLogicalOperationKey } from "./handoff-payload-identity";
import {
  computeChainHash,
  handoffReceiptChainEntry,
  verifyChain,
  type ChainedReceiptEntry,
  type ReceiptChainVerification,
} from "../../shared/receipt-chain";
import type { AgentAttestation } from "../../shared/agent-attestation";
import { getHandoffAttachments } from "./handoff-attachments";
import { PROVISIONAL_WORKER_HANDOFF_AUTHORS } from "./provisional-worker-handoff";

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
// Squad agentName is a human-facing identity and legitimately contains spaces
// (for example "UX Designer"). Keep opaque ids strict, but do not make those
// valid roster workers unable to submit a handoff.
const agentLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001F\u007F]+$/u);

const evidenceIdsSchema = z
  .array(identifierSchema)
  .max(256)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "evidenceIds must be unique",
  });
const PHYSICAL_HANDOFF_SPEND_INTENT_STATES = new Set([
  "dispatched",
  "executing",
  "validating",
]);

const submitHandoffInputSchema = z
  .object({
    status: handoffStatusSchema,
    summary: z.string().min(1).max(65_536),
    artifacts: z.array(z.unknown()).max(4_096).optional(),
    evidenceIds: evidenceIdsSchema.optional(),
    missionId: identifierSchema.optional(),
    sessionId: identifierSchema.optional(),
    workerIncarnationId: identifierSchema.optional(),
    fromAgent: agentLabelSchema.optional(),
  })
  .strict();

const nullableHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const nullableCommitSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .nullable();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

const mcpBoundaryOptionsSchema = z
  .object({
    worktreeHeadSha: commitSchema.optional(),
    rawPayloadSha256: sha256Schema,
  })
  .strict();

const mcpAuditIntentPayloadSchema = z
  .object({
    project_id: identifierSchema,
    checkout_id: identifierSchema,
    source: z.enum([
      "http-mcp",
      "acp-stdio",
      "pty-stream",
      "mission-shim",
      "omp-rpc-stdio",
    ]),
    invocation_id: identifierSchema,
  })
  .passthrough();

const mcpReceiptRowSchema = z
  .object({
    receipt_id: identifierSchema,
    handoff_id: identifierSchema,
    tool_call_id: identifierSchema,
    tool_name: z.literal("nexus_handoff_submit"),
    source: z.enum([
      "http-mcp",
      "acp-stdio",
      "pty-stream",
      "mission-shim",
      "omp-rpc-stdio",
    ]),
    mission_id: identifierSchema,
    session_id: identifierSchema,
    worker_incarnation_id: identifierSchema.nullable(),
    authority_sha256: sha256Schema,
    worktree_head_sha: commitSchema.nullable(),
    raw_payload_sha256: sha256Schema.nullable(),
    logical_operation_key: sha256Schema.nullable(),
    issued_at: z.number().int().nonnegative(),
    // Null is retained for pre-029 receipts. They remain readable, but only
    // rows with a complete chain link participate in the new verification.
    chain_seq: z.number().int().positive().nullable(),
    prev_receipt_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    chain_hash: sha256Schema.nullable(),
  })
  .strict();

const receiptChainHeadRowSchema = z
  .object({
    chain_seq: z.number().int().positive(),
    chain_hash: sha256Schema,
  })
  .strict();

const handoffRowSchema = z
  .object({
    id: identifierSchema,
    mission_id: identifierSchema.nullable(),
    session_id: identifierSchema.nullable(),
    worker_incarnation_id: identifierSchema.nullable(),
    from_agent: agentLabelSchema.nullable(),
    authority_origin: z.enum(["agent", "operator-confirmed"]),
    status: handoffStatusSchema,
    summary: z.string().min(1).max(65_536),
    artifacts_json: z.string(),
    evidence_ids_json: z.string(),
    evidence_trusted: z.union([z.literal(0), z.literal(1)]),
    context_revision: nullableHashSchema,
    contract_hash: nullableHashSchema,
    base_sha: nullableCommitSchema,
    head_sha: nullableCommitSchema,
    diff_hash: nullableHashSchema,
    workflow_revision: z.number().int().positive().nullable(),
    delivered: z.union([z.literal(0), z.literal(1)]),
    delivery_state: handoffDeliveryStateSchema,
    submitted_at: z.number().int().nonnegative().nullable(),
    acknowledged_at: z.number().int().nonnegative().nullable(),
    consumed_at: z.number().int().nonnegative().nullable(),
    consumed_by_session: identifierSchema.nullable(),
    consumed_delivery_attempt_id: identifierSchema.nullable(),
    created_at: z.number().int().nonnegative(),
  })
  .strict();

const deliveryAttemptStateSchema = z.enum([
  "reserved",
  "pasted",
  "accepted",
  "failed",
]);

const deliveryAttemptRowSchema = z
  .object({
    id: identifierSchema,
    handoff_id: identifierSchema,
    mission_id: identifierSchema,
    orchestrator_session_id: identifierSchema,
    attempt_no: z.number().int().positive(),
    state: deliveryAttemptStateSchema,
    started_at: z.number().int().nonnegative(),
    accept_deadline_at: z.number().int().nonnegative().nullable(),
    accepted_at: z.number().int().nonnegative().nullable(),
    failed_at: z.number().int().nonnegative().nullable(),
    failure_code: z.string().max(256).nullable(),
  })
  .strict();

export interface HandoffDeliveryAttempt {
  readonly id: string;
  readonly handoffId: string;
  readonly missionId: string;
  readonly orchestratorSessionId: string;
  readonly attemptNo: number;
  readonly state: z.infer<typeof deliveryAttemptStateSchema>;
  readonly startedAt: number;
  readonly acceptDeadlineAt?: number;
  readonly acceptedAt?: number;
  readonly failedAt?: number;
  readonly failureCode?: string;
}

const currentWorkflowRowSchema = z
  .object({
    contract_hash: z.string().regex(/^[a-f0-9]{64}$/),
    context_revision: z.string().regex(/^[a-f0-9]{64}$/),
    workflow_revision: z.number().int().positive(),
    workflow_json: z.string(),
  })
  .strict();

const BINDING_KEYS: readonly (keyof EvidenceBinding)[] = [
  "projectId",
  "checkoutId",
  "missionId",
  "contractHash",
  "contextHash",
  "baseSha",
  "headSha",
  "diffHash",
];

const HANDOFF_SELECT = `
  SELECT id, mission_id, session_id, worker_incarnation_id, from_agent,
         authority_origin, status, summary,
         artifacts_json, evidence_ids_json, evidence_trusted,
         context_revision, contract_hash, base_sha, head_sha, diff_hash,
         workflow_revision, delivered, delivery_state, submitted_at,
         acknowledged_at, consumed_at, consumed_by_session,
         consumed_delivery_attempt_id, created_at
  FROM handoffs`;

export type ScopedHandoff = ScopedEntity<Handoff> & {
  readonly consumedBySession?: string;
  readonly consumedDeliveryAttemptId?: string;
};
export type SubmitHandoffInput = z.input<typeof submitHandoffInputSchema>;

export interface PhysicalHandoffDispatchTransition {
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly detail: string;
}

export interface PhysicalHandoffCommitResult {
  readonly handoff: ScopedHandoff;
  readonly taskDispatch: TaskDispatchRecord;
  readonly replayed: boolean;
}

export interface PhysicalHandoffSubmitResult {
  readonly handoff: ScopedHandoff;
  readonly replayed: boolean;
}

/** Verified agent identity bound atomically to the physical MCP receipt row. */
export interface HandoffAgentAttestationBinding {
  readonly agentPubkey: string;
  readonly ownerPubkey: string;
  readonly credential: AgentAttestation;
}

export interface ListHandoffsFilter {
  /** null selects only workspace handoffs; undefined keeps the audit query. */
  missionId?: string | null;
  includeDelivered?: boolean;
  /** Filter by exact handoff ids (Overclock `ids`). */
  ids?: string[];
  /** Filter by worker PTY session ids (Overclock `panes`). */
  sessionIds?: string[];
}

interface ResolvedEvidence {
  readonly evidenceIds: string[];
  readonly binding?: HandoffEvidenceBinding;
}

function parseBoundedJson(raw: string, label: string): unknown {
  try {
    if (Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024) {
      throw new Error(`${label} exceeds 4 MiB`);
    }
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ScopedStoreCorruptionError(label, { cause: error });
  }
}

function asCorruption<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ScopedStoreCorruptionError) throw error;
    throw new ScopedStoreCorruptionError(label, { cause: error });
  }
}

function cloneBinding(
  binding: HandoffEvidenceBinding | undefined,
): HandoffEvidenceBinding | undefined {
  return binding ? Object.freeze({ ...binding }) : undefined;
}

function cloneHandoff(handoff: ScopedHandoff): ScopedHandoff {
  return {
    ...handoff,
    artifacts: parseJsonArray(
      encodeJsonArray(handoff.artifacts, "handoff artifacts"),
      "handoff artifacts",
    ),
    evidenceIds: [...handoff.evidenceIds],
    evidenceBinding: cloneBinding(handoff.evidenceBinding),
    mcpProvenance: handoff.mcpProvenance
      ? Object.freeze({ ...handoff.mcpProvenance })
      : undefined,
  };
}

function toHandoffBinding(
  binding: EvidenceBinding,
  workflowRevision: number,
): HandoffEvidenceBinding {
  return Object.freeze({
    missionId: binding.missionId,
    contextRevision: binding.contextHash,
    contractHash: binding.contractHash,
    baseSha: binding.baseSha,
    headSha: binding.headSha,
    diffHash: binding.diffHash,
    workflowRevision,
  });
}

function sameHandoffBinding(
  left: HandoffEvidenceBinding,
  right: HandoffEvidenceBinding,
): boolean {
  return (
    left.missionId === right.missionId &&
    left.contextRevision === right.contextRevision &&
    left.contractHash === right.contractHash &&
    left.baseSha === right.baseSha &&
    left.headSha === right.headSha &&
    left.diffHash === right.diffHash &&
    left.workflowRevision === right.workflowRevision
  );
}

function assertEvidenceMatches(
  evidenceId: string,
  actual: EvidenceBinding,
  expected: EvidenceBinding,
): void {
  if (actual.missionId !== expected.missionId) {
    throw new Error(
      `trusted evidence "${evidenceId}" belongs to another mission`,
    );
  }
  if (
    actual.projectId !== expected.projectId ||
    actual.checkoutId !== expected.checkoutId
  ) {
    throw new Error(
      `trusted evidence "${evidenceId}" belongs to another project scope`,
    );
  }
  const mismatch = BINDING_KEYS.find((key) => actual[key] !== expected[key]);
  if (mismatch) {
    throw new Error(
      `trusted evidence "${evidenceId}" does not match the current ` +
        `workflow binding (${mismatch})`,
    );
  }
}

export interface ScopedHandoffStoreOptions extends ScopedStoreOptions {
  readonly missionEngine?: Pick<MissionEngine, "blockUser">;
}

export class ScopedHandoffStore {
  readonly #binding: ScopedStoreBinding;
  readonly #configuredMissionEngine:
    | Pick<MissionEngine, "blockUser">
    | undefined;
  readonly #dispatchChangeListeners = new Set<ScopedStoreChangeListener>();

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedHandoffStoreOptions = {},
  ) {
    const { missionEngine, ...storeOptions } = options;
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, storeOptions);
    this.#configuredMissionEngine = missionEngine;
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  onDispatchChange(listener: ScopedStoreChangeListener): () => void {
    this.#dispatchChangeListeners.add(listener);
    return () => this.#dispatchChangeListeners.delete(listener);
  }

  submit(rawInput: SubmitHandoffInput): ScopedHandoff {
    return this.#submit(rawInput, "agent").handoff;
  }

  /**
   * Exact durable-write boundary for `nexus_handoff_submit`.
   *
   * The MCP dispatcher owns `toolCallId` and the bearer fingerprint. A normal
   * main-process `submit()` cannot add this receipt, so it cannot satisfy a
   * release proof that requires physical MCP provenance.
   */
  submitFromPhysicalAgentBoundary(
    rawInput: SubmitHandoffInput,
    physicalReceipt: AgentTransportPhysicalReceipt,
    rawOptions: z.input<typeof mcpBoundaryOptionsSchema>,
    attestation?: HandoffAgentAttestationBinding,
  ): ScopedHandoff {
    return this.submitFromPhysicalAgentBoundaryWithReplay(
      rawInput,
      physicalReceipt,
      rawOptions,
      attestation,
    ).handoff;
  }

  /**
   * Result-bearing variant used by the MCP tool so post-commit recovery can
   * distinguish a first write from an exact replay even without a dispatch.
   */
  submitFromPhysicalAgentBoundaryWithReplay(
    rawInput: SubmitHandoffInput,
    physicalReceipt: AgentTransportPhysicalReceipt,
    rawOptions: z.input<typeof mcpBoundaryOptionsSchema>,
    attestation?: HandoffAgentAttestationBinding,
  ): PhysicalHandoffSubmitResult {
    const committed = this.#submit(rawInput, "agent", {
      physicalReceipt,
      options: mcpBoundaryOptionsSchema.parse(rawOptions),
      attestation,
    });
    return {
      handoff: committed.handoff,
      replayed: committed.replayed,
    };
  }

  /**
   * The only production port that may both persist a physical worker handoff
   * and advance/block its running dispatch. All rows commit in one immediate
   * SQLite transaction; any receipt/audit/CAS failure rolls the handoff back.
   */
  submitFromPhysicalAgentBoundaryAndTransitionDispatch(
    rawInput: SubmitHandoffInput,
    physicalReceipt: AgentTransportPhysicalReceipt,
    rawOptions: z.input<typeof mcpBoundaryOptionsSchema>,
    transition: PhysicalHandoffDispatchTransition,
    attestation?: HandoffAgentAttestationBinding,
  ): PhysicalHandoffCommitResult {
    const committed = this.#submit(rawInput, "agent", {
      physicalReceipt,
      options: mcpBoundaryOptionsSchema.parse(rawOptions),
      dispatchTransition: transition,
      attestation,
    });
    if (!committed.taskDispatch) {
      throw new Error("physical handoff transaction lost its dispatch result");
    }
    return {
      handoff: committed.handoff,
      taskDispatch: committed.taskDispatch,
      replayed: committed.replayed,
    };
  }

  /** Main-only semantic boundary used after an exact native operator click. */
  submitOperatorConfirmed(rawInput: SubmitHandoffInput): ScopedHandoff {
    return this.#submit(rawInput, "operator-confirmed").handoff;
  }

  #submit(
    rawInput: SubmitHandoffInput,
    authorityOrigin: "agent" | "operator-confirmed",
    mcpBoundary?: {
      readonly physicalReceipt: AgentTransportPhysicalReceipt;
      readonly options: z.infer<typeof mcpBoundaryOptionsSchema>;
      readonly dispatchTransition?: PhysicalHandoffDispatchTransition;
      readonly attestation?: HandoffAgentAttestationBinding;
    },
  ): {
    readonly handoff: ScopedHandoff;
    readonly taskDispatch?: TaskDispatchRecord;
    readonly replayed: boolean;
  } {
    const input = submitHandoffInputSchema.parse(rawInput);
    if (
      mcpBoundary &&
      (!input.missionId ||
        !input.sessionId ||
        (input.workerIncarnationId !== undefined &&
          input.workerIncarnationId.length === 0))
    ) {
      throw new Error(
        "MCP handoff provenance requires missionId and physical sessionId",
      );
    }
    const artifactsJson = encodeJsonArray(
      input.artifacts ?? [],
      "handoff artifacts",
    );
    const evidenceIds = input.evidenceIds ?? [];
    const evidenceIdsJson = encodeJsonArray(
      evidenceIds,
      "handoff evidence IDs",
    );
    const logicalOperationKey = mcpBoundary
      ? handoffLogicalOperationKey({
          scope: this.#binding.scope,
          missionId: input.missionId!,
          sessionId: input.sessionId!,
          workerIncarnationId: input.workerIncarnationId,
        })
      : undefined;
    const createdAt = this.#binding.now();
    const db = this.#binding.writeDatabase();

    const insert = db.transaction(() => {
      const receiptExpectation = mcpBoundary
        ? {
            projectId: this.#binding.scope.projectId,
            checkoutId: this.#binding.scope.checkoutId,
            missionId: input.missionId!,
            sessionId: input.sessionId!,
            workerIncarnationId: input.workerIncarnationId,
            worktreeHeadSha: mcpBoundary.options.worktreeHeadSha,
            rawPayloadSha256: mcpBoundary.options.rawPayloadSha256,
          }
        : undefined;
      const inspectedReceipt =
        mcpBoundary && receiptExpectation
          ? inspectCurrentAgentTransportPhysicalReceipt(
              mcpBoundary.physicalReceipt,
              receiptExpectation,
            )
          : undefined;
      if (
        inspectedReceipt &&
        inspectedReceipt.toolName !== "nexus_handoff_submit"
      ) {
        throw new Error(
          "handoff submit requires an exact physical nexus_handoff_submit receipt",
        );
      }
      if (
        mcpBoundary &&
        receiptExpectation &&
        logicalOperationKey &&
        inspectedReceipt
      ) {
        const committedReceipt = this.#findCommittedPhysicalReceipt(
          db,
          input.missionId!,
          input.sessionId!,
          input.workerIncarnationId,
          logicalOperationKey,
          mcpBoundary.options.rawPayloadSha256,
        );
        if (committedReceipt) {
          const dispatchReplay = mcpBoundary.dispatchTransition
            ? resolveCommittedTaskDispatchHandoffReplayInTransaction(
                db,
                this.#binding.coordinates,
                {
                  sessionId: mcpBoundary.dispatchTransition.sessionId,
                  workerIncarnationId:
                    mcpBoundary.dispatchTransition.workerIncarnationId,
                  expectedStatus:
                    input.status === "success" ? "success" : "non-success",
                },
                createdAt,
              )
            : undefined;
          if (
            mcpBoundary.dispatchTransition &&
            (!dispatchReplay ||
              dispatchReplay.taskDispatch.handoffId !==
                committedReceipt.handoff_id)
          ) {
            throw new ScopedStoreCorruptionError(
              "physical handoff receipt/dispatch replay binding",
            );
          }
          if (
            dispatchReplay &&
            (dispatchReplay.physicalAuthority.source !==
              committedReceipt.source ||
              dispatchReplay.physicalAuthority.worktreeHeadSha !==
                (committedReceipt.worktree_head_sha ?? undefined))
          ) {
            throw new ScopedStoreCorruptionError(
              "physical handoff replay authority",
            );
          }
          this.#assertCorrelatedMcpAuditIntent(db, inspectedReceipt);
          const handoff = this.#assertExactPhysicalReplay(
            db,
            committedReceipt,
            input,
            artifactsJson,
            evidenceIdsJson,
            inspectedReceipt.source,
            mcpBoundary.options.worktreeHeadSha,
            mcpBoundary.options.rawPayloadSha256,
            logicalOperationKey,
            mcpBoundary.dispatchTransition?.detail,
            dispatchReplay?.taskDispatch,
          );
          const replayReceipt = consumeAgentTransportPhysicalReceipt(
            mcpBoundary.physicalReceipt,
            receiptExpectation,
          );
          if (!isDeepStrictEqual(replayReceipt, inspectedReceipt)) {
            throw new ScopedStoreCorruptionError(
              "physical handoff replay receipt authority",
            );
          }
          return {
            handoff,
            taskDispatch: dispatchReplay?.taskDispatch,
            replayed: true,
          };
        }
        if (mcpBoundary.dispatchTransition) {
          const unexpectedReplay =
            resolveCommittedTaskDispatchHandoffReplayInTransaction(
              db,
              this.#binding.coordinates,
              {
                sessionId: mcpBoundary.dispatchTransition.sessionId,
                workerIncarnationId:
                  mcpBoundary.dispatchTransition.workerIncarnationId,
                expectedStatus:
                  input.status === "success" ? "success" : "non-success",
              },
              createdAt,
            );
          if (unexpectedReplay) {
            throw new ScopedStoreCorruptionError(
              "committed dispatch handoff without idempotency identity",
            );
          }
        }
      }
      const consumedReceipt =
        mcpBoundary && receiptExpectation
          ? consumeAgentTransportPhysicalReceipt(
              mcpBoundary.physicalReceipt,
              receiptExpectation,
            )
          : undefined;
      if (
        consumedReceipt &&
        consumedReceipt.toolName !== "nexus_handoff_submit"
      ) {
        throw new Error(
          "handoff submit consumed a non-submit physical receipt",
        );
      }
      if (consumedReceipt) {
        this.#assertCorrelatedMcpAuditIntent(db, consumedReceipt);
        this.#reservePhysicalHandoffSpendInTransaction(
          db,
          input.missionId!,
        );
      }
      const submitProvenance: HandoffMcpProvenance | undefined =
        consumedReceipt
          ? Object.freeze({
              receiptId: consumedReceipt.toolCallId,
              toolCallId: consumedReceipt.toolCallId,
              toolName: "nexus_handoff_submit",
              source: consumedReceipt.source,
              missionId: consumedReceipt.missionId,
              sessionId: consumedReceipt.sessionId,
              workerIncarnationId: consumedReceipt.workerIncarnationId,
              authoritySha256: consumedReceipt.authoritySha256,
              worktreeHeadSha: mcpBoundary?.options.worktreeHeadSha,
              rawPayloadSha256: mcpBoundary?.options.rawPayloadSha256,
              logicalOperationKey,
              issuedAt: consumedReceipt.issuedAt,
            })
          : undefined;
      const resolved = this.#resolveEvidence(db, input.missionId, evidenceIds);
      const id = this.#binding.makeId("handoff");
      const handoff: ScopedHandoff = {
        id,
        missionId: input.missionId,
        sessionId: input.sessionId,
        workerIncarnationId: input.workerIncarnationId,
        fromAgent: input.fromAgent,
        authorityOrigin,
        mcpProvenance: submitProvenance,
        status: input.status,
        claimTrust: "untrusted",
        summary: input.summary,
        artifacts: parseJsonArray(artifactsJson, "handoff artifacts"),
        evidenceIds: [...resolved.evidenceIds],
        evidenceTrust: resolved.binding ? "nexus-trusted" : "unverified",
        evidenceBinding: resolved.binding,
        delivered: false,
        deliveryState: "queued",
        createdAt,
        ...this.#binding.coordinates,
      };
      db.prepare(
        `INSERT INTO handoffs
           (id, mission_id, session_id, worker_incarnation_id, from_agent,
            authority_origin, status, summary,
            artifacts_json, evidence_ids_json, evidence_trusted,
            context_revision, contract_hash, base_sha, head_sha, diff_hash,
            workflow_revision, delivered, delivery_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'queued', ?)`,
      ).run(
        handoff.id,
        handoff.missionId ?? null,
        handoff.sessionId ?? null,
        handoff.workerIncarnationId ?? null,
        handoff.fromAgent ?? null,
        handoff.authorityOrigin,
        handoff.status,
        handoff.summary,
        artifactsJson,
        evidenceIdsJson,
        resolved.binding ? 1 : 0,
        resolved.binding?.contextRevision ?? null,
        resolved.binding?.contractHash ?? null,
        resolved.binding?.baseSha ?? null,
        resolved.binding?.headSha ?? null,
        resolved.binding?.diffHash ?? null,
        resolved.binding?.workflowRevision ?? null,
        handoff.createdAt,
      );
      if (handoff.mcpProvenance) {
        const chainLink = this.#nextReceiptChainLinkInTransaction(
          db,
          handoff.id,
          handoff.mcpProvenance,
        );
        this.#insertHandoffMcpReceiptInTransaction(
          db,
          handoff.id,
          handoff.mcpProvenance,
          chainLink,
          mcpBoundary?.attestation,
        );
      }
      const taskDispatch = mcpBoundary?.dispatchTransition
        ? commitTaskDispatchHandoffInTransaction(
            db,
            this.#binding.coordinates,
            {
              sessionId: mcpBoundary.dispatchTransition.sessionId,
              workerIncarnationId:
                mcpBoundary.dispatchTransition.workerIncarnationId,
              handoffId: handoff.id,
              outcome: handoff.status === "success" ? "accept" : "block",
              detail: mcpBoundary.dispatchTransition.detail,
            },
            createdAt,
          )
        : undefined;
      this.#consumeProvisionalWorkerHandoffs(db, handoff);
      return { handoff, taskDispatch, replayed: false };
    });

    const committed = insert.immediate();
    if (!committed.replayed) {
      if (
        mcpBoundary?.dispatchTransition &&
        committed.handoff.status !== "success" &&
        committed.taskDispatch
      ) {
        completeBlockedTaskDispatchHandoffPostCommit(
          this.#binding,
          committed.taskDispatch,
          mcpBoundary.dispatchTransition.detail,
          {
            emitClarify: emitWorkerDecisionClarify,
            missionEngine:
              this.#configuredMissionEngine ??
              missionEngineForScope(this.#binding.scope),
          },
        );
      } else {
        this.#binding.emitChange();
      }
      if (committed.taskDispatch) this.#emitDispatchChange();
      if (
        committed.handoff.status === "success" &&
        committed.taskDispatch?.handoffId === committed.handoff.id &&
        committed.taskDispatch.handoffAcceptedAt !== undefined
      ) {
        // Best-effort e assíncrono de propósito: a destilação do resumo é uma
        // chamada remota ao Jev e não pode segurar o aceite do handoff.
        void retainAcceptedHandoffMemoryDistilledBestEffort(
          this.#binding.scope,
          {
            handoffId: committed.handoff.id,
            missionId: committed.taskDispatch.missionId,
            taskId: committed.taskDispatch.taskId,
            dispatchId: committed.taskDispatch.id,
            status: committed.handoff.status,
            acceptedAt: committed.taskDispatch.handoffAcceptedAt,
            ...(committed.handoff.evidenceTrust === "nexus-trusted" &&
            committed.handoff.evidenceBinding
              ? {
                  evidenceIds: committed.handoff.evidenceIds.slice(0, 32),
                  evidenceBinding: committed.handoff.evidenceBinding,
                }
              : {}),
            ...(committed.handoff.mcpProvenance
              ? { mcpReceiptId: committed.handoff.mcpProvenance.receiptId }
              : {}),
          },
          committed.handoff.summary,
        ).catch(() => {});
      }
    }
    return {
      handoff: cloneHandoff(committed.handoff),
      ...(committed.taskDispatch
        ? { taskDispatch: committed.taskDispatch }
        : {}),
      replayed: committed.replayed,
    };
  }

  /**
   * Computes the next link of this mission's receipt hash chain (derived from
   * block/buzz buzz-audit — see src/shared/receipt-chain.ts). Must run inside
   * the same transaction that inserts the receipt row: the head read and the
   * chained insert are one atomic append, and the partial unique index on
   * (mission_id, chain_seq) rejects any concurrent double-append.
   */
  #receiptAttestationColumnsAvailable(db: Database.Database): boolean {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM pragma_table_info('handoff_mcp_receipts')
         WHERE name = 'attestation_json'`,
      )
      .get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  #insertHandoffMcpReceiptInTransaction(
    db: Database.Database,
    handoffId: string,
    provenance: HandoffMcpProvenance,
    chainLink: {
      readonly chainSeq: number;
      readonly prevReceiptHash: string | null;
      readonly chainHash: string;
    },
    attestation?: HandoffAgentAttestationBinding,
  ): void {
    const attestationColumns =
      attestation !== undefined &&
      this.#receiptAttestationColumnsAvailable(db);
    if (attestation && !attestationColumns) {
      throw new Error(
        "handoff attestation binding requires migration 030 attestation columns",
      );
    }
    if (attestationColumns && attestation) {
      db.prepare(
        `INSERT INTO handoff_mcp_receipts
           (receipt_id, handoff_id, tool_call_id, tool_name, source,
            mission_id, session_id, worker_incarnation_id,
            authority_sha256, worktree_head_sha, raw_payload_sha256,
            logical_operation_key, issued_at,
            chain_seq, prev_receipt_hash, chain_hash,
            agent_pubkey, owner_pubkey, attestation_json)
         VALUES (?, ?, ?, 'nexus_handoff_submit', ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?)`,
      ).run(
        provenance.receiptId,
        handoffId,
        provenance.toolCallId,
        provenance.source,
        provenance.missionId,
        provenance.sessionId,
        provenance.workerIncarnationId ?? null,
        provenance.authoritySha256,
        provenance.worktreeHeadSha ?? null,
        provenance.rawPayloadSha256,
        provenance.logicalOperationKey,
        provenance.issuedAt,
        chainLink.chainSeq,
        chainLink.prevReceiptHash,
        chainLink.chainHash,
        attestation.agentPubkey,
        attestation.ownerPubkey,
        JSON.stringify(attestation.credential),
      );
      return;
    }
    db.prepare(
      `INSERT INTO handoff_mcp_receipts
         (receipt_id, handoff_id, tool_call_id, tool_name, source,
          mission_id, session_id, worker_incarnation_id,
          authority_sha256, worktree_head_sha, raw_payload_sha256,
          logical_operation_key, issued_at,
          chain_seq, prev_receipt_hash, chain_hash)
       VALUES (?, ?, ?, 'nexus_handoff_submit', ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      provenance.receiptId,
      handoffId,
      provenance.toolCallId,
      provenance.source,
      provenance.missionId,
      provenance.sessionId,
      provenance.workerIncarnationId ?? null,
      provenance.authoritySha256,
      provenance.worktreeHeadSha ?? null,
      provenance.rawPayloadSha256,
      provenance.logicalOperationKey,
      provenance.issuedAt,
      chainLink.chainSeq,
      chainLink.prevReceiptHash,
      chainLink.chainHash,
    );
  }

  #nextReceiptChainLinkInTransaction(
    db: Database.Database,
    handoffId: string,
    provenance: HandoffMcpProvenance,
  ): {
    readonly chainSeq: number;
    readonly prevReceiptHash: string | null;
    readonly chainHash: string;
  } {
    const rawHead = db
      .prepare(
        `SELECT chain_seq, chain_hash
           FROM handoff_mcp_receipts
          WHERE mission_id = ? AND chain_seq IS NOT NULL
          ORDER BY chain_seq DESC LIMIT 1`,
      )
      .get(provenance.missionId);
    let head: z.infer<typeof receiptChainHeadRowSchema> | undefined;
    if (rawHead !== undefined) {
      try {
        head = receiptChainHeadRowSchema.parse(rawHead);
      } catch (error) {
        throw new ScopedStoreCorruptionError("handoff receipt chain head", {
          cause: error,
        });
      }
    }
    const chainSeq = (head?.chain_seq ?? 0) + 1;
    const prevReceiptHash = head?.chain_hash ?? null;
    const chainHash = computeChainHash(
      handoffReceiptChainEntry({
        missionId: provenance.missionId,
        seq: chainSeq,
        issuedAt: provenance.issuedAt,
        receiptId: provenance.receiptId,
        handoffId,
        toolCallId: provenance.toolCallId,
        toolName: provenance.toolName,
        source: provenance.source,
        sessionId: provenance.sessionId,
        workerIncarnationId: provenance.workerIncarnationId ?? null,
        authoritySha256: provenance.authoritySha256,
        worktreeHeadSha: provenance.worktreeHeadSha ?? null,
        rawPayloadSha256: provenance.rawPayloadSha256 ?? null,
        logicalOperationKey: provenance.logicalOperationKey ?? null,
      }),
      prevReceiptHash,
    );
    return { chainSeq, prevReceiptHash, chainHash };
  }

  /**
   * Rebuild and verify every chained receipt for one mission from storage.
   * Legacy rows are deliberately excluded because migration 029 could not
   * safely invent their historical chain position. A malformed chained row
   * is corruption, not an ordinary missing handoff.
   */
  #verifyReceiptChainForMission(
    db: Database.Database,
    missionId: string,
  ): ReceiptChainVerification {
    const rawRows = db
      .prepare(
        `SELECT receipt_id, handoff_id, tool_call_id, tool_name, source,
                mission_id, session_id, worker_incarnation_id,
                authority_sha256, worktree_head_sha, raw_payload_sha256,
                logical_operation_key, issued_at,
                chain_seq, prev_receipt_hash, chain_hash
           FROM handoff_mcp_receipts
          WHERE mission_id = ? AND chain_seq IS NOT NULL
          ORDER BY chain_seq ASC`,
      )
      .all(missionId);
    if (rawRows.length === 0) return { status: "empty" };

    const entries: ChainedReceiptEntry[] = [];
    for (const raw of rawRows) {
      let row: z.infer<typeof mcpReceiptRowSchema>;
      try {
        row = mcpReceiptRowSchema.parse(raw);
      } catch (error) {
        throw new ScopedStoreCorruptionError("handoff receipt chain row", {
          cause: error,
        });
      }
      if (row.chain_seq === null || row.chain_hash === null) {
        throw new ScopedStoreCorruptionError("handoff receipt chain columns");
      }
      entries.push({
        ...handoffReceiptChainEntry({
          missionId: row.mission_id,
          seq: row.chain_seq,
          issuedAt: row.issued_at,
          receiptId: row.receipt_id,
          handoffId: row.handoff_id,
          toolCallId: row.tool_call_id,
          toolName: row.tool_name,
          source: row.source,
          sessionId: row.session_id,
          workerIncarnationId: row.worker_incarnation_id,
          authoritySha256: row.authority_sha256,
          worktreeHeadSha: row.worktree_head_sha,
          rawPayloadSha256: row.raw_payload_sha256,
          logicalOperationKey: row.logical_operation_key,
        }),
        chainHash: row.chain_hash,
        prevReceiptHash: row.prev_receipt_hash,
      });
    }
    return verifyChain(entries, { requireGenesis: true });
  }

  /** Read-only release/audit gate for the complete chained mission trail. */
  verifyReceiptChain(rawMissionId: string): ReceiptChainVerification {
    const missionId = identifierSchema.parse(rawMissionId);
    return this.#verifyReceiptChainForMission(
      this.#binding.readDatabase(),
      missionId,
    );
  }

  #findCommittedPhysicalReceipt(
    db: Database.Database,
    missionId: string,
    sessionId: string,
    workerIncarnationId: string | undefined,
    logicalOperationKey: string,
    incomingRawPayloadSha256: string,
  ): z.infer<typeof mcpReceiptRowSchema> | null {
    // F-239: uma sessão de worker pode ter N handoffs (um por rodada). Vale o
    // recibo MAIS recente — se o handoff dele já foi entregue e o payload é
    // outro, a submissão é rodada nova, não replay.
    const rawRows = db
      .prepare(
        `SELECT receipt_id, handoff_id, tool_call_id, tool_name, source,
                mission_id, session_id, worker_incarnation_id,
                authority_sha256, worktree_head_sha, raw_payload_sha256,
                logical_operation_key, issued_at,
                chain_seq, prev_receipt_hash, chain_hash
         FROM handoff_mcp_receipts
         WHERE mission_id = ? AND session_id = ?
           AND worker_incarnation_id IS ?
         ORDER BY issued_at DESC, rowid DESC LIMIT 1`,
      )
      .all(missionId, sessionId, workerIncarnationId ?? null);
    if (rawRows.length === 0) return null;
    let row: z.infer<typeof mcpReceiptRowSchema>;
    try {
      row = mcpReceiptRowSchema.parse(rawRows[0]);
    } catch (error) {
      throw new ScopedStoreCorruptionError("physical handoff receipt replay", {
        cause: error,
      });
    }
    if (!row.logical_operation_key || !row.raw_payload_sha256) {
      throw new Error(
        "handoff replay recusado: receipt legado não possui identidade canônica verificável",
      );
    }
    if (row.logical_operation_key !== logicalOperationKey) {
      throw new Error(
        "handoff replay recusado: identidade lógica diverge do commit existente",
      );
    }
    const previousHandoff = db
      .prepare(`SELECT delivered, delivery_state FROM handoffs WHERE id = ?`)
      .get(row.handoff_id) as
      | { delivered: 0 | 1; delivery_state: string }
      | undefined;
    const alreadyDelivered =
      previousHandoff !== undefined &&
      (previousHandoff.delivered === 1 ||
        ["submitted", "acknowledged", "consumed"].includes(
          previousHandoff.delivery_state,
        ));
    if (
      alreadyDelivered &&
      row.raw_payload_sha256 !== incomingRawPayloadSha256
    ) {
      // Rodada nova: handoff anterior entregue ao Maestro e payload diferente.
      return null;
    }
    return row;
  }

  #assertExactPhysicalReplay(
    db: Database.Database,
    committedReceipt: z.infer<typeof mcpReceiptRowSchema>,
    input: z.infer<typeof submitHandoffInputSchema>,
    artifactsJson: string,
    evidenceIdsJson: string,
    replaySource:
      | "http-mcp"
      | "acp-stdio"
      | "pty-stream"
      | "mission-shim"
      | "omp-rpc-stdio",
    replayWorktreeHeadSha: string | undefined,
    replayRawPayloadSha256: string,
    logicalOperationKey: string,
    transitionDetail: string | undefined,
    taskDispatch: TaskDispatchRecord | undefined,
  ): ScopedHandoff {
    const handoffId = committedReceipt.handoff_id;
    const raw = db.prepare(`${HANDOFF_SELECT} WHERE id = ?`).get(handoffId);
    let row: z.infer<typeof handoffRowSchema>;
    try {
      row = handoffRowSchema.parse(raw);
    } catch (error) {
      throw new ScopedStoreCorruptionError("physical handoff replay", {
        cause: error,
      });
    }
    const exactPayload =
      row.mission_id === input.missionId &&
      row.session_id === input.sessionId &&
      row.worker_incarnation_id === input.workerIncarnationId &&
      row.from_agent === input.fromAgent &&
      row.authority_origin === "agent" &&
      row.status === input.status &&
      row.summary === input.summary &&
      isDeepStrictEqual(
        parseJsonArray(row.artifacts_json, "handoff replay artifacts"),
        parseJsonArray(artifactsJson, "handoff retry artifacts"),
      ) &&
      isDeepStrictEqual(
        parseJsonArray(row.evidence_ids_json, "handoff replay evidence IDs"),
        parseJsonArray(evidenceIdsJson, "handoff retry evidence IDs"),
      );
    const exactPhysicalBoundary =
      replaySource === committedReceipt.source &&
      replayWorktreeHeadSha ===
        (committedReceipt.worktree_head_sha ?? undefined) &&
      replayRawPayloadSha256 === committedReceipt.raw_payload_sha256 &&
      logicalOperationKey === committedReceipt.logical_operation_key;
    const exactDispatchOutcome =
      !taskDispatch ||
      (taskDispatch.handoffId === handoffId &&
        (input.status === "success" ||
          (transitionDetail !== undefined &&
            taskDispatch.lastError === transitionDetail.slice(0, 65_536))));
    if (!exactPayload || !exactPhysicalBoundary || !exactDispatchOutcome) {
      // F-239: quem chega aqui tem o handoff anterior AINDA não entregue —
      // payload divergente pendente é recusa com mensagem própria.
      if (
        replayRawPayloadSha256 !== committedReceipt.raw_payload_sha256
      ) {
        throw new Error(
          "handoff recusado: a entrega anterior deste pane ainda não chegou ao Maestro — aguarde a entrega (ou repita o payload idêntico); nova rodada só depois de entregue",
        );
      }
      throw new Error(
        "handoff replay recusado: payload raw, origem física ou estado diverge do commit existente",
      );
    }
    return this.#fromRow(row, db);
  }

  #reservePhysicalHandoffSpendInTransaction(
    db: Database.Database,
    missionId: string,
  ): void {
    const row = db
      .prepare(
        `SELECT status, intent_state, intent_version, intent_contract_json
         FROM missions WHERE id = ?`,
      )
      .get(missionId) as
      | {
          readonly status: string;
          readonly intent_state: string;
          readonly intent_version: number;
          readonly intent_contract_json: string | null;
        }
      | undefined;
    if (!row || !row.intent_contract_json) {
      throw new Error(
        "approval_required: physical handoff mission authority is unavailable",
      );
    }
    let contract: z.infer<typeof missionIntentContractSchema>;
    try {
      contract = missionIntentContractSchema.parse(
        JSON.parse(row.intent_contract_json),
      );
    } catch (error) {
      throw new ScopedStoreCorruptionError(
        "physical handoff mission intent contract",
        { cause: error },
      );
    }
    if (
      row.status !== "running" ||
      !PHYSICAL_HANDOFF_SPEND_INTENT_STATES.has(row.intent_state) ||
      !hasCurrentApprovedDispatchContract({
        intentContract: contract,
        intentVersion: row.intent_version,
      })
    ) {
      throw new Error(
        "approval_required: physical handoff mission authority changed before commit",
      );
    }
    const reserved = reserveEffectfulSpend(
      contract,
      "nexus_handoff_submit",
    );
    if (!reserved.ok) throw new Error(reserved.error);
    const updated = db
      .prepare(
        `UPDATE missions
         SET intent_contract_json = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND intent_state = ?
           AND intent_version = ? AND intent_contract_json = ?`,
      )
      .run(
        JSON.stringify(reserved.contract),
        this.#binding.now(),
        missionId,
        row.intent_state,
        row.intent_version,
        row.intent_contract_json,
      );
    if (updated.changes !== 1) {
      throw new Error(
        "physical handoff budget reservation lost mission authority CAS",
      );
    }
  }

  #emitDispatchChange(): void {
    for (const listener of [...this.#dispatchChangeListeners]) {
      try {
        listener(this.#binding.coordinates);
      } catch (error) {
        console.warn("[orch] handoff dispatch listener threw:", error);
      }
    }
  }

  #assertCorrelatedMcpAuditIntent(
    db: Database.Database,
    receipt: {
      readonly source:
        | "http-mcp"
        | "acp-stdio"
        | "pty-stream"
        | "mission-shim"
        | "omp-rpc-stdio";
      readonly toolCallId: string;
      readonly missionId: string;
      readonly sessionId: string;
    },
  ): void {
    const rows = db
      .prepare(
        `SELECT payload_json
         FROM audit_events
         WHERE mission_id = ?
           AND actor = ?
           AND action = 'nexus_handoff_submit'
           AND outcome = 'intent'`,
      )
      .all(receipt.missionId, receipt.sessionId) as Array<{
      payload_json: string;
    }>;
    const matches = rows.filter((row) => {
      try {
        const payload = mcpAuditIntentPayloadSchema.parse(
          parseBoundedJson(row.payload_json, "handoff MCP audit intent"),
        );
        return (
          payload.project_id === this.#binding.scope.projectId &&
          payload.checkout_id === this.#binding.scope.checkoutId &&
          payload.source === receipt.source &&
          payload.invocation_id === receipt.toolCallId
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) {
      throw new Error(
        "handoff_provenance: exact durable physical agent audit intent is required",
      );
    }
  }

  list(rawFilter: ListHandoffsFilter = {}): ScopedHandoff[] {
    const filter = z
      .object({
        missionId: identifierSchema.nullable().optional(),
        includeDelivered: z.boolean().optional(),
        ids: z.array(identifierSchema).max(256).optional(),
        sessionIds: z.array(identifierSchema).max(256).optional(),
      })
      .strict()
      .parse(rawFilter);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.missionId === null) {
      clauses.push("mission_id IS NULL");
    } else if (filter.missionId !== undefined) {
      clauses.push("mission_id = ?");
      params.push(filter.missionId);
    }
    if (filter.ids !== undefined && filter.ids.length > 0) {
      const placeholders = filter.ids.map(() => "?").join(",");
      clauses.push(`id IN (${placeholders})`);
      params.push(...filter.ids);
    }
    if (filter.sessionIds !== undefined && filter.sessionIds.length > 0) {
      const placeholders = filter.sessionIds.map(() => "?").join(",");
      clauses.push(`session_id IN (${placeholders})`);
      params.push(...filter.sessionIds);
    }
    if (!filter.includeDelivered) clauses.push("delivered = 0");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const db = this.#binding.readDatabase();
    const rows = db
      .prepare(
        `${HANDOFF_SELECT} ${where}
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...params);
    return rows.map((row) => this.#fromRow(row, db));
  }

  /**
   * Bounded durable outbox scan for live missions. Accepted-but-not-consumed
   * rows are included while their mission is running so a crash between
   * transport acceptance and topology-specific settlement can be reconciled.
   * Terminal mission history never enters the one-second loop.
   */
  listDeliveryOutboxCandidates(): ScopedHandoff[] {
    const db = this.#binding.readDatabase();
    const rows = db
      .prepare(
        `${HANDOFF_SELECT}
         WHERE EXISTS (
                 SELECT 1 FROM missions AS mission
                 WHERE mission.id = handoffs.mission_id
                   AND mission.status = 'running'
               )
           AND (
             (delivered = 0 AND delivery_state = 'queued')
             OR (
               delivered = 1
               AND delivery_state IN ('submitted', 'acknowledged')
               AND EXISTS (
                 SELECT 1
                 FROM handoff_delivery_attempts AS attempt
                 WHERE attempt.handoff_id = handoffs.id
                   AND attempt.mission_id = handoffs.mission_id
                   AND attempt.state = 'accepted'
                   AND attempt.accepted_at IS NOT NULL
               )
              )
           )
         ORDER BY created_at ASC, id ASC`,
      )
      .all();
    return rows.map((row) => this.#fromRow(row, db));
  }

  get(rawId: string): ScopedHandoff | null {
    const id = identifierSchema.parse(rawId);
    const db = this.#binding.readDatabase();
    const row = db.prepare(`${HANDOFF_SELECT} WHERE id = ?`).get(id);
    return row ? this.#fromRow(row, db) : null;
  }

  markDelivered(rawId: string): boolean {
    const delivered = this.markSubmitted(rawId);
    if (delivered) {
      emitAppEvent('handoff.delivered', { handoffId: rawId.slice(0, 128) });
    }
    return delivered;
  }

  /**
   * Retire inferred failures only after the physical receipt and dispatch CAS.
   * This runs in their transaction; immutable outcomes and receipts stay intact.
   */
  #consumeProvisionalWorkerHandoffs(
    db: Database.Database,
    handoff: ScopedHandoff,
  ): void {
    if (
      handoff.status !== "success" ||
      !handoff.mcpProvenance ||
      !handoff.missionId ||
      !handoff.sessionId ||
      !handoff.workerIncarnationId
    ) {
      return;
    }
    db.prepare(
      `UPDATE handoffs
         SET delivery_state = 'consumed',
             acknowledged_at = COALESCE(acknowledged_at, ?),
             consumed_at = ?
         WHERE mission_id = ? AND session_id = ?
           AND worker_incarnation_id = ?
           AND from_agent IN (?, ?)
           AND status IN ('blocked', 'failed')
           AND authority_origin = 'agent'
           AND id != ?
           AND created_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM handoff_mcp_receipts receipt
             WHERE receipt.handoff_id = handoffs.id
           )
           AND delivery_state IN ('queued', 'submitted', 'acknowledged')`,
    )
      .run(
        handoff.createdAt,
        handoff.createdAt,
        handoff.missionId,
        handoff.sessionId,
        handoff.workerIncarnationId,
        ...PROVISIONAL_WORKER_HANDOFF_AUTHORS,
        handoff.id,
        handoff.createdAt,
      );
  }


  markSubmitted(rawId: string): boolean {
    const id = identifierSchema.parse(rawId);
    const now = this.#binding.now();
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE handoffs
         SET delivered = 1, delivery_state = 'submitted', submitted_at = ?
         WHERE id = ? AND delivery_state = 'queued'`,
      )
      .run(now, id);
    if (result.changes === 0) return false;
    this.#binding.emitChange();
    return true;
  }

  /**
   * TTL de stalled (paridade Overclock: estados de morte nomeados). Entrega
   * em voo (queued/submitted) sem veredito terminal e sem movimento há mais
   * de `olderThanMs` ganha status `stalled` — continua unsettled (não fecha
   * missão sozinha), mas fica VISÍVEL para cobrança/doctor em vez de pendente
   * anônima para sempre. Retorna os ids SOLICITADOS (o WHERE pode consumir
   * menos se algum virou terminal na corrida).
   */
  markStalled(rawIds: readonly string[]): string[] {
    const ids = rawIds.map((raw) => identifierSchema.parse(raw));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE handoffs
         SET status = 'stalled'
         WHERE id IN (${placeholders})
           AND delivery_state IN ('queued','submitted')
           AND status NOT IN ('success','partial','failed','blocked','stalled')`,
      )
      .run(...ids);
    if (result.changes === 0) return [];
    this.#binding.emitChange();
    return ids;
  }

  reserveDeliveryAttempt(input: {
    readonly handoffId: string;
    readonly missionId: string;
    readonly orchestratorSessionId: string;
    readonly maxAttempts: number;
  }): HandoffDeliveryAttempt {
    const handoffId = identifierSchema.parse(input.handoffId);
    const missionId = identifierSchema.parse(input.missionId);
    const sessionId = identifierSchema.parse(input.orchestratorSessionId);
    const maxAttempts = z
      .number()
      .int()
      .positive()
      .max(16)
      .parse(input.maxAttempts);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const attempt = db
      .transaction(() => {
        const handoff = db
          .prepare(
            `SELECT h.mission_id, h.delivery_state, m.orch_session_id
         FROM handoffs AS h
         JOIN missions AS m ON m.id = h.mission_id
         WHERE h.id = ?`,
          )
          .get(handoffId) as
          | {
              mission_id: string | null;
              delivery_state: string;
              orch_session_id: string | null;
            }
          | undefined;
        if (!handoff || handoff.mission_id !== missionId) {
          throw new Error("handoff delivery scope/mission mismatch");
        }
        if (handoff.orch_session_id !== sessionId) {
          throw new Error("handoff delivery orchestrator session is stale");
        }
        if (handoff.delivery_state !== "queued") {
          throw new Error(
            `handoff delivery is already ${handoff.delivery_state}`,
          );
        }
        // A process restart loses the in-memory acceptance observer. Preserve
        // the attempt as failed evidence before reserving the bounded retry.
        db.prepare(
          `UPDATE handoff_delivery_attempts
         SET state = 'failed', failed_at = ?, failure_code = ?
         WHERE handoff_id = ? AND state IN ('reserved', 'pasted')`,
        ).run(now, "acceptance_observer_lost", handoffId);
        const counters = db
          .prepare(
            `SELECT
               COALESCE(MAX(attempt_no), 0) AS latest_attempt_no,
               COUNT(CASE WHEN orchestrator_session_id = ? THEN 1 END)
                 AS session_attempts
             FROM handoff_delivery_attempts
             WHERE handoff_id = ?`,
          )
          .get(sessionId, handoffId) as {
          latest_attempt_no: number;
          session_attempts: number;
        };
        if (counters.session_attempts >= maxAttempts) {
          throw new Error("handoff delivery attempt budget exhausted");
        }
        const attemptNo = counters.latest_attempt_no + 1;
        const id = this.#binding.makeId("handoff-delivery");
        db.prepare(
          `INSERT INTO handoff_delivery_attempts (
           id, handoff_id, mission_id, orchestrator_session_id,
           attempt_no, state, started_at
         ) VALUES (?, ?, ?, ?, ?, 'reserved', ?)`,
        ).run(id, handoffId, missionId, sessionId, attemptNo, now);
        return this.#deliveryAttemptFromDatabase(db, id);
      })
      .immediate();
    if (!attempt) throw new Error("handoff delivery attempt was not persisted");
    this.#binding.emitChange();
    return attempt;
  }

  markDeliveryAttemptPasted(input: {
    readonly attemptId: string;
    readonly handoffId: string;
    readonly acceptDeadlineAt: number;
  }): HandoffDeliveryAttempt {
    const attemptId = identifierSchema.parse(input.attemptId);
    const handoffId = identifierSchema.parse(input.handoffId);
    const deadline = z
      .number()
      .int()
      .nonnegative()
      .parse(input.acceptDeadlineAt);
    const now = this.#binding.now();
    if (deadline < now)
      throw new Error("handoff acceptance deadline is already expired");
    const db = this.#binding.writeDatabase();
    const result = db
      .prepare(
        `UPDATE handoff_delivery_attempts
       SET state = 'pasted', accept_deadline_at = ?
       WHERE id = ? AND handoff_id = ? AND state = 'reserved'
         AND orchestrator_session_id = (
           SELECT orch_session_id FROM missions
           WHERE id = handoff_delivery_attempts.mission_id
         )`,
      )
      .run(deadline, attemptId, handoffId);
    if (result.changes !== 1) throw new Error("handoff paste attempt lost CAS");
    const attempt = this.#deliveryAttemptFromDatabase(db, attemptId);
    if (!attempt)
      throw new Error("handoff delivery attempt disappeared after paste");
    this.#binding.emitChange();
    return attempt;
  }

  failDeliveryAttempt(input: {
    readonly attemptId: string;
    readonly handoffId: string;
    readonly failureCode: string;
  }): boolean {
    const attemptId = identifierSchema.parse(input.attemptId);
    const handoffId = identifierSchema.parse(input.handoffId);
    const failureCode = identifierSchema.parse(input.failureCode);
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE handoff_delivery_attempts
       SET state = 'failed', failed_at = ?, failure_code = ?
       WHERE id = ? AND handoff_id = ? AND state IN ('reserved', 'pasted')`,
      )
      .run(this.#binding.now(), failureCode, attemptId, handoffId);
    if (result.changes > 0) this.#binding.emitChange();
    return result.changes === 1;
  }

  acceptDeliveryAttempt(input: {
    readonly attemptId: string;
    readonly handoffId: string;
  }): boolean {
    const attemptId = identifierSchema.parse(input.attemptId);
    const handoffId = identifierSchema.parse(input.handoffId);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const accepted = db
      .transaction(() => {
        const result = db
          .prepare(
            `UPDATE handoff_delivery_attempts
         SET state = 'accepted', accepted_at = ?
         WHERE id = ? AND handoff_id = ? AND state = 'pasted'
           AND accept_deadline_at >= ?
           AND orchestrator_session_id = (
             SELECT orch_session_id FROM missions
             WHERE id = handoff_delivery_attempts.mission_id
           )`,
          )
          .run(now, attemptId, handoffId, now);
        if (result.changes !== 1) return false;
        const handoff = db
          .prepare(
            `UPDATE handoffs
         SET delivered = 1, delivery_state = 'submitted', submitted_at = ?
         WHERE id = ? AND delivery_state = 'queued'`,
          )
          .run(now, handoffId);
        if (handoff.changes !== 1) {
          throw new Error("handoff submission lost delivery-attempt CAS");
        }
        return true;
      })
      .immediate();
    if (accepted) this.#binding.emitChange();
    return accepted;
  }

  listDeliveryAttempts(rawHandoffId: string): HandoffDeliveryAttempt[] {
    const handoffId = identifierSchema.parse(rawHandoffId);
    const db = this.#binding.readDatabase();
    return db
      .prepare(
        `SELECT * FROM handoff_delivery_attempts
       WHERE handoff_id = ? ORDER BY attempt_no ASC`,
      )
      .all(handoffId)
      .map((row) => this.#deliveryAttemptFromRow(row));
  }

  /**
   * List = recibo só do que JÁ foi colado no PTY (`submitted`).
   * `queued` continua na fila do idle-delivery: listar não é receber.
   * Campo 24/08: o Maestro via `queued` no list, o ack comia a fila, e o
   * paste nunca descia — "vou esperar o idle-delivery" para sempre.
   * O loop 0.62/0.63 era re-paste de `submitted`; esse continua coberto.
   * `consumed` continua exclusivo do nexus_handoff_ack.
   */
  acknowledgeSeenByOrchestratorList(rawMissionId: string): number {
    const missionId = identifierSchema.parse(rawMissionId);
    const now = this.#binding.now();
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE handoffs
       SET delivery_state = 'acknowledged',
           delivered = 1,
           acknowledged_at = ?,
           submitted_at = COALESCE(submitted_at, ?)
       WHERE mission_id = ? AND delivery_state = 'submitted'`,
      )
      .run(now, now, missionId);
    if (result.changes > 0) this.#binding.emitChange();
    return result.changes;
  }

  acknowledgeMission(rawMissionId: string): number {
    const missionId = identifierSchema.parse(rawMissionId);
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE handoffs
       SET delivery_state = 'acknowledged', acknowledged_at = ?
       WHERE mission_id = ? AND delivery_state = 'submitted'`,
      )
      .run(this.#binding.now(), missionId);
    if (result.changes > 0) this.#binding.emitChange();
    return result.changes;
  }

  markConsumed(rawId: string, rawMissionId: string): boolean {
    const id = identifierSchema.parse(rawId);
    const missionId = identifierSchema.parse(rawMissionId);
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE handoffs
       SET delivery_state = 'consumed',
           acknowledged_at = COALESCE(acknowledged_at, ?), consumed_at = ?
       WHERE id = ? AND mission_id = ?
         AND delivery_state IN ('submitted', 'acknowledged')`,
      )
      .run(this.#binding.now(), this.#binding.now(), id, missionId);
    if (result.changes === 0) return false;
    this.#binding.emitChange();
    emitAppEvent('handoff.consumed', {
      handoffId: id.slice(0, 128),
      missionId: missionId.slice(0, 128),
    });
    return true;
  }

  /**
   * Explicit orchestrator consumption ACK bound to the exact accepted
   * handoff-delivery attempt. Generic/main-owned `markConsumed` remains for
   * legacy non-scheduler flows, but cannot satisfy verified-plan completion.
   */
  markConsumedAfterAcceptedDelivery(
    rawId: string,
    rawMissionId: string,
    rawOrchestratorSessionId: string,
  ): boolean {
    const id = identifierSchema.parse(rawId);
    const missionId = identifierSchema.parse(rawMissionId);
    const orchestratorSessionId = identifierSchema.parse(
      rawOrchestratorSessionId,
    );
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const outcome = db
      .transaction(() => {
        const mission = db
          .prepare(`SELECT orch_session_id FROM missions WHERE id = ?`)
          .get(missionId) as
          { readonly orch_session_id: string | null } | undefined;
        if (mission?.orch_session_id !== orchestratorSessionId) return 0;
        const attempts = db
          .prepare(
            `SELECT id, accepted_at
             FROM handoff_delivery_attempts
             WHERE handoff_id = ? AND mission_id = ?
               AND orchestrator_session_id = ?
               AND state = 'accepted' AND accepted_at IS NOT NULL
             ORDER BY accepted_at DESC, id DESC
             LIMIT 2`,
          )
          .all(id, missionId, orchestratorSessionId) as Array<{
          readonly id: string;
          readonly accepted_at: number;
        }>;
        if (attempts.length !== 1 || attempts[0]!.accepted_at > now) {
          return 0;
        }
        const current = db
          .prepare(
            `SELECT delivery_state, consumed_by_session,
                    consumed_delivery_attempt_id
             FROM handoffs WHERE id = ? AND mission_id = ?`,
          )
          .get(id, missionId) as
          | {
              readonly delivery_state: string;
              readonly consumed_by_session: string | null;
              readonly consumed_delivery_attempt_id: string | null;
            }
          | undefined;
        if (
          current?.delivery_state === "consumed" &&
          current.consumed_by_session === orchestratorSessionId &&
          current.consumed_delivery_attempt_id === attempts[0]!.id
        ) {
          return 2;
        }
        const result = db
          .prepare(
            `UPDATE handoffs
             SET delivery_state = 'consumed',
                 acknowledged_at = COALESCE(acknowledged_at, ?),
                 consumed_at = ?,
                 consumed_by_session = ?,
                 consumed_delivery_attempt_id = ?
             WHERE id = ? AND mission_id = ? AND delivered = 1
               AND (
                 delivery_state IN ('submitted', 'acknowledged')
                 OR (
                   delivery_state = 'consumed'
                   AND consumed_by_session IS NULL
                   AND consumed_delivery_attempt_id IS NULL
                 )
               )`,
          )
          .run(now, now, orchestratorSessionId, attempts[0]!.id, id, missionId);
        return result.changes === 1 ? 1 : 0;
      })
      .immediate();
    if (outcome === 1) this.#binding.emitChange();
    return outcome > 0;
  }

  /**
   * Production ACK path. Unlike the compatibility method above, this persists
   * an immutable receipt for the exact authenticated Maestro tool call and its
   * append-only audit intent in the same transaction as consumption.
   */
  markConsumedFromPhysicalAck(
    input: {
      readonly handoffId: string;
      readonly missionId: string;
      readonly orchestratorSessionId: string;
    },
    physicalReceipt: AgentTransportPhysicalReceipt,
  ): boolean {
    const id = identifierSchema.parse(input.handoffId);
    const missionId = identifierSchema.parse(input.missionId);
    const orchestratorSessionId = identifierSchema.parse(
      input.orchestratorSessionId,
    );
    const outcome = markHandoffConsumedFromPhysicalAck(
      this.#binding,
      {
        handoffId: id,
        missionId,
        orchestratorSessionId,
      },
      physicalReceipt,
    );
    if (outcome === "created") {
      this.#binding.emitChange();
      this.#retainAcknowledgedHandoffMemory(id, missionId);
    }
    return outcome !== null;
  }

  /**
   * F-703: a entrega de sucesso confirmada pelo Maestro vira memória do
   * projeto. A tarefa do plano selado já foi retida no aceite (mesmo handoff
   * na fila de despacho) e fica de fora. Assíncrono e best-effort: a
   * destilação é uma chamada ao Jev e nunca segura o ACK.
   */
  #retainAcknowledgedHandoffMemory(id: string, missionId: string): void {
    try {
      const handoff = this.get(id);
      if (handoff?.status !== "success" || !handoff.summary?.trim()) return;
      const dispatched = this.#binding
        .readDatabase()
        .prepare(`SELECT 1 FROM task_dispatch_queue WHERE handoff_id = ? LIMIT 1`)
        .get(id);
      if (dispatched) return;
      void retainAcknowledgedHandoffMemoryBestEffort(
        this.#binding.scope,
        {
          handoffId: id,
          missionId,
          status: "success",
          ...(handoff.mcpProvenance
            ? { mcpReceiptId: handoff.mcpProvenance.receiptId }
            : {}),
        },
        handoff.summary,
      ).catch(() => {});
    } catch {
      // Memória é contabilidade derivada: nunca desfaz nem trava o ACK.
    }
  }

  hasTrustedFromSession(
    rawSessionId: string,
    rawWorkerIncarnationId?: string,
  ): boolean {
    const sessionId = identifierSchema.parse(rawSessionId);
    const workerIncarnationId =
      rawWorkerIncarnationId === undefined
        ? undefined
        : identifierSchema.parse(rawWorkerIncarnationId);
    const db = this.#binding.readDatabase();
    const rows = db
      .prepare(
        `${HANDOFF_SELECT}
         WHERE session_id = ? AND evidence_trusted = 1
         ORDER BY created_at DESC, id DESC`,
      )
      .all(sessionId);
    return rows.some((row) => {
      const handoff = this.#fromRow(row, db);
      return (
        handoff.evidenceTrust === "nexus-trusted" &&
        (workerIncarnationId === undefined ||
          handoff.workerIncarnationId === workerIncarnationId)
      );
    });
  }

  /** Compatibility alias with fail-closed trusted semantics. */
  hasFromSession(rawSessionId: string): boolean {
    return this.hasTrustedFromSession(rawSessionId);
  }

  #deliveryAttemptFromDatabase(
    db: Database.Database,
    id: string,
  ): HandoffDeliveryAttempt | null {
    const row = db
      .prepare(`SELECT * FROM handoff_delivery_attempts WHERE id = ?`)
      .get(id);
    return row ? this.#deliveryAttemptFromRow(row) : null;
  }

  #deliveryAttemptFromRow(raw: unknown): HandoffDeliveryAttempt {
    let row: z.infer<typeof deliveryAttemptRowSchema>;
    try {
      row = deliveryAttemptRowSchema.parse(raw);
    } catch (error) {
      throw new ScopedStoreCorruptionError("handoff delivery attempt", {
        cause: error,
      });
    }
    return Object.freeze({
      id: row.id,
      handoffId: row.handoff_id,
      missionId: row.mission_id,
      orchestratorSessionId: row.orchestrator_session_id,
      attemptNo: row.attempt_no,
      state: row.state,
      startedAt: row.started_at,
      acceptDeadlineAt: row.accept_deadline_at ?? undefined,
      acceptedAt: row.accepted_at ?? undefined,
      failedAt: row.failed_at ?? undefined,
      failureCode: row.failure_code ?? undefined,
    });
  }

  #currentBinding(
    db: Database.Database,
    missionId: string,
  ): { binding: EvidenceBinding; revision: number } | null {
    const rawRow = db
      .prepare(
        `SELECT c.contract_hash, c.context_revision,
                w.revision AS workflow_revision, w.workflow_json
         FROM mission_contracts c
         JOIN workflow_states w ON w.mission_id = c.mission_id
         WHERE c.mission_id = ?`,
      )
      .get(missionId);
    if (!rawRow) return null;
    let row: z.infer<typeof currentWorkflowRowSchema>;
    try {
      row = currentWorkflowRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError("handoff workflow binding", {
        cause: error,
      });
    }
    const workflow = asCorruption("handoff workflow state", () =>
      parseWorkflowState(
        parseBoundedJson(row.workflow_json, "handoff workflow state"),
      ),
    );
    if (
      workflow.binding.projectId !== this.scope.projectId ||
      workflow.binding.checkoutId !== this.scope.checkoutId ||
      workflow.binding.missionId !== missionId ||
      workflow.binding.contractHash !== row.contract_hash ||
      workflow.binding.contextHash !== row.context_revision ||
      workflow.revision !== row.workflow_revision
    ) {
      throw new ScopedStoreCorruptionError("handoff workflow binding");
    }
    return { binding: workflow.binding, revision: workflow.revision };
  }

  #resolveEvidence(
    db: Database.Database,
    missionId: string | undefined,
    evidenceIds: readonly string[],
  ): ResolvedEvidence {
    if (evidenceIds.length === 0) return { evidenceIds: [] };
    if (!missionId) {
      throw new Error("trusted handoff evidence requires missionId");
    }
    const current = this.#currentBinding(db, missionId);
    if (!current) {
      throw new Error(
        "handoff evidence requires a mission with a frozen current workflow",
      );
    }
    for (const evidenceId of evidenceIds) {
      const sensorRow = db
        .prepare("SELECT evidence_json FROM sensor_evidence WHERE id = ?")
        .get(evidenceId) as { evidence_json: string } | undefined;
      if (sensorRow) {
        const evidence = asCorruption("sensor evidence", () =>
          parseTrustedEvidence(
            parseBoundedJson(sensorRow.evidence_json, "sensor evidence"),
          ),
        );
        if (evidence.id !== evidenceId) {
          throw new ScopedStoreCorruptionError("sensor evidence identity");
        }
        assertEvidenceMatches(evidenceId, evidence, current.binding);
        continue;
      }

      const reviewId = evidenceId.startsWith("review:")
        ? evidenceId.slice("review:".length)
        : "";
      const reviewRow = reviewId
        ? (db
            .prepare(
              "SELECT report_json FROM review_reports WHERE review_id = ?",
            )
            .get(reviewId) as { report_json: string } | undefined)
        : undefined;
      if (!reviewRow) {
        throw new Error(`trusted evidence "${evidenceId}" not found`);
      }
      const report = asCorruption("review evidence", () =>
        parseReviewReport(
          parseBoundedJson(reviewRow.report_json, "review evidence"),
        ),
      );
      if (`review:${report.reviewId}` !== evidenceId) {
        throw new ScopedStoreCorruptionError("review evidence identity");
      }
      assertEvidenceMatches(evidenceId, report.binding, current.binding);
    }
    return {
      evidenceIds: [...evidenceIds],
      binding: toHandoffBinding(current.binding, current.revision),
    };
  }

  #fromRow(rawRow: unknown, db: Database.Database): ScopedHandoff {
    let row: z.infer<typeof handoffRowSchema>;
    try {
      row = handoffRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError("handoff", { cause: error });
    }
    let evidenceIds: string[];
    try {
      evidenceIds = evidenceIdsSchema.parse(
        parseJsonArray(row.evidence_ids_json, "handoff evidence IDs"),
      );
    } catch (error) {
      if (error instanceof ScopedStoreCorruptionError) throw error;
      throw new ScopedStoreCorruptionError("handoff evidence IDs", {
        cause: error,
      });
    }
    const bindingFields = [
      row.context_revision,
      row.contract_hash,
      row.base_sha,
      row.head_sha,
      row.diff_hash,
      row.workflow_revision,
    ];
    const wasTrusted = row.evidence_trusted === 1;
    if (
      (wasTrusted &&
        (!row.mission_id ||
          evidenceIds.length === 0 ||
          bindingFields.some((value) => value === null))) ||
      (!wasTrusted &&
        (evidenceIds.length > 0 ||
          bindingFields.some((value) => value !== null)))
    ) {
      throw new ScopedStoreCorruptionError("handoff evidence binding");
    }
    const hasConsumedSession = row.consumed_by_session !== null;
    const hasConsumedAttempt = row.consumed_delivery_attempt_id !== null;
    if (
      hasConsumedSession !== hasConsumedAttempt ||
      (hasConsumedSession && row.delivery_state !== "consumed")
    ) {
      throw new ScopedStoreCorruptionError("handoff consumption authority");
    }
    const evidenceBinding = wasTrusted
      ? Object.freeze({
          missionId: row.mission_id!,
          contextRevision: row.context_revision!,
          contractHash: row.contract_hash!,
          baseSha: row.base_sha!,
          headSha: row.head_sha!,
          diffHash: row.diff_hash!,
          workflowRevision: row.workflow_revision!,
        })
      : undefined;
    let isCurrent = false;
    if (wasTrusted && evidenceBinding) {
      try {
        const resolved = this.#resolveEvidence(
          db,
          evidenceBinding.missionId,
          evidenceIds,
        );
        isCurrent =
          resolved.binding !== undefined &&
          sameHandoffBinding(resolved.binding, evidenceBinding);
      } catch (error) {
        if (error instanceof ScopedStoreCorruptionError) throw error;
        isCurrent = false;
      }
    }
    const mcpProvenance = this.#mcpProvenanceFromDatabase(db, row.id);
    if (
      mcpProvenance &&
      (mcpProvenance.missionId !== row.mission_id ||
        mcpProvenance.sessionId !== row.session_id ||
        (mcpProvenance.workerIncarnationId ?? null) !==
          row.worker_incarnation_id)
    ) {
      throw new ScopedStoreCorruptionError(
        "handoff MCP provenance authority binding",
      );
    }
    return {
      id: row.id,
      missionId: row.mission_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      workerIncarnationId: row.worker_incarnation_id ?? undefined,
      fromAgent: row.from_agent ?? undefined,
      authorityOrigin: row.authority_origin,
      mcpProvenance,
      status: row.status,
      claimTrust: "untrusted",
      summary: row.summary,
      artifacts: [
        ...parseJsonArray(row.artifacts_json, "handoff artifacts"),
        ...getHandoffAttachments(row.id),
      ],
      evidenceIds,
      evidenceTrust: !wasTrusted
        ? "unverified"
        : isCurrent
          ? "nexus-trusted"
          : "stale",
      evidenceBinding,
      delivered: row.delivered === 1,
      deliveryState: row.delivery_state,
      submittedAt: row.submitted_at ?? undefined,
      acknowledgedAt: row.acknowledged_at ?? undefined,
      consumedAt: row.consumed_at ?? undefined,
      consumedBySession: row.consumed_by_session ?? undefined,
      consumedDeliveryAttemptId:
        row.consumed_delivery_attempt_id ?? undefined,
      createdAt: row.created_at,
      ...this.#binding.coordinates,
    };
  }

  #mcpProvenanceFromDatabase(
    db: Database.Database,
    handoffId: string,
  ): HandoffMcpProvenance | undefined {
    const raw = db
      .prepare(
        `SELECT receipt_id, handoff_id, tool_call_id, tool_name, source,
                mission_id, session_id, worker_incarnation_id,
                authority_sha256, worktree_head_sha, raw_payload_sha256,
                logical_operation_key, issued_at,
                chain_seq, prev_receipt_hash, chain_hash
         FROM handoff_mcp_receipts WHERE handoff_id = ?`,
      )
      .get(handoffId);
    if (!raw) return undefined;
    let row: z.infer<typeof mcpReceiptRowSchema>;
    try {
      row = mcpReceiptRowSchema.parse(raw);
    } catch (error) {
      throw new ScopedStoreCorruptionError("handoff MCP provenance", {
        cause: error,
      });
    }
    const chainVerification = this.#verifyReceiptChainForMission(
      db,
      row.mission_id,
    );
    if (
      chainVerification.status !== "valid" &&
      chainVerification.status !== "empty"
    ) {
      throw new ScopedStoreCorruptionError("handoff receipt chain", {
        cause: new Error(JSON.stringify(chainVerification)),
      });
    }
    if (row.handoff_id !== handoffId) {
      throw new ScopedStoreCorruptionError("handoff MCP provenance identity");
    }
    return Object.freeze({
      receiptId: row.receipt_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      source: row.source,
      missionId: row.mission_id,
      sessionId: row.session_id,
      workerIncarnationId: row.worker_incarnation_id ?? undefined,
      authoritySha256: row.authority_sha256,
      worktreeHeadSha: row.worktree_head_sha ?? undefined,
      rawPayloadSha256: row.raw_payload_sha256 ?? undefined,
      logicalOperationKey: row.logical_operation_key ?? undefined,
      issuedAt: row.issued_at,
    });
  }
}

export function createScopedHandoffStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedHandoffStoreOptions = {},
): ScopedHandoffStore {
  return new ScopedHandoffStore(runtimeManager, scope, options);
}
