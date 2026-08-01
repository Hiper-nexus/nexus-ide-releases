/**
 * ACP (Agent Client Protocol) wire types + NDJSON frame parsing.
 *
 * Design distilled from block/buzz buzz-acp (Apache-2.0).
 *
 * ACP is JSON-RPC 2.0 over stdio between a client (Nexus) and an agent
 * subprocess. Each frame is one newline-terminated JSON value (NDJSON).
 * The protocol surface this module covers is the one the buzz-agent
 * transcript documents:
 *
 *   client → agent requests:      initialize, session/new, session/prompt
 *   client → agent notification:  session/cancel
 *   agent  → client notification: session/update (tool_call,
 *                                 tool_call_update, agent_message_chunk)
 *   agent  → client request:      session/request_permission
 *   turn result:                  { stopReason: "end_turn" | ... }
 *
 * This file is runtime-agnostic (no Node imports) so it can be shared
 * between the main process and the renderer.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Protocol version Nexus requests in `initialize` (transcript uses 1). */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * Hard cap on a single NDJSON line. Mirrors buzz-agent's
 * `BUZZ_AGENT_MAX_LINE_BYTES` default (4 MiB). Oversize lines poison the
 * decoder — the peer is considered rogue and must be killed by the caller.
 */
export const ACP_MAX_LINE_BYTES = 4 * 1024 * 1024;

/** JSON-RPC 2.0 "Method not found" error code. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;

/** ACP method names used by this client. */
export const ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
  sessionRequestPermission: 'session/request_permission',
} as const;

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 permits numeric and string ids from either side. */
export type JsonRpcId = number | string;

// ---------------------------------------------------------------------------
// Request / response payloads
// ---------------------------------------------------------------------------

export interface AcpClientInfo {
  name: string;
  version: string;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: Record<string, unknown>;
  clientInfo?: AcpClientInfo;
}

export interface AcpPromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface AcpMcpCapabilities {
  http?: boolean;
  sse?: boolean;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: AcpPromptCapabilities;
  mcpCapabilities?: AcpMcpCapabilities;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: AcpAgentCapabilities;
  agentInfo?: AcpClientInfo;
}

/** A single env var for an MCP server (schema uses name/value pairs). */
export interface AcpEnvVar {
  name: string;
  value: string;
}

/**
 * MCP server spec passed in `session/new`. All four fields are required by
 * the schema (`args` and `env` may be empty arrays).
 */
export interface AcpMcpServerSpec {
  name: string;
  command: string;
  args: readonly string[];
  env: readonly AcpEnvVar[];
}

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers: readonly AcpMcpServerSpec[];
}

export interface AcpSessionNewResult {
  sessionId: string;
}

export interface AcpContentText {
  type: 'text';
  text: string;
}

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: readonly AcpContentText[];
}

export const ACP_STOP_REASONS = [
  'end_turn',
  'cancelled',
  'max_tokens',
  'max_turn_requests',
  'refusal',
] as const;

export type AcpStopReason = (typeof ACP_STOP_REASONS)[number];

/**
 * Parse a `stopReason` string from the wire. Case-insensitive, like buzz's
 * `StopReason::from_str`, so agents sending `"END_TURN"` or `"Cancelled"`
 * are handled without a protocol error. Unknown reasons return `null` —
 * callers decide whether that is fatal.
 */
export function parseAcpStopReason(value: unknown): AcpStopReason | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  const found = ACP_STOP_REASONS.find((reason) => reason === lowered);
  return found ?? null;
}

// ---------------------------------------------------------------------------
// session/update — typed, discriminated updates
// ---------------------------------------------------------------------------

export const ACP_TOOL_CALL_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
] as const;

export type AcpToolCallStatus = (typeof ACP_TOOL_CALL_STATUSES)[number];

export interface AcpAgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: AcpContentText;
}

export interface AcpToolCallUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  status: AcpToolCallStatus;
  kind?: string;
  rawInput?: unknown;
}

export interface AcpToolCallProgressUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status?: AcpToolCallStatus;
  content?: unknown;
}

/**
 * Update kinds this increment does not model (e.g. goose's
 * `session_info_update`, plan updates, non-text chunks). Preserved raw so
 * consumers can log or forward them without a protocol error.
 */
export interface AcpUnrecognizedUpdate {
  sessionUpdate: 'unrecognized';
  wireKind: string;
  raw: Record<string, unknown>;
}

