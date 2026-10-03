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
  /**
   * F-773/F-782: veredito do Maestro, gravado junto do consumo. Fora do
   * digest do recibo (que continua `{handoffId}`): é rótulo, não autoridade.
   */
  readonly verdict?: "accepted" | "rework";
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

/**
 * Pull delivery: the orchestrator acknowledges a handoff it read through
 * `nexus_handoff_list` instead of one pasted into its terminal.
 *
 * Push delivery only pastes into an *idle* PTY, because pasting into a live
 * turn corrupts it. But an orchestrator that polls for worker results stays
 * `working` for that whole turn, so the push attempt never fires — and the ACK
 * required an accepted push attempt. That is a deadlock: the Maestro waits for
 * a handoff it can already read, while holding the very turn whose end would
 * let it be pasted. Observed live: three `success` handoffs stuck in `queued`
 * with an empty `handoff_delivery_attempts` while the Maestro looped
 * list→ack→sleep until the mission was blocked.
 *
 * The pasted text was never the authority — the physical receipt and the
 * mission's current orchestrator session are, and `commitPhysicalAck` has
 * already proven both. Accepting at `issuedAt` keeps the attempt inside the
 * caller's own turn, so the freshness comparison stays meaningful.
 */
function pullDeliveryAttempt(
  db: Database.Database,
  binding: ScopedStoreBinding,
  input: PhysicalAckInput,
  issuedAt: number,
  now: number,
): AcceptedAttempt | null {
  const handoff = db
    .prepare(`SELECT mission_id, delivery_state FROM handoffs WHERE id = ?`)
    .get(input.handoffId) as
    | { readonly mission_id: string | null; readonly delivery_state: string }
    | undefined;
  if (
    !handoff ||
    handoff.mission_id !== input.missionId ||
    handoff.delivery_state !== "queued"
  ) {
    return null;
  }
  const counters = db
    .prepare(
      `SELECT COALESCE(MAX(attempt_no), 0) AS latest_attempt_no
       FROM handoff_delivery_attempts WHERE handoff_id = ?`,
    )
    .get(input.handoffId) as { readonly latest_attempt_no: number };
  const id = binding.makeId("handoff-delivery");
  db.prepare(
    `INSERT INTO handoff_delivery_attempts (
       id, handoff_id, mission_id, orchestrator_session_id,
       attempt_no, state, started_at, accepted_at
     ) VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)`,
  ).run(
    id,
    input.handoffId,
    input.missionId,
    input.orchestratorSessionId,
    counters.latest_attempt_no + 1,
    issuedAt,
    issuedAt,
  );
  const submitted = db
    .prepare(
      `UPDATE handoffs
       SET delivered = 1, delivery_state = 'submitted', submitted_at = ?
       WHERE id = ? AND delivery_state = 'queued'`,
    )
    .run(now, input.handoffId);
  if (submitted.changes !== 1) {
    throw new Error("handoff pull delivery lost delivery-state CAS");
  }
  return { id, accepted_at: issuedAt };
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
  if (inspected.source === "mission-shim") {
    throw new Error(
      "physical handoff ACK requires an orchestrator transport, not a worker shim",
    );
  }
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
           consumed_delivery_attempt_id = ?,
           ack_verdict = ?
       WHERE id = ? AND mission_id = ? AND delivered = 1
         AND delivery_state IN ('submitted', 'acknowledged')`,
    )
    .run(
      now,
      now,
      input.orchestratorSessionId,
      attemptId,
      input.verdict ?? "accepted",
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
  if (
    mission?.orch_session_id !== input.orchestratorSessionId ||
    inspected.issuedAt > now
  ) {
    return null;
  }
  const attempt =
    acceptedAttempt(db, input) ??
    pullDeliveryAttempt(db, binding, input, inspected.issuedAt, now);
  if (!attempt || attempt.accepted_at > inspected.issuedAt) return null;
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
