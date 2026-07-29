import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { promiseHooks } from "node:v8";
import {
  getContextBySession,
  isCurrentGateContext,
  type AgentGateContext,
} from "./gate";

export type AgentTransportProvenanceSource = "http-mcp" | "pty-stream";

/**
 * Opaque, one-shot proof minted while an authenticated CLI handoff is inside
 * the localhost HTTP MCP or Main-observed PTY-stream boundary. It
 * intentionally has no serializable fields.
 */
export interface AgentTransportPhysicalReceipt {
  readonly __opaqueAgentTransportPhysicalReceipt: never;
}

interface AgentTransportBinding {
  live: boolean;
  readonly source: AgentTransportProvenanceSource;
  readonly requestId: string;
  readonly token: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly missionId?: string;
  readonly sessionId?: string;
  readonly workerIncarnationId?: string;
  readonly issuedInvocationIds: Set<string>;
}

export type PhysicalAgentToolName =
  | "nexus_handoff_submit"
  | "nexus_handoff_ack"
  | "nexus_mission_set_status";

interface PendingReceipt {
  readonly source: AgentTransportProvenanceSource;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: PhysicalAgentToolName;
  readonly missionId: string;
  readonly sessionId: string;
  readonly workerIncarnationId?: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly authoritySeed: Buffer;
  readonly issuedAt: number;
}

export interface ConsumedAgentTransportPhysicalReceipt {
  readonly source: AgentTransportProvenanceSource;
  readonly toolCallId: string;
  readonly toolName: PhysicalAgentToolName;
  readonly missionId: string;
  readonly sessionId: string;
  readonly workerIncarnationId?: string;
  readonly authoritySha256: string;
  readonly issuedAt: number;
}

export interface AgentTransportPhysicalReceiptExpectation {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly missionId: string;
  readonly sessionId: string;
  readonly workerIncarnationId?: string;
  readonly worktreeHeadSha?: string;
  readonly rawPayloadSha256?: string;
}

const activeAgentTransports = new AsyncLocalStorage<AgentTransportBinding>();
const enteredHttpRequests = new WeakSet<IncomingMessage>();
const pendingReceipts = new WeakMap<object, PendingReceipt>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as PromiseLike<unknown>).then === "function";
}

/**
 * AsyncLocalStorage propagates a binding to child async resources even after
 * `run()` returns. The mutable liveness bit therefore is the actual authority
 * lifetime: synchronous operations revoke it on return/throw, and asynchronous
 * operations revoke it when the returned promise settles.
 */
function runWithLiveTransport<T>(
  binding: AgentTransportBinding,
  operation: () => T,
): T {
  const observedPromises = new WeakSet<Promise<unknown>>();
  const settledPromises = new WeakSet<Promise<unknown>>();
  let settlementPromise: Promise<unknown> | undefined;
  let closed = false;
  let stopSettlementTracking = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    binding.live = false;
    stopSettlementTracking();
  };

  // Promise reactions run in registration order. A `.finally(close)` attached
  // after `operation()` returns is therefore too late when the operation first
  // registered its own `.then(...)` on the same result promise. V8's settled
  // hook runs before any of those reactions and closes the physical authority
  // at the promise's logical settlement boundary.
  stopSettlementTracking = promiseHooks.createHook({
    init(promise) {
      observedPromises.add(promise);
    },
    settled(promise) {
      settledPromises.add(promise);
      if (promise === settlementPromise) close();
    },
  }) as () => void;

  let result: T;
  let returnsPromise: boolean;
  try {
    result = activeAgentTransports.run(binding, operation);
    returnsPromise = isPromiseLike(result);
  } catch (error) {
    close();
    throw error;
  }
  if (returnsPromise) {
    const returnedPromise = result as unknown as Promise<unknown>;
    // A promise created before this physical operation cannot be fenced at its
    // settlement point: it may already have settled while no hook observed it.
    // Fail closed instead of granting its retained async resources authority.
    if (
      !observedPromises.has(returnedPromise) ||
      settledPromises.has(returnedPromise)
    ) {
      close();
    } else {
      settlementPromise = returnedPromise;
    }
    return Promise.resolve(result).finally(close) as T;
  }
  close();
  return result;
}

function sameOptional(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return (left ?? undefined) === (right ?? undefined);
}

function authoritySeed(
  binding: AgentTransportBinding,
  toolCallId: string,
): Buffer {
  return createHmac("sha256", binding.token)
    .update(
      [
        "nexus-handoff-agent-transport-authority-v4",
        binding.source,
        binding.requestId,
        binding.projectId,
        binding.checkoutId,
        binding.missionId ?? "",
        binding.sessionId ?? "",
        binding.workerIncarnationId ?? "",
        toolCallId,
      ].join("\0"),
    )
    .digest();
}