export type AcpSessionUpdate =
  | AcpAgentMessageChunkUpdate
  | AcpToolCallUpdate
  | AcpToolCallProgressUpdate
  | AcpUnrecognizedUpdate;

// ---------------------------------------------------------------------------
// Inbound message classification (agent stdout → client)
// ---------------------------------------------------------------------------

export type AcpInboundMessage =
  | { kind: 'response'; id: JsonRpcId; result: unknown }
  | {
      kind: 'error-response';
      id: JsonRpcId | null;
      code: number;
      message: string;
      data?: unknown;
    }
  | { kind: 'session-update'; sessionId: string; update: AcpSessionUpdate }
  | {
      kind: 'agent-request';
      id: JsonRpcId;
      method: string;
      params: Record<string, unknown> | undefined;
    }
  | {
      kind: 'agent-notification';
      method: string;
      params: Record<string, unknown> | undefined;
    };

export type AcpParseError =
  | { code: 'empty-line' }
  | { code: 'line-too-long'; maxBytes: number }
  | { code: 'invalid-json'; detail: string }
  | { code: 'not-an-object' }
  | { code: 'missing-jsonrpc-version'; found: unknown }
  | { code: 'malformed-response'; detail: string }
  | { code: 'malformed-session-update'; detail: string };

export type AcpParseResult =
  | { ok: true; message: AcpInboundMessage }
  | { ok: false; error: AcpParseError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

/**
 * Cheap "is this string longer than maxBytes in UTF-8?" check. A JS string
 * of N UTF-16 units is 1..3 bytes per unit in UTF-8, so unit-count bounds
 * avoid encoding in the common case.
 */
function utf8LengthExceeds(text: string, maxBytes: number): boolean {
  if (text.length > maxBytes) return true;
  if (text.length * 3 <= maxBytes) return false;
  return new TextEncoder().encode(text).length > maxBytes;
}

function parseContentText(value: unknown): AcpContentText | null {
  if (!isRecord(value)) return null;
  if (value.type !== 'text') return null;
  if (typeof value.text !== 'string') return null;
  return { type: 'text', text: value.text };
}

function parseToolCallStatus(value: unknown): AcpToolCallStatus | null {
  const found = ACP_TOOL_CALL_STATUSES.find((status) => status === value);
  return found ?? null;
}

type SessionUpdateParse =
  | { ok: true; update: AcpSessionUpdate }
  | { ok: false; detail: string };

function parseSessionUpdatePayload(value: unknown): SessionUpdateParse {
  if (!isRecord(value)) {
    return { ok: false, detail: 'update is not an object' };
  }
  const wireKind = value.sessionUpdate;
  if (typeof wireKind !== 'string') {
    return { ok: false, detail: 'update.sessionUpdate is not a string' };
  }

  if (wireKind === 'agent_message_chunk') {
    const content = parseContentText(value.content);
    if (content === null) {
      // Non-text chunk content (image, audio, …) is not modelled yet —
      // preserve it instead of erroring so richer agents still stream.
      return {
        ok: true,
        update: { sessionUpdate: 'unrecognized', wireKind, raw: value },
      };
    }
    return { ok: true, update: { sessionUpdate: 'agent_message_chunk', content } };
  }

  if (wireKind === 'tool_call') {
    if (typeof value.toolCallId !== 'string' || value.toolCallId.length === 0) {
      return { ok: false, detail: 'tool_call missing toolCallId' };
    }
    if (typeof value.title !== 'string') {
      return { ok: false, detail: 'tool_call missing title' };
    }
    const status = parseToolCallStatus(value.status);
    if (status === null) {
      return {
        ok: false,
        detail: `tool_call has invalid status: ${JSON.stringify(value.status)}`,
      };
    }
    const update: AcpToolCallUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: value.toolCallId,
      title: value.title,
      status,
    };
    if (typeof value.kind === 'string') update.kind = value.kind;
    if ('rawInput' in value) update.rawInput = value.rawInput;
    return { ok: true, update };
  }

  if (wireKind === 'tool_call_update') {
    if (typeof value.toolCallId !== 'string' || value.toolCallId.length === 0) {
      return { ok: false, detail: 'tool_call_update missing toolCallId' };
    }
    const update: AcpToolCallProgressUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: value.toolCallId,
    };
    if ('status' in value && value.status !== undefined) {
      const status = parseToolCallStatus(value.status);
      if (status === null) {
        return {
          ok: false,
          detail: `tool_call_update has invalid status: ${JSON.stringify(value.status)}`,
        };
      }
      update.status = status;
    }
    if ('content' in value) update.content = value.content;
    return { ok: true, update };
  }

  return {
    ok: true,
    update: { sessionUpdate: 'unrecognized', wireKind, raw: value },
  };
}

