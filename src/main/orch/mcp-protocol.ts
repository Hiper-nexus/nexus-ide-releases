import type { AgentGateContext } from "./gate";
import { canonicalToolName } from "./gate";
import { dispatchToolCall, type McpDispatchOptions } from "./mcp-dispatch";
import { isToolAllowedForReadOnlyContext } from "./mcp-effect-policy";
import type { AgentTransportPhysicalReceipt } from "./http-mcp-boundary";
import { operatorDelegationInstructions } from "./operator-delegation-doctrine";
import { maestroStandingContext } from "./maestro-standing-context";
import { operatorBusinessModelContext } from "./operator-business-model";
import { ensureBusinessModel } from "../context/business-model/business-model-ensure";
import { joinPromptContextBlocks } from "./prompt-context-blocks";
import { operatorWorkspaceMemoryContext } from "./operator-workspace-memory";

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

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  MCP_PROTOCOL_VERSION,
]);

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
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
  /** Explicit Main terminal/bg lifetime producer; response alone is not exit. */
  ownedProcessLifetime?: boolean;
  /**
   * Runtime availability predicate (presence of a credential, feature flag).
   * When it returns false the tool is hidden from tools/list and dispatch
   * refuses the call — a client without the dependency sees a classic Nexus.
   */
  available?: () => boolean;
  handler: (
    args: Record<string, unknown>,
    ctx: AgentGateContext,
    invocation?: McpToolInvocation,
  ) => Promise<unknown>;
}

export interface McpToolInvocation {
  /** Main-only owned process proof registration; never accepted from tool args. */
  readonly beginOwnedProcess?: () => {
    observeExit(exit: Promise<void>): void;
    preparationFailed(): void;
  };
  /** Aborted when a newer mission intent preempts bootstrap/preflight work. */
  readonly signal?: AbortSignal;
  /**
   * Revalidate the exact caller at an asynchronous linearization point.
   * Effectful handlers must call this after awaited preparation and
   * immediately before starting a process, network request, or durable write.
   */
  readonly assertCurrentAuthority?: () => void;
  /** Main-only spawned-prompt owner; false retains unknown/newer bindings. */
  readonly retireRevokedPrompt?: (sessionId: string) => Promise<boolean>;
  /**
   * Correlated durable-effect identity issued by the central dispatcher after
   * audit intent persistence. HTTP MCP handoff provenance must bind to this
   * value; tool handlers cannot mint a substitute.
   */
  readonly effectIntent?: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly source:
      | "http-mcp"
      | "acp-stdio"
      | "pty-stream"
      | "mission-shim"
      | "ipc-renderer"
      | "jarvis-voice";
    readonly issuedAt: number;
  };
  /**
   * Opaque one-shot capability minted only inside an authenticated physical
   * agent transport (localhost HTTP MCP or Main-observed PTY stream).
   */
  readonly agentTransportPhysicalReceipt?: AgentTransportPhysicalReceipt;
  /**
   * One-shot receipt emitted only after exact native consent (or consumption
   * of an exact, single-use permission) for tools whose authority outlives the
   * current mission. It is never derived from mission-wide autopilot approval.
   */
  readonly exactUserConsent?: {
    readonly toolName: string;
    /** Canonical mutation action reviewed by the user. */
    readonly action: string;
    readonly grantedAt: number;
    /** Correlated append-only audit intent that authenticated this one use. */
    readonly receiptId: string;
  };
}

/** Shared fail-closed checkpoint for effectful tool implementations. */
export function assertMcpInvocationCurrent(
  invocation?: McpToolInvocation,
): void {
  invocation?.assertCurrentAuthority?.();
  if (invocation?.signal?.aborted) {
    throw new Error("session_authority_revoked");
  }
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

function ok(id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: JsonRpcResponse["id"],
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolText(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function toolError(payload: unknown): ReturnType<typeof toolText> {
  return { ...toolText(payload), isError: true };
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as JsonRpcRequest).jsonrpc === "2.0" &&
    typeof (value as JsonRpcRequest).method === "string"
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

  if (message.method.startsWith("notifications/")) return null;

  switch (message.method) {
    case "initialize": {
      // Garante o modelo extraído do HEAD em background: o primeiro hook/brief
      // já encontra (ou recebe) o store pronto. Nunca segura o initialize.
      void ensureBusinessModel(ctx.executionScope ?? ctx.scope, {
        wait: false,
      }).catch(() => {});
      const requested = (message.params?.protocolVersion as string) ?? "";
      const version = SUPPORTED_VERSIONS.has(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
      const instructions = joinPromptContextBlocks([
        operatorDelegationInstructions(ctx),
        maestroStandingContext(ctx, "mcp"),
        operatorBusinessModelContext(ctx, "mcp"),
        operatorWorkspaceMemoryContext(ctx, "mcp"),
      ]);
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: registry.serverName,
          version: registry.serverVersion,
        },
        ...(instructions ? { instructions } : {}),
      });
    }

    case "ping":
      return ok(id, {});

    case "tools/list": {
      // F-1157: todo agente vê toda tool disponível nesta máquina. Só a lane
      // que o modo Hardened confina à leitura não vê efeitos de escrita.
      const tools = registry.tools
        .filter(
          (tool) =>
            (ctx.readOnlyEnforced !== true ||
              isToolAllowedForReadOnlyContext(tool.name)) &&
            (tool.available?.() ?? true),
        )
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
      return ok(id, { tools });
    }

    case "tools/call": {
      const name = message.params?.name;
      if (typeof name !== "string" || name.length === 0) {
        return rpcError(id, -32602, "tools/call requires params.name");
      }
      const args = (message.params?.arguments as Record<string, unknown>) ?? {};
      const result = await dispatchToolCall(
        dispatchOptions.source ?? "http-mcp",
        registry,
        name,
        args,
        ctx,
        dispatchOptions,
      );
      try {
        dispatchOptions.onToolResult?.(result);
      } catch (error) {
        // Observability is not authority. A broken lifecycle observer must not
        // rewrite a completed tool result or prevent the agent receiving it.
        console.warn("[orch] tool result observer failed:", error);
      }
      if (result.ok) {
        console.log(`[orch] tool ${result.tool} ok (${ctx.label})`);
        return ok(id, toolText(result.result));
      }
      const detail = result.error ?? result.confirmationReason ?? "tool denied";
      // A dica não entra em `error` (contrato); entra no texto que o agente lê.
      const guidance = result.hint ? ` — ${result.hint}` : "";
      console.warn(
        `[orch] tool ${result.tool} FALHOU (${ctx.label}): ${detail}${guidance}`,
      );
      return ok(
        id,
        toolError(
          result.effectMayHaveCommitted
            ? {
                tool: result.tool,
                error: detail,
                ...(result.hint ? { hint: result.hint } : {}),
                effectMayHaveCommitted: true,
              }
            : `${result.tool} failed: ${detail}${guidance}`,
        ),
      );
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${message.method}`);
  }
}