function authorityFingerprint(
  seed: Buffer,
  worktreeHeadSha: string | undefined,
  rawPayloadSha256: string | undefined,
): string {
  return createHmac("sha256", seed)
    .update("nexus-handoff-agent-transport-receipt-v4")
    .update("\0")
    .update(worktreeHeadSha ?? "")
    .update("\0")
    .update(rawPayloadSha256 ?? "")
    .digest("hex");
}

function isLoopbackAddress(value: string | undefined): boolean {
  return (
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"
  );
}

function assertPhysicalHttpRequest(
  request: IncomingMessage,
  ctx: AgentGateContext,
): void {
  if (
    !(request instanceof IncomingMessage) ||
    request.method !== "POST" ||
    !(request.url === "/mcp" || request.url?.startsWith("/mcp?")) ||
    request.headers.authorization !== `Bearer ${ctx.token}` ||
    !isLoopbackAddress(request.socket.remoteAddress) ||
    !isLoopbackAddress(request.socket.localAddress) ||
    request.complete !== true ||
    !isCurrentGateContext(ctx)
  ) {
    throw new Error(
      "handoff_provenance: authenticated loopback HTTP MCP request is required",
    );
  }
}

/**
 * Transport owner seam. Production ownership is deliberately restricted to
 * mcp-server.ts; the architecture test rejects any other non-test importer.
 */
export function runInsideHttpMcpTransport<T>(
  request: IncomingMessage,
  ctx: AgentGateContext,
  operation: () => T,
): T {
  assertPhysicalHttpRequest(request, ctx);
  if (
    enteredHttpRequests.has(request) ||
    activeAgentTransports.getStore() !== undefined
  ) {
    throw new Error(
      "handoff_provenance: HTTP MCP request boundary cannot be replayed or nested",
    );
  }
  enteredHttpRequests.add(request);
  const binding: AgentTransportBinding = {
    live: true,
    source: "http-mcp",
    requestId: randomUUID(),
    token: ctx.token,
    projectId: ctx.scope.projectId,
    checkoutId: ctx.scope.checkoutId,
    missionId: ctx.missionId,
    sessionId: ctx.sessionId,
    workerIncarnationId: ctx.workerIncarnationId,
    issuedInvocationIds: new Set(),
  };
  return runWithLiveTransport(binding, operation);
}

/**
 * Provider-independent physical boundary for one parsed PTY agent action.
 *
 * The session id comes from the PTY manager's data tap, never from terminal
 * text. Main then requires that exact live session to still own a mission
 * worker (with its incarnation) or the current Maestro bearer. This lets CLIs
 * without a usable MCP configuration channel invoke governed Nexus actions
 * and complete work without writing to the user's provider config.
 */
export function runInsidePtyStreamAgentTransport<T>(
  sessionId: string,
  ctx: AgentGateContext,
  operation: () => T,
): T {
  if (
    !sessionId ||
    (ctx.role !== "worker" && ctx.role !== "orchestrator") ||
    ctx.sessionId !== sessionId ||
    !ctx.missionId ||
    (ctx.role === "worker" && !ctx.workerIncarnationId) ||
    (ctx.role === "orchestrator" && ctx.workerIncarnationId !== undefined) ||
    getContextBySession(sessionId) !== ctx ||
    !isCurrentGateContext(ctx)
  ) {
    throw new Error(
      "handoff_provenance: current physical PTY mission session is required",
    );
  }
  if (activeAgentTransports.getStore() !== undefined) {
    throw new Error(
      "handoff_provenance: PTY stream boundary cannot be nested",
    );
  }
  const binding: AgentTransportBinding = {
    live: true,
    source: "pty-stream",
    requestId: randomUUID(),
    token: ctx.token,
    projectId: ctx.scope.projectId,
    checkoutId: ctx.scope.checkoutId,
    missionId: ctx.missionId,
    sessionId,
    workerIncarnationId: ctx.workerIncarnationId,
    issuedInvocationIds: new Set(),
  };
  return runWithLiveTransport(binding, operation);
}

/**
 * Dispatcher/PTY ingest seam. A direct store call is insufficient: minting
 * also requires the active, physically authenticated CLI transport. These are
 * the three terminal orchestration actions whose durable receipts must prove
 * which physical worker/Maestro invocation produced them.
 */
