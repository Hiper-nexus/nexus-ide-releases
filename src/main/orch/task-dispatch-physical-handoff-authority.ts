import { z } from "zod";
import {
  handoffStatusSchema,
  type HandoffStatus,
} from "../../shared/orch-types";
import type { ScopeCoordinates } from "./scoped-store";
import { ScopedStoreCorruptionError } from "./scoped-store";
import type { TaskDispatchDatabase } from "./task-dispatch-persistence";
import { assertStoredHandoffAgentAttestation } from "./agent-attestation-gate";

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"), {
    message: "identifier must not contain NUL",
  });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

const physicalHandoffRowSchema = z
  .object({
    handoff_id: identifierSchema,
    handoff_mission_id: identifierSchema,
    handoff_session_id: identifierSchema,
    handoff_worker_incarnation_id: identifierSchema,
    handoff_from_agent: z.string().min(1).max(256),
    handoff_status: handoffStatusSchema,
    handoff_authority_origin: z.literal("agent"),
    handoff_created_at: z.number().int().nonnegative(),
    receipt_id: identifierSchema,
    tool_call_id: identifierSchema,
    tool_name: z.literal("nexus_handoff_submit"),
    source: z.enum(["http-mcp", "acp-stdio", "pty-stream", "omp-rpc-stdio"]),
    receipt_mission_id: identifierSchema,
    receipt_session_id: identifierSchema,
    receipt_worker_incarnation_id: identifierSchema,
    authority_sha256: sha256Schema,
    worktree_head_sha: commitSchema.nullable(),
    issued_at: z.number().int().nonnegative(),
    agent_pubkey: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    owner_pubkey: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    attestation_json: z.string().nullable(),
  })
  .strict();

const auditIntentPayloadSchema = z
  .object({
    schema: z.literal("nexus.mcp-audit/v1"),
    project_id: identifierSchema,
    checkout_id: identifierSchema,
    source: z.enum(["http-mcp", "acp-stdio", "pty-stream", "omp-rpc-stdio"]),
    invocation_id: identifierSchema,
  })
  .passthrough();

export interface PhysicalTaskHandoffAuthority {
  readonly receiptId: string;
  readonly toolCallId: string;
  readonly source: "http-mcp" | "acp-stdio" | "pty-stream";
  readonly authoritySha256: string;
  readonly worktreeHeadSha?: string;
  readonly auditIntentOccurredAt?: number;
  readonly issuedAt: number;
  readonly status: HandoffStatus;
}

export interface AssertPhysicalTaskHandoffInput {
  readonly missionId: string;
  readonly handoffId: string;
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly workerId?: string;
  readonly noLaterThan: number;
  readonly requireCorrelatedAuditIntent: boolean;
  readonly expectedStatus: "success" | "non-success";
}

function parseAuditPayload(
  raw: string,
): z.infer<typeof auditIntentPayloadSchema> {
  try {
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
      throw new Error("audit payload exceeds 64 KiB");
    }
    return auditIntentPayloadSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new ScopedStoreCorruptionError(
      "task dispatch physical handoff audit intent",
      { cause: error },
    );
  }
}

/**
 * Re-prove the immutable physical worker boundary inside the caller's current
 * SQLite transaction. Neither a handoff row nor a coordinator-supplied
 * integration receipt can stand in for the exact MCP tool invocation.
 */
