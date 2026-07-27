import { createHash } from "node:crypto";
import type { ProjectExecutionScope } from "../../shared/types";
import { canonicalJson } from "../context/canonical-json";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Identity of the complete validated MCP argument object before any display
 * compaction or normalization. Unknown JSON fields remain part of the digest
 * so a retry cannot smuggle a divergent raw payload behind the same compact
 * summary.
 */
export function handoffRawPayloadSha256(
  args: Readonly<Record<string, unknown>>,
): string {
  return sha256(
    canonicalJson({
      schema: "nexus.handoff-raw-payload/v1",
      args,
    }),
  );
}

/**
 * One worker transport generation may commit one physical final handoff per
 * mission. The payload digest is deliberately excluded: divergent retries
 * collide on this operation key and are rejected against the stored digest.
 */
export function handoffLogicalOperationKey(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly sessionId: string;
  readonly workerIncarnationId?: string;
}): string {
  return sha256(
    canonicalJson({
      schema: "nexus.handoff-logical-operation/v1",
      installationId: input.scope.installationId,
      projectId: input.scope.projectId,
      checkoutId: input.scope.checkoutId,
      missionId: input.missionId,
      sessionId: input.sessionId,
      workerIncarnationId: input.workerIncarnationId ?? null,
    }),
  );
}
