import type Database from "better-sqlite3";
import {
  consumeAgentTransportPhysicalReceipt,
  inspectCurrentAgentTransportPhysicalReceipt,
  type AgentTransportPhysicalReceipt,
  type AgentTransportPhysicalReceiptExpectation,
  type ConsumedAgentTransportPhysicalReceipt,
} from "./http-mcp-boundary";
import { physicalAgentActionPayloadSha256 } from "./handoff-payload-identity";
import { assertPhysicalAgentToolAuditAuthority } from "./physical-agent-tool-audit-authority";
import type { ScopedStoreBinding } from "./scoped-store";

interface PhysicalAckInput {
  readonly handoffId: string;
  readonly missionId: string;
  readonly orchestratorSessionId: string;
}

interface AcceptedAttempt {
  readonly id: string;
  readonly accepted_at: number;
}

function acceptedAttempt(
  db: Database.Database,
  input: PhysicalAckInput,
): AcceptedAttempt | null {
  const rows = db
    .prepare(
      `SELECT id, accepted_at
       FROM handoff_delivery_attempts
       WHERE handoff_id = ? AND mission_id = ?
         AND orchestrator_session_id = ?
         AND state = 'accepted' AND accepted_at IS NOT NULL
       ORDER BY accepted_at DESC, id DESC
       LIMIT 2`,
    )
    .all(
      input.handoffId,
      input.missionId,
      input.orchestratorSessionId,
    ) as AcceptedAttempt[];
  return rows.length === 1 ? rows[0]! : null;
}

function existingAckMatches(
  db: Database.Database,
  input: PhysicalAckInput,
  attemptId: string,
): boolean | null {
  const row = db
    .prepare(
      `SELECT delivery_attempt_id, mission_id, orchestrator_session_id
       FROM handoff_ack_receipts WHERE delivery_attempt_id = ?`,
    )
    .get(attemptId) as
    | {
        readonly delivery_attempt_id: string;
        readonly mission_id: string;
        readonly orchestrator_session_id: string;
      }
    | undefined;
  if (!row) return null;
  return (
    row.delivery_attempt_id === attemptId &&
    row.mission_id === input.missionId &&
    row.orchestrator_session_id === input.orchestratorSessionId
  );
}

function consumeCurrentPhysicalAck(
  db: Database.Database,
  binding: ScopedStoreBinding,
  input: PhysicalAckInput,
  expectation: AgentTransportPhysicalReceiptExpectation,
  physicalReceipt: AgentTransportPhysicalReceipt,
  inspected: ConsumedAgentTransportPhysicalReceipt,
): ConsumedAgentTransportPhysicalReceipt {
  assertPhysicalAgentToolAuditAuthority(db, binding.coordinates, {
    toolName: "nexus_handoff_ack",
    source: inspected.source,
    toolCallId: inspected.toolCallId,
    missionId: input.missionId,
    sessionId: input.orchestratorSessionId,
    issuedAt: inspected.issuedAt,
  });
  const consumed = consumeAgentTransportPhysicalReceipt(
    physicalReceipt,
    expectation,
  );
  if (
    consumed.toolName !== "nexus_handoff_ack" ||
    consumed.toolCallId !== inspected.toolCallId ||
    consumed.authoritySha256 !== inspected.authoritySha256
  ) {
    throw new Error("physical handoff ACK receipt changed before commit");
  }
  return consumed;
}

function insertAckReceipt(
  db: Database.Database,
  input: PhysicalAckInput,
  attemptId: string,
  receipt: ConsumedAgentTransportPhysicalReceipt,
  payloadSha256: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO handoff_ack_receipts
       (receipt_id, handoff_id, delivery_attempt_id, tool_call_id,
        tool_name, source, mission_id, orchestrator_session_id,
        authority_sha256, payload_sha256, issued_at, acknowledged_at)
     VALUES (?, ?, ?, ?, 'nexus_handoff_ack', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.toolCallId,
    input.handoffId,
    attemptId,
    receipt.toolCallId,
    receipt.source,
    input.missionId,
    input.orchestratorSessionId,
    receipt.authoritySha256,
    payloadSha256,
    receipt.issuedAt,
    now,
  );
}

function consumeHandoffRow(
  db: Database.Database,
  input: PhysicalAckInput,
  attemptId: string,
  now: number,
): void {
  const result = db
    .prepare(
      `UPDATE handoffs
       SET delivery_state = 'consumed',
           acknowledged_at = COALESCE(acknowledged_at, ?),
           consumed_at = ?, consumed_by_session = ?,
           consumed_delivery_attempt_id = ?
       WHERE id = ? AND mission_id = ? AND delivered = 1
         AND delivery_state IN ('submitted', 'acknowledged')`,
    )
    .run(
      now,
      now,
      input.orchestratorSessionId,
      attemptId,
      input.handoffId,
      input.missionId,
    );
  if (result.changes !== 1) {
    throw new Error("physical handoff ACK lost delivery-state CAS");
  }
}

function commitPhysicalAck(
  db: Database.Database,
  binding: ScopedStoreBinding,
  input: PhysicalAckInput,
  physicalReceipt: AgentTransportPhysicalReceipt,
  expectation: AgentTransportPhysicalReceiptExpectation,
  inspected: ConsumedAgentTransportPhysicalReceipt,
  payloadSha256: string,
  now: number,
): "created" | "replayed" | null {
  const mission = db
    .prepare(`SELECT orch_session_id FROM missions WHERE id = ?`)
    .get(input.missionId) as
    { readonly orch_session_id: string | null } | undefined;
  const attempt = acceptedAttempt(db, input);
  if (
    mission?.orch_session_id !== input.orchestratorSessionId ||
    !attempt ||
    attempt.accepted_at > inspected.issuedAt ||
    inspected.issuedAt > now
  ) {
    return null;
  }
  const replay = existingAckMatches(db, input, attempt.id);
  if (replay === false) return null;
  const consumed = consumeCurrentPhysicalAck(
    db,
    binding,
    input,
    expectation,
    physicalReceipt,
    inspected,
  );
  if (replay === true) return "replayed";
  insertAckReceipt(db, input, attempt.id, consumed, payloadSha256, now);
  consumeHandoffRow(db, input, attempt.id, now);
  return "created";
}

export function markHandoffConsumedFromPhysicalAck(
  binding: ScopedStoreBinding,
  input: PhysicalAckInput,
  physicalReceipt: AgentTransportPhysicalReceipt,
): "created" | "replayed" | null {
  const payloadSha256 = physicalAgentActionPayloadSha256(
    "nexus_handoff_ack",
    { handoffId: input.handoffId },
  );
  const expectation = {
    projectId: binding.scope.projectId,
    checkoutId: binding.scope.checkoutId,
    missionId: input.missionId,
    sessionId: input.orchestratorSessionId,
    rawPayloadSha256: payloadSha256,
  };
  const inspected = inspectCurrentAgentTransportPhysicalReceipt(
    physicalReceipt,
    expectation,
  );
  if (inspected.toolName !== "nexus_handoff_ack") {
    throw new Error("physical nexus_handoff_ack receipt required");
  }
  const now = binding.now();
  const db = binding.writeDatabase();
  return db
    .transaction(() =>
      commitPhysicalAck(
        db,
        binding,
        input,
        physicalReceipt,
        expectation,
        inspected,
        payloadSha256,
        now,
      ),
    )
    .immediate();
}
