import { createHash } from "node:crypto";
import type { AgentGateContext } from "./gate";
import {
  dispatchToolCall,
  type ToolDispatchResult,
} from "./mcp-dispatch";
import type { McpDispatchOptions } from "./mcp-dispatch-contract";
import type { McpRegistry } from "./mcp-protocol";
import type { PtyStreamMissionAction } from "./pty-stream-mission-control";

/**
 * O id do bloco PTY (`call-1`) é local ao canal. O recibo usa sessão + canal
 * + id, então outro pane ou um canal novo não reaproveita o resultado. O
 * mesmo canal vivo, no retry da resposta perdida, continua no mesmo recibo.
 * Main fornece sessão/canal; o binding completo e a resposta unavailable de
 * retry vêm do dispatcher, sem expor operationId público ou guardar output.
 */
export function ptyStreamLogicalOperationId(
  sessionId: string,
  channelId: string,
  requestId: string,
): string {
  const session = sessionId.trim();
  const channel = channelId.trim();
  const request = requestId.trim();
  if (!session || !channel || !request) {
    throw new Error(
      "pty stream operation requires session, channel and request id",
    );
  }
  return createHash("sha256")
    .update("pty-stream\0")
    .update(session)
    .update("\0")
    .update(channel)
    .update("\0")
    .update(request)
    .digest("hex");
}

export function dispatchPtyStreamMissionAction(input: {
  readonly sessionId: string;
  readonly channelId: string;
  readonly request: Pick<PtyStreamMissionAction, "id" | "tool" | "args">;
  readonly registry: McpRegistry;
  readonly ctx: AgentGateContext;
  readonly options?: Omit<McpDispatchOptions, "logicalOperationId">;
}): Promise<ToolDispatchResult> {
  if (input.ctx.sessionId !== input.sessionId) {
    return Promise.resolve({
      ok: false,
      tool: input.request.tool,
      denied: true,
      error: 'pty_stream_session_identity_conflict',
    });
  }
  return dispatchToolCall(
    "pty-stream",
    input.registry,
    input.request.tool,
    input.request.args,
    input.ctx,
    {
      ...input.options,
      logicalOperationId: ptyStreamLogicalOperationId(
        input.sessionId,
        input.channelId,
        input.request.id,
      ),
    },
  );
}