/**
 * Parse one NDJSON line of agent stdout into a typed inbound message.
 *
 * Never throws. Malformed lines return explicit, discriminated errors so the
 * caller can decide severity: `line-too-long` means a rogue peer (fatal);
 * `invalid-json` / malformed shapes are skippable diagnostics, matching the
 * buzz harness behaviour of skipping unparseable lines.
 */
export function parseAcpLine(
  line: string,
  maxLineBytes: number = ACP_MAX_LINE_BYTES,
): AcpParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: false, error: { code: 'empty-line' } };
  if (utf8LengthExceeds(trimmed, maxLineBytes)) {
    return { ok: false, error: { code: 'line-too-long', maxBytes: maxLineBytes } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'invalid-json', detail } };
  }

  if (!isRecord(parsed)) return { ok: false, error: { code: 'not-an-object' } };
  if (parsed.jsonrpc !== '2.0') {
    return {
      ok: false,
      error: { code: 'missing-jsonrpc-version', found: parsed.jsonrpc },
    };
  }

  const rawMethod = parsed.method;
  if (rawMethod !== undefined) {
    if (typeof rawMethod !== 'string') {
      return {
        ok: false,
        error: { code: 'malformed-response', detail: 'method is not a string' },
      };
    }
    const params = isRecord(parsed.params) ? parsed.params : undefined;

    if (rawMethod === ACP_METHODS.sessionUpdate) {
      if (params === undefined || typeof params.sessionId !== 'string') {
        return {
          ok: false,
          error: {
            code: 'malformed-session-update',
            detail: 'session/update missing params.sessionId',
          },
        };
      }
      const updateParse = parseSessionUpdatePayload(params.update);
      if (!updateParse.ok) {
        return {
          ok: false,
          error: { code: 'malformed-session-update', detail: updateParse.detail },
        };
      }
      return {
        ok: true,
        message: {
          kind: 'session-update',
          sessionId: params.sessionId,
          update: updateParse.update,
        },
      };
    }

    if (isJsonRpcId(parsed.id)) {
      return {
        ok: true,
        message: { kind: 'agent-request', id: parsed.id, method: rawMethod, params },
      };
    }
    return {
      ok: true,
      message: { kind: 'agent-notification', method: rawMethod, params },
    };
  }

  // No method → this is a response frame (success or error).
  if (isRecord(parsed.error)) {
    const code =
      typeof parsed.error.code === 'number' ? parsed.error.code : -32000;
    // When `message` is missing/non-string, fall back to the full error
    // object so provider-specific detail (e.g. `data`) is not lost.
    const message =
      typeof parsed.error.message === 'string'
        ? parsed.error.message
        : JSON.stringify(parsed.error);
    const inbound: Extract<AcpInboundMessage, { kind: 'error-response' }> = {
      kind: 'error-response',
      id: isJsonRpcId(parsed.id) ? parsed.id : null,
      code,
      message,
    };
    if ('data' in parsed.error) inbound.data = parsed.error.data;
    return { ok: true, message: inbound };
  }

  if ('result' in parsed) {
    if (!isJsonRpcId(parsed.id)) {
      return {
        ok: false,
        error: { code: 'malformed-response', detail: 'response has no valid id' },
      };
    }
    return {
      ok: true,
      message: { kind: 'response', id: parsed.id, result: parsed.result },
    };
  }

  return {
    ok: false,
    error: {
      code: 'malformed-response',
      detail: 'frame has neither method, result nor error',
    },
  };
}

// ---------------------------------------------------------------------------
// Result validators for the three request methods
// ---------------------------------------------------------------------------

export type AcpResultParse<T> =
  | { ok: true; value: T }
  | { ok: false; detail: string };

