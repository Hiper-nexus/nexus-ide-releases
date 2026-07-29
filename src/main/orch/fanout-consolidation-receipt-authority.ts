import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  consumeAgentTransportPhysicalReceipt,
  type AgentTransportPhysicalReceipt,
  type AgentTransportPhysicalReceiptExpectation,
  type ConsumedAgentTransportPhysicalReceipt,
} from "./http-mcp-boundary";
import { physicalAgentActionPayloadSha256 } from "./handoff-payload-identity";
import { assertPhysicalAgentToolAuditAuthority } from "./physical-agent-tool-audit-authority";
import type { ScopedStoreBinding } from "./scoped-store";

const finalOutputSchema = z.string().trim().min(40).max(65_536);
const maestroHeadingPattern = /(?:^|\n)#{1,6}[ \t]+Maestro[ \t]*\r?\n/iu;
const sha256Pattern = /^[a-f0-9]{64}$/;

export interface FanoutConsolidation {
  readonly finalOutput: string;
  readonly maestroPerspective: string;
}

export interface FanoutConsolidationRow {
  readonly mission_id: string;
  readonly intent_version: number;
  readonly plan_hash: string;
  readonly topology: string;
  readonly orchestrator_session_id: string;
  readonly receipt_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly source: "http-mcp" | "pty-stream";
  readonly authority_sha256: string;
  readonly payload_sha256: string;
  readonly final_output: string;
  readonly final_output_sha256: string;
  readonly maestro_perspective: string;
  readonly maestro_sha256: string;
  readonly issued_at: number;
  readonly created_at: number;
}

interface AckReceiptRow {
  readonly receipt_id: string;
  readonly handoff_id: string;
  readonly delivery_attempt_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly source: "http-mcp" | "pty-stream";
  readonly mission_id: string;
  readonly orchestrator_session_id: string;
  readonly authority_sha256: string;
  readonly payload_sha256: string;
  readonly issued_at: number;
  readonly acknowledged_at: number;
}