export function mintAgentTransportPhysicalReceipt(input: {
  readonly ctx: AgentGateContext;
  readonly toolCallId: string;
  readonly toolName: string;
}): AgentTransportPhysicalReceipt {
  const active = activeAgentTransports.getStore();
  if (
    !active ||
    !active.live ||
    !(
      input.toolName === "nexus_handoff_submit" ||
      input.toolName === "nexus_handoff_ack" ||
      input.toolName === "nexus_mission_set_status"
    ) ||
    active.token !== input.ctx.token ||
    active.projectId !== input.ctx.scope.projectId ||
    active.checkoutId !== input.ctx.scope.checkoutId ||
    !sameOptional(active.missionId, input.ctx.missionId) ||
    !sameOptional(active.sessionId, input.ctx.sessionId) ||
    !sameOptional(active.workerIncarnationId, input.ctx.workerIncarnationId)
  ) {
    throw new Error(
      "handoff_provenance: authenticated physical agent transport boundary is required",
    );
  }
  if (!input.ctx.missionId || !input.ctx.sessionId) {
    throw new Error(
      "handoff_provenance: mission and physical session are required",
    );
  }
  if (active.issuedInvocationIds.has(input.toolCallId)) {
    throw new Error(
      "handoff_provenance: MCP invocation already has a physical receipt",
    );
  }
  active.issuedInvocationIds.add(input.toolCallId);
  const receipt = Object.freeze({}) as AgentTransportPhysicalReceipt;
  pendingReceipts.set(receipt as object, {
    source: active.source,
    requestId: active.requestId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    missionId: input.ctx.missionId,
    sessionId: input.ctx.sessionId,
    workerIncarnationId: input.ctx.workerIncarnationId,
    projectId: active.projectId,
    checkoutId: active.checkoutId,
    authoritySeed: authoritySeed(active, input.toolCallId),
    issuedAt: Date.now(),
  });
  return receipt;
}

function requireCurrentAgentTransportPhysicalReceipt(
  receipt: AgentTransportPhysicalReceipt,
  expected: AgentTransportPhysicalReceiptExpectation,
): { readonly opaque: object; readonly pending: PendingReceipt } {
  const active = activeAgentTransports.getStore();
  const opaque =
    typeof receipt === "object" && receipt !== null
      ? (receipt as object)
      : null;
  const pending = opaque ? pendingReceipts.get(opaque) : undefined;
  if (
    !active ||
    !active.live ||
    !opaque ||
    !pending ||
    pending.requestId !== active.requestId ||
    pending.projectId !== expected.projectId ||
    pending.checkoutId !== expected.checkoutId ||
    pending.missionId !== expected.missionId ||
    pending.sessionId !== expected.sessionId ||
    !sameOptional(pending.workerIncarnationId, expected.workerIncarnationId)
  ) {
    throw new Error(
      "handoff_provenance: invalid, stale or out-of-scope physical agent receipt",
    );
  }
  return { opaque, pending };
}

function snapshotAgentTransportPhysicalReceipt(
  pending: PendingReceipt,
  expected: AgentTransportPhysicalReceiptExpectation,
): ConsumedAgentTransportPhysicalReceipt {
  return Object.freeze({
    source: pending.source,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    missionId: pending.missionId,
    sessionId: pending.sessionId,
    workerIncarnationId: pending.workerIncarnationId,
    authoritySha256: authorityFingerprint(
      pending.authoritySeed,
      expected.worktreeHeadSha,
      expected.rawPayloadSha256,
    ),
    issuedAt: pending.issuedAt,
  });
}

/**
 * Read-only classification seam. It proves that the retry is inside the same
 * live physical boundary before the store knows whether a logical operation
 * already committed. Every accepted first write or exact replay must still
 * consume the receipt through the seam below before returning.
 */
export function inspectCurrentAgentTransportPhysicalReceipt(
  receipt: AgentTransportPhysicalReceipt,
  expected: AgentTransportPhysicalReceiptExpectation,
): ConsumedAgentTransportPhysicalReceipt {
  const { pending } = requireCurrentAgentTransportPhysicalReceipt(
    receipt,
    expected,
  );
  return snapshotAgentTransportPhysicalReceipt(pending, expected);
}

/**
 * Durable first-write seam. The receipt is consumed exactly once and only
 * while the same physical transport call is still active, then bound to the
 * exact store/input scope.
 */
export function consumeAgentTransportPhysicalReceipt(
  receipt: AgentTransportPhysicalReceipt,
  expected: AgentTransportPhysicalReceiptExpectation,
): ConsumedAgentTransportPhysicalReceipt {
  const { opaque, pending } = requireCurrentAgentTransportPhysicalReceipt(
    receipt,
    expected,
  );
  pendingReceipts.delete(opaque);
  return snapshotAgentTransportPhysicalReceipt(pending, expected);
}