export function assertPhysicalTaskHandoffAuthority(
  db: TaskDispatchDatabase,
  coordinates: ScopeCoordinates,
  input: AssertPhysicalTaskHandoffInput,
): PhysicalTaskHandoffAuthority {
  const rows = db
    .prepare(
      `SELECT h.id AS handoff_id,
              h.mission_id AS handoff_mission_id,
              h.session_id AS handoff_session_id,
              h.worker_incarnation_id AS handoff_worker_incarnation_id,
              h.from_agent AS handoff_from_agent,
              h.status AS handoff_status,
              h.authority_origin AS handoff_authority_origin,
              h.created_at AS handoff_created_at,
              r.receipt_id, r.tool_call_id, r.tool_name, r.source,
              r.mission_id AS receipt_mission_id,
              r.session_id AS receipt_session_id,
              r.worker_incarnation_id AS receipt_worker_incarnation_id,
              r.authority_sha256, r.worktree_head_sha, r.issued_at,
              r.agent_pubkey, r.owner_pubkey, r.attestation_json
       FROM handoffs AS h
       JOIN handoff_mcp_receipts AS r ON r.handoff_id = h.id
       WHERE h.id = ?`,
    )
    .all(input.handoffId);
  if (rows.length !== 1) {
    throw new Error(
      "task handoff requires exactly one physical nexus_handoff_submit receipt",
    );
  }

  let row: z.infer<typeof physicalHandoffRowSchema>;
  try {
    row = physicalHandoffRowSchema.parse(rows[0]);
  } catch (error) {
    throw new ScopedStoreCorruptionError(
      "task dispatch physical handoff receipt",
      { cause: error },
    );
  }
  if (row.source === "omp-rpc-stdio") {
    throw new Error(
      "task handoff transport omp-rpc-stdio is retired and cannot authorize a dispatch",
    );
  }
  if (
    row.handoff_id !== input.handoffId ||
    row.handoff_mission_id !== input.missionId ||
    row.receipt_mission_id !== input.missionId ||
    row.handoff_session_id !== input.sessionId ||
    row.receipt_session_id !== input.sessionId ||
    row.handoff_worker_incarnation_id !== input.workerIncarnationId ||
    row.receipt_worker_incarnation_id !== input.workerIncarnationId ||
    (input.workerId !== undefined &&
      row.handoff_from_agent !== input.workerId) ||
    row.receipt_id !== row.tool_call_id ||
    row.issued_at > row.handoff_created_at ||
    row.handoff_created_at > input.noLaterThan
  ) {
    throw new Error(
      "task handoff physical receipt does not match mission/session/incarnation authority",
    );
  }
  if (
    (input.expectedStatus === "success" && row.handoff_status !== "success") ||
    (input.expectedStatus === "non-success" && row.handoff_status === "success")
  ) {
    throw new Error(
      input.expectedStatus === "success"
        ? "task handoff acceptance requires status success"
        : "task handoff blocking requires a non-success status",
    );
  }

  assertStoredHandoffAgentAttestation(
    db,
    input.missionId,
    row.handoff_from_agent,
    {
      agentPubkey: row.agent_pubkey,
      ownerPubkey: row.owner_pubkey,
      attestationJson: row.attestation_json,
    },
  );

  let auditIntentOccurredAt: number | undefined;
  if (input.requireCorrelatedAuditIntent) {
    const auditRows = db
      .prepare(
        `SELECT payload_json, occurred_at
         FROM audit_events
         WHERE mission_id = ?
           AND actor = ?
           AND action = 'nexus_handoff_submit'
           AND outcome = 'intent'`,
      )
      .all(input.missionId, input.sessionId) as Array<{
      readonly payload_json: string;
      readonly occurred_at: number;
    }>;
    const matches = auditRows.filter((auditRow) => {
      let payload: z.infer<typeof auditIntentPayloadSchema>;
      try {
        payload = parseAuditPayload(auditRow.payload_json);
      } catch {
        return false;
      }
      return (
        auditRow.occurred_at <= row.issued_at &&
        payload.project_id === coordinates.projectId &&
        payload.checkout_id === coordinates.checkoutId &&
        payload.source === row.source &&
        payload.invocation_id === row.tool_call_id
      );
    });
    if (matches.length !== 1) {
      throw new Error(
        "task handoff requires one exact correlated physical audit intent",
      );
    }
    auditIntentOccurredAt = matches[0]!.occurred_at;
  }

  return Object.freeze({
    receiptId: row.receipt_id,
    toolCallId: row.tool_call_id,
    source: row.source,
    authoritySha256: row.authority_sha256,
    ...(row.worktree_head_sha
      ? { worktreeHeadSha: row.worktree_head_sha }
      : {}),
    ...(auditIntentOccurredAt !== undefined
      ? { auditIntentOccurredAt }
      : {}),
    issuedAt: row.issued_at,
    status: row.handoff_status,
  });
}