export function parseFanoutFinalOutput(raw: string): FanoutConsolidation {
  const finalOutput = finalOutputSchema.parse(raw);
  const heading = maestroHeadingPattern.exec(finalOutput);
  if (!heading) {
    throw new Error(
      "fanout consolidation requires a markdown '## Maestro' section",
    );
  }
  const maestroPerspective = finalOutput.slice(
    (heading.index ?? 0) + heading[0].length,
  ).trim();
  if (maestroPerspective.length < 20) {
    throw new Error(
      "fanout consolidation requires the Maestro's own perspective (≥20 chars)",
    );
  }
  return { finalOutput, maestroPerspective };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isValidAckRow(
  row: AckReceiptRow | undefined,
  input: {
    readonly missionId: string;
    readonly orchestratorSessionId: string;
    readonly handoffId: string;
    readonly deliveryAttemptId: string;
    readonly acceptedAt: number;
    readonly consumedAt: number;
    readonly now: number;
  },
): row is AckReceiptRow {
  const expectedPayload = physicalAgentActionPayloadSha256(
    "nexus_handoff_ack",
    { handoffId: input.handoffId },
  );
  return Boolean(
    row &&
      row.receipt_id === row.tool_call_id &&
      row.handoff_id === input.handoffId &&
      row.delivery_attempt_id === input.deliveryAttemptId &&
      row.tool_name === "nexus_handoff_ack" &&
      row.mission_id === input.missionId &&
      row.orchestrator_session_id === input.orchestratorSessionId &&
      row.payload_sha256 === expectedPayload &&
      sha256Pattern.test(row.authority_sha256) &&
      input.acceptedAt <= row.issued_at &&
      row.issued_at <= row.acknowledged_at &&
      row.acknowledged_at === input.consumedAt &&
      row.acknowledged_at <= input.now,
  );
}

export function verifiedFanoutAckTime(
  db: Database.Database,
  binding: ScopedStoreBinding,
  input: Parameters<typeof isValidAckRow>[1],
): number | null {
  const row = db
    .prepare(
      `SELECT * FROM handoff_ack_receipts
       WHERE handoff_id = ? AND delivery_attempt_id = ?
         AND mission_id = ? AND orchestrator_session_id = ?`,
    )
    .get(
      input.handoffId,
      input.deliveryAttemptId,
      input.missionId,
      input.orchestratorSessionId,
    ) as AckReceiptRow | undefined;
  if (!isValidAckRow(row, input)) return null;
  assertPhysicalAgentToolAuditAuthority(db, binding.coordinates, {
    toolName: "nexus_handoff_ack",
    source: row.source,
    toolCallId: row.tool_call_id,
    missionId: input.missionId,
    sessionId: input.orchestratorSessionId,
    issuedAt: row.issued_at,
  });
  return row.acknowledged_at;
}

interface ReadConsolidationInput {
  readonly missionId: string;
  readonly intentVersion: number;
  readonly planHash: string;
  readonly orchestratorSessionId: string;
  readonly latestAckAt: number;
  readonly now: number;
}

function isValidConsolidationRow(
  row: FanoutConsolidationRow | undefined,
  input: ReadConsolidationInput,
): row is FanoutConsolidationRow {
  if (!row) return false;
  const payload = physicalAgentActionPayloadSha256(
    "nexus_mission_set_status",
    { missionId: input.missionId, status: "done", note: row.final_output },
  );
  return (
    row.mission_id === input.missionId &&
    row.intent_version === input.intentVersion &&
    row.plan_hash === input.planHash &&
    row.topology === "team-read-only-fanout" &&
    row.orchestrator_session_id === input.orchestratorSessionId &&
    row.receipt_id === row.tool_call_id &&
    row.tool_name === "nexus_mission_set_status" &&
    sha256Pattern.test(row.authority_sha256) &&
    row.final_output_sha256 === sha256(row.final_output) &&
    row.maestro_sha256 === sha256(row.maestro_perspective) &&
    row.payload_sha256 === payload &&
    input.latestAckAt <= row.issued_at &&
    row.issued_at <= row.created_at &&
    row.created_at <= input.now
  );
}

export function readVerifiedFanoutConsolidation(
  db: Database.Database,
  binding: ScopedStoreBinding,
  input: ReadConsolidationInput,
): FanoutConsolidationRow | null {
  const row = db
    .prepare(
      `SELECT * FROM mission_fanout_consolidation_receipts
       WHERE mission_id = ? AND intent_version = ?
         AND orchestrator_session_id = ?`,
    )
    .get(
      input.missionId,
      input.intentVersion,
      input.orchestratorSessionId,
    ) as
    | FanoutConsolidationRow
    | undefined;
  if (!isValidConsolidationRow(row, input)) return null;
  assertPhysicalAgentToolAuditAuthority(db, binding.coordinates, {
    toolName: "nexus_mission_set_status",
    source: row.source,
    toolCallId: row.tool_call_id,
    missionId: input.missionId,
    sessionId: input.orchestratorSessionId,
    issuedAt: row.issued_at,
  });
  return row;
}

export interface PersistFanoutConsolidationInput
  extends FanoutConsolidation {
  readonly missionId: string;
  readonly intentVersion: number;
  readonly planHash: string;
  readonly orchestratorSessionId: string;
  readonly payloadSha256: string;
  readonly now: number;
  readonly physicalReceipt: AgentTransportPhysicalReceipt;
  readonly expectation: AgentTransportPhysicalReceiptExpectation;
  readonly inspected: ConsumedAgentTransportPhysicalReceipt;
}

function consumeConsolidationReceipt(
  db: Database.Database,
  binding: ScopedStoreBinding,
  input: PersistFanoutConsolidationInput,
): ConsumedAgentTransportPhysicalReceipt | null {
  if (
    input.inspected.toolName !== "nexus_mission_set_status" ||
    input.inspected.issuedAt > input.now
  ) {
    return null;
  }
  assertPhysicalAgentToolAuditAuthority(db, binding.coordinates, {
    toolName: "nexus_mission_set_status",
    source: input.inspected.source,
    toolCallId: input.inspected.toolCallId,
    missionId: input.missionId,
    sessionId: input.orchestratorSessionId,
    issuedAt: input.inspected.issuedAt,
  });
  const consumed = consumeAgentTransportPhysicalReceipt(
    input.physicalReceipt,
    input.expectation,
  );
  if (
    consumed.toolName !== input.inspected.toolName ||
    consumed.toolCallId !== input.inspected.toolCallId ||
    consumed.authoritySha256 !== input.inspected.authoritySha256
  ) {
    throw new Error("physical fanout consolidation receipt changed before commit");
  }
  return consumed;
}

function existingConsolidationMatches(
  db: Database.Database,
  input: PersistFanoutConsolidationInput,
): boolean | null {
  const row = db
    .prepare(
      `SELECT plan_hash, orchestrator_session_id, final_output_sha256,
              maestro_sha256
       FROM mission_fanout_consolidation_receipts
       WHERE mission_id = ? AND intent_version = ?
         AND orchestrator_session_id = ?`,
    )
    .get(
      input.missionId,
      input.intentVersion,
      input.orchestratorSessionId,
    ) as
    | {
        readonly plan_hash: string;
        readonly orchestrator_session_id: string;
        readonly final_output_sha256: string;
        readonly maestro_sha256: string;
      }
    | undefined;
  if (!row) return null;
  return (
    row.plan_hash === input.planHash &&
    row.orchestrator_session_id === input.orchestratorSessionId &&
    row.final_output_sha256 === sha256(input.finalOutput) &&
    row.maestro_sha256 === sha256(input.maestroPerspective)
  );
}

function insertConsolidation(
  db: Database.Database,
  input: PersistFanoutConsolidationInput,
  receipt: ConsumedAgentTransportPhysicalReceipt,
): void {
  db.prepare(
    `INSERT INTO mission_fanout_consolidation_receipts
       (mission_id, intent_version, plan_hash, topology,
        orchestrator_session_id, receipt_id, tool_call_id, tool_name, source,
        authority_sha256, payload_sha256, final_output, final_output_sha256,
        maestro_perspective, maestro_sha256, issued_at, created_at)
     VALUES (?, ?, ?, 'team-read-only-fanout', ?, ?, ?,
             'nexus_mission_set_status', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.missionId,
    input.intentVersion,
    input.planHash,
    input.orchestratorSessionId,
    receipt.toolCallId,
    receipt.toolCallId,
    receipt.source,
    receipt.authoritySha256,
    input.payloadSha256,
    input.finalOutput,
    sha256(input.finalOutput),
    input.maestroPerspective,
    sha256(input.maestroPerspective),
    receipt.issuedAt,
    input.now,
  );
}

export function persistFanoutConsolidationReceipt(
  db: Database.Database,
  binding: ScopedStoreBinding,
  input: PersistFanoutConsolidationInput,
): boolean {
  const existing = existingConsolidationMatches(db, input);
  if (existing === false) return false;
  const consumed = consumeConsolidationReceipt(db, binding, input);
  if (!consumed) return false;
  if (existing === true) return true;
  insertConsolidation(db, input, consumed);
  return true;
}
