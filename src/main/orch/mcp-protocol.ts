import type { AgentGateContext } from './gate';
import { canonicalToolName, isToolAllowedForRole } from './gate';
import {
  dispatchToolCall,
  type McpDispatchOptions,
} from './mcp-dispatch';

/**
 * Minimal MCP (Model Context Protocol) server core: JSON-RPC 2.0 message
 * handling for initialize / ping / tools-list / tools-call over the
 * streamable-HTTP transport. Implemented directly (no SDK) so the main-process
 * bundle stays lean and free of zod-version coupling; the subset below is what
 * CLI agents (Claude Code, Codex, …) need to call the native nexus_* tools.
 *
 * This module is transport-agnostic and pure — the HTTP wiring lives in
 * mcp-server.ts and unit tests drive it directly.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  MCP_PROTOCOL_VERSION,
]);

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolDef {
  /** Canonical name (nexus_* namespace). */
  name: string;
  description: string;
  /** Plain JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
  /** Forces native/user confirmation even if the generic guardrail changes. */
  requiresConfirm?: boolean;
  handler: (
    args: Record<string, unknown>,
    ctx: AgentGateContext,
    invocation?: McpToolInvocation,
  ) => Promise<unknown>;
}

export interface McpToolInvocation {
  /** Aborted when a newer mission intent preempts bootstrap/preflight work. */
  readonly signal?: AbortSignal;
}

export interface McpRegistry {
  tools: McpToolDef[];
  serverName: string;
  serverVersion: string;
}

/** Resolve a tool by canonical or aliased name (nexus_/bare). */
export function resolveTool(
  registry: McpRegistry,
  name: string,
): McpToolDef | null {
  const canonical = canonicalToolName(name);
  return (
    registry.tools.find((tool) => canonicalToolName(tool.name) === canonical) ??
    null
  );
}

function ok(id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: JsonRpcResponse['id'],
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolText(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  const text =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function toolError(payload: unknown): ReturnType<typeof toolText> {
  return { ...toolText(payload), isError: true };
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as JsonRpcRequest).jsonrpc === '2.0' &&
    typeof (value as JsonRpcRequest).method === 'string'
  );
}

/**
 * Handle one JSON-RPC message. Returns null for notifications (no response).
 * Tool-level failures come back as `isError` results; gate refusals are
 * explicit so agents can adjust instead of retrying blindly.
 */
export async function handleMcpMessage(
  registry: McpRegistry,
  ctx: AgentGateContext,
  message: JsonRpcRequest,
  dispatchOptions: McpDispatchOptions = {},
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;

  if (message.method.startsWith('notifications/')) return null;

  switch (message.method) {
    case 'initialize': {
      const requested = (message.params?.protocolVersion as string) ?? '';
      const version = SUPPORTED_VERSIONS.has(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: registry.serverName,
          version: registry.serverVersion,
        },
      });
    }

    case 'ping':
      return ok(id, {});

    case 'tools/list': {
      const tools = registry.tools
        .filter((tool) =>
          isToolAllowedForRole(ctx.role, ctx.allowedTools, tool.name),
        )
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
      return ok(id, { tools });
    }

    case 'tools/call': {
      const name = message.params?.name;
      if (typeof name !== 'string' || name.length === 0) {
        return rpcError(id, -32602, 'tools/call requires params.name');
      }
      const args =
        (message.params?.arguments as Record<string, unknown>) ?? {};
      const result = await dispatchToolCall(
        'http-mcp',
        registry,
        name,
        args,
        ctx,
        dispatchOptions,
      );
      if (result.ok) {
        console.log(`[orch] tool ${result.tool} ok (${ctx.label})`);
        return ok(id, toolText(result.result));
      }
      const detail = result.error ?? result.confirmationReason ?? 'tool denied';
      console.warn(`[orch] tool ${result.tool} FALHOU (${ctx.label}): ${detail}`);
      return ok(
        id,
        toolError(
          result.effectMayHaveCommitted
            ? {
                tool: result.tool,
                error: detail,
                effectMayHaveCommitted: true,
              }
            : `${result.tool} failed: ${detail}`,
        ),
      );
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${message.method}`);
  }
}