export function parseInitializeResult(
  result: unknown,
): AcpResultParse<AcpInitializeResult> {
  if (!isRecord(result)) {
    return { ok: false, detail: 'initialize result is not an object' };
  }
  if (typeof result.protocolVersion !== 'number') {
    return { ok: false, detail: 'initialize result missing protocolVersion' };
  }
  if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
    return {
      ok: false,
      detail:
        `initialize protocolVersion ${result.protocolVersion} is incompatible with ${ACP_PROTOCOL_VERSION}`,
    };
  }
  const capabilities = isRecord(result.agentCapabilities)
    ? (result.agentCapabilities as AcpAgentCapabilities)
    : {};
  const value: AcpInitializeResult = {
    protocolVersion: result.protocolVersion,
    agentCapabilities: capabilities,
  };
  if (
    isRecord(result.agentInfo) &&
    typeof result.agentInfo.name === 'string' &&
    typeof result.agentInfo.version === 'string'
  ) {
    value.agentInfo = {
      name: result.agentInfo.name,
      version: result.agentInfo.version,
    };
  }
  return { ok: true, value };
}

export function parseSessionNewResult(
  result: unknown,
): AcpResultParse<AcpSessionNewResult> {
  if (!isRecord(result) || typeof result.sessionId !== 'string') {
    return { ok: false, detail: 'session/new response missing sessionId' };
  }
  if (result.sessionId.length === 0) {
    return { ok: false, detail: 'session/new response has empty sessionId' };
  }
  return { ok: true, value: { sessionId: result.sessionId } };
}

export function parseSessionPromptResult(
  result: unknown,
): AcpResultParse<AcpStopReason> {
  if (!isRecord(result)) {
    return { ok: false, detail: 'session/prompt result is not an object' };
  }
  const stopReason = parseAcpStopReason(result.stopReason);
  if (stopReason === null) {
    return {
      ok: false,
      detail: `session/prompt result has unknown stopReason: ${JSON.stringify(result.stopReason)}`,
    };
  }
  return { ok: true, value: stopReason };
}

// ---------------------------------------------------------------------------
// Outbound frame builders (client stdin → agent)
// ---------------------------------------------------------------------------

export function buildRequestFrame(
  id: JsonRpcId,
  method: string,
  params: unknown,
): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

/** Notifications deliberately have NO `id` field (JSON-RPC 2.0). */
export function buildNotificationFrame(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
}

export function buildResponseFrame(id: JsonRpcId, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

export function buildErrorResponseFrame(
  id: JsonRpcId,
  code: number,
  message: string,
): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`;
}

// ---------------------------------------------------------------------------
// Incremental NDJSON decoder (frame-per-line, bounded)
// ---------------------------------------------------------------------------

export interface NdjsonPushResult {
  /** Complete lines extracted from the stream so far (without newline). */
  lines: readonly string[];
  /**
   * Non-null when the stream violated the line-size bound. The decoder is
   * poisoned from this point on — the peer must be treated as rogue and
   * killed by the caller (bounded-everything: a peer writing infinite
   * non-newline bytes must not OOM the client).
   */
  fatal: AcpParseError | null;
}

export class AcpNdjsonDecoder {
  private buffer = '';
  private poisonedWith: AcpParseError | null = null;
  private readonly utf8 = new TextDecoder('utf-8');

  constructor(private readonly maxLineBytes: number = ACP_MAX_LINE_BYTES) {}

  get poisoned(): boolean {
    return this.poisonedWith !== null;
  }

  push(chunk: string | Uint8Array): NdjsonPushResult {
    if (this.poisonedWith !== null) {
      return { lines: [], fatal: this.poisonedWith };
    }
    // TextDecoder with stream:true handles multi-byte chars split across
    // chunk boundaries — Buffer#toString would corrupt them.
    this.buffer +=
      typeof chunk === 'string' ? chunk : this.utf8.decode(chunk, { stream: true });

    const lines: string[] = [];
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (utf8LengthExceeds(line, this.maxLineBytes)) {
        this.poisonedWith = { code: 'line-too-long', maxBytes: this.maxLineBytes };
        return { lines, fatal: this.poisonedWith };
      }
      lines.push(line);
      newlineIndex = this.buffer.indexOf('\n');
    }

    // A newline-less remainder growing past the cap is the classic rogue-peer
    // OOM vector — poison as soon as the bound is crossed, not at newline.
    if (utf8LengthExceeds(this.buffer, this.maxLineBytes)) {
      this.buffer = '';
      this.poisonedWith = { code: 'line-too-long', maxBytes: this.maxLineBytes };
      return { lines, fatal: this.poisonedWith };
    }

    return { lines, fatal: null };
  }
}
