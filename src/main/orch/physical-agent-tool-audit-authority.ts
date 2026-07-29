import { z } from "zod";
import type { ScopeCoordinates } from "./scoped-store";
import { ScopedStoreCorruptionError } from "./scoped-store";
import type { TaskDispatchDatabase } from "./task-dispatch-persistence";

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"), {
    message: "identifier must not contain NUL",
  });

const auditIntentPayloadSchema = z
  .object({
    schema: z.literal("nexus.mcp-audit/v1"),
    project_id: identifierSchema,
    checkout_id: identifierSchema,
    source: z.enum(["http-mcp", "pty-stream"]),
    invocation_id: identifierSchema,
  })
  .passthrough();

export interface PhysicalAgentToolAuditAuthority {
  readonly toolName: "nexus_handoff_ack" | "nexus_mission_set_status";
  readonly source: "http-mcp" | "pty-stream";
  readonly toolCallId: string;
  readonly missionId: string;
  readonly sessionId: string;
  readonly issuedAt: number;
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
      "physical agent tool audit intent",
      { cause: error },
    );
  }
}

/**
 * Re-proves that a durable receipt was minted by one exact, authenticated
 * HTTP-MCP/PTy-stream tool call. Role/session columns alone are inherited
 * metadata and never substitute for this append-only invocation intent.
 */
export function assertPhysicalAgentToolAuditAuthority(
  db: TaskDispatchDatabase,
  coordinates: ScopeCoordinates,
  receipt: PhysicalAgentToolAuditAuthority,
): void {
  const rows = db
    .prepare(
      `SELECT payload_json, occurred_at
       FROM audit_events
       WHERE mission_id = ?
         AND actor = ?
         AND action = ?
         AND outcome = 'intent'`,
    )
    .all(receipt.missionId, receipt.sessionId, receipt.toolName) as Array<{
    readonly payload_json: string;
    readonly occurred_at: number;
  }>;
  const matches = rows.filter((row) => {
    let payload: z.infer<typeof auditIntentPayloadSchema>;
    try {
      payload = parseAuditPayload(row.payload_json);
    } catch {
      return false;
    }
    return (
      row.occurred_at <= receipt.issuedAt &&
      payload.project_id === coordinates.projectId &&
      payload.checkout_id === coordinates.checkoutId &&
      payload.source === receipt.source &&
      payload.invocation_id === receipt.toolCallId
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      `${receipt.toolName} requires one exact correlated physical audit intent`,
    );
  }
}
