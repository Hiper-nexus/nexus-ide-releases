import { reserveLicensedAgent } from '../license-enforcement';
/**
 * ACP client — drives an ACP-speaking agent subprocess over stdio.
 *
 * Design distilled from block/buzz buzz-acp (Apache-2.0), `src/acp.rs` and
 * the buzz-agent README ("bounded everything"). Lifecycle:
 *
 *   1. AcpClient.spawn()      — launch harness binary, own its process group
 *   2. client.initialize()    — protocol version negotiation
 *   3. client.sessionNew()    — create a session (MCP server specs ride here)
 *   4. client.prompt()        — AsyncIterable of typed updates + stopReason
 *   5. turn.cancel()          — session/cancel with a bounded drain window
 *   6. client.shutdown()      — SIGKILL the process group, bounded wait
 *
 * Invariants:
 *  - Every exit path (timeout, protocol violation, agent error, peer death,
 *    backpressure, shutdown) kills the whole process TREE — grandchildren
 *    (MCP servers, tools) die too, on Windows as well; nothing is orphaned.
 *  - Every wait is bounded by a named constant, and so is every buffer.
 *    This client never hangs forever and never grows forever: that is the
 *    whole point of replacing terminal scraping.
 *  - Zero interleaving on stdin: writes are serialized per call and bounded
 *    by a write timeout (a peer that stops reading stdin is dead to us).
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { isAbsolute, win32 as pathWin32 } from 'node:path';

import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  AcpNdjsonDecoder,
  JSONRPC_METHOD_NOT_FOUND,
  buildErrorResponseFrame,
  buildNotificationFrame,
  buildRequestFrame,
  buildResponseFrame,
  parseAcpLine,
  parseInitializeResult,
  parseSessionNewResult,
  parseSessionPromptResult,
  type AcpInboundMessage,
  type AcpInitializeResult,
  type AcpMcpServerSpec,
  type AcpSessionUpdate,
  type AcpStopReason,
  type JsonRpcId,
} from '../../shared/acp-protocol';
import { isReservedHarnessEnvKey } from '../../shared/harness-catalog';

// ---------------------------------------------------------------------------
// Named timeout constants (defaults; each is overridable per client/turn)
// ---------------------------------------------------------------------------

/** Non-prompt RPCs (initialize, session/new) — buzz REQUEST_TIMEOUT is 60s. */
export const ACP_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Idle timeout for a prompt turn: max silence before the turn is killed.
 * Resets on ANY agent stdout activity (buzz BUZZ_ACP_IDLE_TIMEOUT = 620s).
 */
export const ACP_PROMPT_IDLE_TIMEOUT_MS = 620_000;

/**
 * Absolute wall-clock cap per turn — safety valve against agents that keep
 * producing output forever (buzz BUZZ_ACP_MAX_TURN_DURATION = 7200s).
 */
export const ACP_PROMPT_MAX_DURATION_MS = 7_200_000;

/** Max time a single stdin write may block before the peer is declared dead. */
export const ACP_WRITE_TIMEOUT_MS = 30_000;

/**
 * After session/cancel, max time the agent gets to acknowledge with a
 * `stopReason: "cancelled"` response before the process group is killed.
 */
export const ACP_CANCEL_DRAIN_TIMEOUT_MS = 30_000;

/** Bounded wait for the child to exit after SIGKILL during shutdown. */
export const ACP_SHUTDOWN_WAIT_MS = 5_000;

/** Bounded stderr tail retained for diagnostics on failure. */
const STDERR_TAIL_MAX_BYTES = 8 * 1024;

/**
 * Max turn events buffered for a consumer that has not drained them yet.
 *
 * Policy: FAIL, never drop-oldest. A dropped update is a hole in the mission's
 * transcript — the observer frames built from these events are the evidence
 * receipts and the journal are made of, so a silently truncated stream would
 * produce a receipt that lies about what the agent did. Backpressure is
 * therefore surfaced as a named error that runs the normal teardown funnel
 * (process group included), exactly like every other bound in this module.
 * The cap is high enough that reaching it means the consumer is dead, not
 * merely slow: a live `for await` loop never accumulates 10k events.
 */
export const ACP_TURN_EVENT_BUFFER_MAX = 10_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AcpClientErrorCode =
  | 'spawn-failed'
  | 'peer-exited'
  | 'request-timeout'
  | 'idle-timeout'
  | 'hard-timeout'
  | 'write-timeout'
  | 'cancel-drain-timeout'
  | 'protocol'
  | 'agent-error'
  | 'backpressure'
  | 'disposed';

export class AcpClientError extends Error {
  readonly code: AcpClientErrorCode;

  constructor(code: AcpClientErrorCode, message: string) {
    super(`[acp:${code}] ${message}`);
    this.name = 'AcpClientError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Turn events
// ---------------------------------------------------------------------------

export type AcpTurnEvent =
  | { type: 'update'; update: AcpSessionUpdate }
  | { type: 'stop'; stopReason: AcpStopReason };

export interface AcpTurnHandle extends AsyncIterable<AcpTurnEvent> {
  /** Request cancellation of this turn (bounded drain; never hangs). */
  cancel(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal plumbing
// ---------------------------------------------------------------------------

interface PendingRequest {
  method: string;
  timer: NodeJS.Timeout | null;
  settle(outcome: { ok: true; result: unknown } | { ok: false; error: AcpClientError }): void;
}

/**
 * Single-consumer push queue backing the turn's AsyncIterable. Buffered
 * events drain before a failure is thrown; settle operations after the
 * first finish/fail are ignored (multiple failure paths may race).
 *
 * Bounded by construction: a peer that streams faster than the consumer
 * drains hits `capacity` and triggers `onOverflow` instead of growing the
 * main process's heap without limit. Nothing already buffered is discarded —
 * the consumer still sees every event it was promised, then the failure.
 */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private done = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private overflowed = false;

  constructor(
    private readonly capacity: number,
    private readonly onOverflow: () => void,
  ) {}

  push(item: T): void {
    if (this.done) return;
    if (this.items.length >= this.capacity) {
      if (this.overflowed) return;
      this.overflowed = true;
      // The handler funnels through the client's teardown, which calls
      // fail() on this queue — the buffered events survive that call.
      this.onOverflow();
      return;
    }
    this.items.push(item);
    this.notify();
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.notify();
  }

  fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.failure = error;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    if (wake) wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

interface ActiveTurn {
  sessionId: string;
  queue: AsyncEventQueue<AcpTurnEvent>;
  idleTimer: NodeJS.Timeout | null;
  hardTimer: NodeJS.Timeout | null;
  drainTimer: NodeJS.Timeout | null;
  idleTimeoutMs: number;
}

export interface AcpSpawnOptions {
  command: string;
  args?: readonly string[];
  /** Merged over process.env. Reserved-key stripping happens upstream. */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  writeTimeoutMs?: number;
  cancelDrainTimeoutMs?: number;
  /** Max unconsumed turn events buffered before backpressure fails the turn. */
  turnEventBufferMax?: number;
  /** Main-owned UI callback for agent-initiated permission requests. */
  requestPermission?: (
    params: Record<string, unknown> | undefined,
  ) => Promise<unknown>;
}

export interface AcpPromptOptions {
  idleTimeoutMs?: number;
  maxDurationMs?: number;
}

export interface AcpDiagnostic {
  at: number;
  detail: string;
}

function validateSpawnOptions(options: AcpSpawnOptions): void {
  if (!options.command.trim() || options.command.includes('\0')) {
    throw new AcpClientError(
      'spawn-failed',
      'ACP harness command must be a non-empty string without NUL',
    );
  }
  for (const [index, arg] of (options.args ?? []).entries()) {
    if (arg.includes('\0')) {
      throw new AcpClientError(
        'spawn-failed',
        `ACP harness argument ${index} contains a NUL byte`,
      );
    }
  }
  if (
    options.cwd !== undefined &&
    (!isAbsolute(options.cwd) || options.cwd.includes('\0'))
  ) {
    throw new AcpClientError(
      'spawn-failed',
      'ACP harness cwd must be an absolute path without NUL',
    );
  }
}

/**
 * Build the child's environment with the reserved Nexus identity keys removed.
 *
 * The strip is case-insensitive because Windows resolves env vars that way:
 * a definition carrying `nexus_mcp_token` would otherwise reach the child as
 * the very variable the reserved list protects. Same input, same environment,
 * on every platform. Exported for unit testing.
 */
export function sanitizeHarnessSpawnEnv(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base, ...(extra ?? {}) };
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (isReservedHarnessEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Options a Windows tree kill or a POSIX group kill needs; injectable for tests. */
export interface AcpProcessTreeKillDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => {
    unref?: () => void;
    on?: (event: 'error', listener: (error: Error) => void) => unknown;
  };
  readonly signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly systemRoot?: string;
}

/**
 * Kill the harness and everything it spawned.
 *
 * POSIX: the child owns its process group (`detached`), so SIGKILL to `-pid`
 * takes the grandchildren (MCP servers, tools) with it.
 *
 * Windows has no process groups: `child.kill()` reaps only the direct child
 * and leaves its descendants running. The repo's established answer is
 * `taskkill /T /F` with a fixed absolute path and no shell (same call the
 * dembrandt runner and the packaged-app smoke use); it is fire-and-forget
 * here because `destroy()` is synchronous — `shutdown()`'s bounded
 * `waitForExit` is what observes the result.
 *
 * Best-effort by contract: the process may already be gone.
 */
export function killHarnessProcessTree(
  child: {
    readonly pid?: number | undefined;
    kill(signal?: NodeJS.Signals): boolean;
  },
  deps: AcpProcessTreeKillDeps = {},
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const platform = deps.platform ?? process.platform;
  const spawnProcess = deps.spawnProcess ?? spawn;
  const signalProcessGroup =
    deps.signalProcessGroup ??
    ((target: number, signal: NodeJS.Signals) => {
      process.kill(target, signal);
    });

  try {
    if (platform === 'win32') {
      // Stop the direct child first so it cannot spawn more descendants
      // while taskkill walks the tree.
      try {
        child.kill();
      } catch {
        // taskkill below is the authoritative Windows teardown.
      }
      const systemRoot =
        deps.systemRoot ??
        process.env.SystemRoot ??
        process.env.windir ??
        'C:\\Windows';
      const killer = spawnProcess(
        pathWin32.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/pid', String(pid), '/T', '/F'],
        { stdio: 'ignore', shell: false, windowsHide: true },
      );
      // A missing/blocked taskkill.exe emits 'error'; with no listener Node
      // turns that into an uncaught exception in the main process. Teardown
      // is best-effort and must never take the app down with it.
      killer.on?.('error', () => {});
      killer.unref?.();
      return;
    }
    signalProcessGroup(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AcpClient {
  private readonly child: ChildProcess;
  private readonly decoder = new AcpNdjsonDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly cancelDrainTimeoutMs: number;
  private readonly turnEventBufferMax: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly requestPermission:
    | ((params: Record<string, unknown> | undefined) => Promise<unknown>)
    | undefined;
  private readonly diagnosticsBuffer: AcpDiagnostic[] = [];
  private nextRequestId = 0;
  private activeTurn: ActiveTurn | null = null;
  private initialized = false;
  private disposedWith: AcpClientError | null = null;
  private stderrTail = '';
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  private readonly exitWaiters: Array<() => void> = [];

  private constructor(child: ChildProcess, options: AcpSpawnOptions) {
    this.child = child;
    this.requestTimeoutMs = options.requestTimeoutMs ?? ACP_REQUEST_TIMEOUT_MS;
    this.writeTimeoutMs = options.writeTimeoutMs ?? ACP_WRITE_TIMEOUT_MS;
    this.cancelDrainTimeoutMs =
      options.cancelDrainTimeoutMs ?? ACP_CANCEL_DRAIN_TIMEOUT_MS;
    this.turnEventBufferMax =
      options.turnEventBufferMax !== undefined && options.turnEventBufferMax > 0
        ? Math.floor(options.turnEventBufferMax)
        : ACP_TURN_EVENT_BUFFER_MAX;
    this.clientName = options.clientName ?? 'nexus-ide';
    this.clientVersion = options.clientVersion ?? '0.1.0';
    this.requestPermission = options.requestPermission;
  }

  /**
   * Spawn the harness binary and wire the stdio pipes.
   *
   * The child gets its own process group (unix `detached`) so that killing
   * it also kills grandchildren — the buzz `setpgid(0,0)` + `killpg` model.
   */
  static spawn(options: AcpSpawnOptions): AcpClient {
    validateSpawnOptions(options);
    const release = reserveLicensedAgent();
    let child: ChildProcess | undefined;
    try {
    child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: sanitizeHarnessSpawnEnv(process.env, options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.once('exit', release);
    child.once('error', () => { if (child?.pid === undefined) release(); });
    const client = new AcpClient(child, options);
    client.attach();
    return client;
    } catch (error) {
      if (!child) release();
      else killHarnessProcessTree(child);
      throw error;
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get disposed(): boolean {
    return this.disposedWith !== null;
  }

  /** Bounded diagnostics ring for skipped/unroutable frames. */
  get diagnostics(): readonly AcpDiagnostic[] {
    return this.diagnosticsBuffer;
  }

  private attach(): void {
    this.child.on('error', (error: Error) => {
      this.destroy(new AcpClientError('spawn-failed', error.message));
    });
    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      for (const waiter of this.exitWaiters.splice(0)) waiter();
      if (this.disposedWith === null) {
        this.destroy(
          new AcpClientError(
            'peer-exited',
            `agent process exited unexpectedly (code=${String(code)} signal=${String(
              signal,
            )})${this.stderrTail ? ` — stderr tail: ${this.stderrTail.trim()}` : ''}`,
          ),
        );
      }
    });
    this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(
        -STDERR_TAIL_MAX_BYTES,
      );
    });
    // A peer closing stdin on us surfaces via write errors; swallow the
    // EPIPE event so it does not become an uncaught exception.
    this.child.stdin?.on('error', () => {});
  }

  // -- lifecycle ------------------------------------------------------------

  /** Send `initialize`. Must be called exactly once, before anything else. */
  async initialize(): Promise<AcpInitializeResult> {
    if (this.initialized) {
      throw new AcpClientError('protocol', 'initialize called twice');
    }
    this.initialized = true;
    const result = await this.sendRequest(
      ACP_METHODS.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion },
      },
      this.requestTimeoutMs,
    );
    const parsed = parseInitializeResult(result);
    if (!parsed.ok) {
      const error = new AcpClientError('protocol', parsed.detail);
      this.destroy(error);
      throw error;
    }
    return parsed.value;
  }

  /** Send `session/new`; `cwd` must be absolute, `mcpServers` may be empty. */
  async sessionNew(
    cwd: string,
    mcpServers: readonly AcpMcpServerSpec[] = [],
  ): Promise<string> {
    if (!isAbsolute(cwd) || cwd.includes('\0')) {
      const error = new AcpClientError(
        'protocol',
        'session/new cwd must be an absolute path without NUL',
      );
      this.destroy(error);
      throw error;
    }
    const result = await this.sendRequest(
      ACP_METHODS.sessionNew,
      { cwd, mcpServers },
      this.requestTimeoutMs,
    );
    const parsed = parseSessionNewResult(result);
    if (!parsed.ok) {
      const error = new AcpClientError('protocol', parsed.detail);
      this.destroy(error);
      throw error;
    }
    return parsed.value.sessionId;
  }

  /**
   * Send `session/prompt` and stream the turn as typed events.
   *
   * The iterable yields `update` events for every `session/update` of this
   * session, then exactly one `stop` event when the prompt response lands.
   * On idle timeout, hard timeout, peer death or protocol violation the
   * iterable throws an `AcpClientError` — after the process group has
   * already been killed. It never hangs.
   */
  prompt(
    sessionId: string,
    promptText: string,
    options: AcpPromptOptions = {},
  ): AcpTurnHandle {
    if (this.activeTurn !== null) {
      throw new AcpClientError(
        'protocol',
        'a prompt is already in flight on this client',
      );
    }
    if (this.disposedWith !== null) {
      throw new AcpClientError('disposed', this.disposedWith.message);
    }

    const idleTimeoutMs = options.idleTimeoutMs ?? ACP_PROMPT_IDLE_TIMEOUT_MS;
    const maxDurationMs = options.maxDurationMs ?? ACP_PROMPT_MAX_DURATION_MS;
    const bufferMax = this.turnEventBufferMax;
    const queue = new AsyncEventQueue<AcpTurnEvent>(bufferMax, () => {
      this.destroy(
        new AcpClientError(
          'backpressure',
          `turn buffered ${bufferMax} unconsumed events without being drained`,
        ),
      );
    });
    const turn: ActiveTurn = {
      sessionId,
      queue,
      idleTimer: null,
      hardTimer: null,
      drainTimer: null,
      idleTimeoutMs,
    };
    this.activeTurn = turn;

    turn.hardTimer = setTimeout(() => {
      this.destroy(
        new AcpClientError(
          'hard-timeout',
          `turn exceeded max duration of ${maxDurationMs}ms`,
        ),
      );
    }, maxDurationMs);
    this.resetIdleTimer(turn);

    void this.sendRequest(
      ACP_METHODS.sessionPrompt,
      { sessionId, prompt: [{ type: 'text', text: promptText }] },
      // The prompt is governed by the idle/hard timers, not a request timer.
      null,
    )
      .then((result) => {
        const parsed = parseSessionPromptResult(result);
        if (!parsed.ok) {
          this.destroy(new AcpClientError('protocol', parsed.detail));
          return;
        }
        this.settleTurn(turn);
        queue.push({ type: 'stop', stopReason: parsed.value });
        queue.finish();
      })
      .catch((error: unknown) => {
        this.settleTurn(turn);
        queue.fail(
          error instanceof AcpClientError
            ? error
            : new AcpClientError('protocol', String(error)),
        );
      });

    const cancel = (): Promise<void> => this.cancel(sessionId);
    return {
      cancel,
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  /**
   * Send a `session/cancel` notification (no id, no response expected) and
   * arm the bounded drain window: if the agent does not answer the in-flight
   * prompt with `stopReason: "cancelled"` in time, the process group dies.
   * No-op when no matching turn is in flight.
   */
  async cancel(sessionId: string): Promise<void> {
    const turn = this.activeTurn;
    if (turn === null || turn.sessionId !== sessionId) return;
    await this.writeFrame(
      buildNotificationFrame(ACP_METHODS.sessionCancel, { sessionId }),
    );
    if (turn.drainTimer === null && this.activeTurn === turn) {
      turn.drainTimer = setTimeout(() => {
        this.destroy(
          new AcpClientError(
            'cancel-drain-timeout',
            `agent did not stop within ${this.cancelDrainTimeoutMs}ms after session/cancel`,
          ),
        );
      }, this.cancelDrainTimeoutMs);
    }
  }

  /** Kill the process group and wait (bounded) for the child to exit. */
  async shutdown(): Promise<void> {
    this.destroy(new AcpClientError('disposed', 'client shut down'), {
      silentTurn: true,
    });
    await this.waitForExit(ACP_SHUTDOWN_WAIT_MS);
  }

  /**
   * Resolve with `{code, signal}` once the child exits, or `null` if it is
   * still alive after `timeoutMs` (never waits forever).
   */
  async waitForExit(
    timeoutMs: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
    if (this.exitInfo !== null) return this.exitInfo;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.exitInfo;
  }

  // -- inbound dispatch -----------------------------------------------------

  private onStdout(chunk: Buffer): void {
    if (this.disposedWith !== null) return;
    // Any stdout activity counts as liveness — reset the idle deadline
    // before parsing, exactly like buzz's idle-aware read loop.
    if (this.activeTurn) this.resetIdleTimer(this.activeTurn);

    const { lines, fatal } = this.decoder.push(chunk);
    for (const line of lines) {
      this.dispatchLine(line);
      if (this.disposedWith !== null) return;
    }
    if (fatal) {
      this.destroy(
        new AcpClientError(
          'protocol',
          `agent stdout line exceeded ${fatal.code === 'line-too-long' ? fatal.maxBytes : 0} bytes`,
        ),
      );
    }
  }

  private dispatchLine(line: string): void {
    const parsed = parseAcpLine(line);
    if (!parsed.ok) {
      if (parsed.error.code === 'empty-line') return;
      if (parsed.error.code === 'line-too-long') {
        this.destroy(
          new AcpClientError(
            'protocol',
            `agent stdout line exceeded ${parsed.error.maxBytes} bytes`,
          ),
        );
        return;
      }
      // Unparseable lines are skipped with a diagnostic (buzz behaviour) —
      // agents may interleave stray logging on stdout.
      this.recordDiagnostic(
        `skipped unparseable line (${parsed.error.code}): ${line.slice(0, 200)}`,
      );
      return;
    }
    this.dispatchMessage(parsed.message);
  }

  private dispatchMessage(message: AcpInboundMessage): void {
    switch (message.kind) {
      case 'response': {
        this.settleResponse(message.id, { ok: true, result: message.result });
        return;
      }
      case 'error-response': {
        if (message.id === null) {
          this.recordDiagnostic(`agent error without id: ${message.message}`);
          return;
        }
        const error = new AcpClientError(
          'agent-error',
          `agent reported error (code ${message.code}): ${message.message}`,
        );
        const routed = this.settleResponse(message.id, { ok: false, error });
        // This client only ever sends mandatory RPCs (initialize, session/new,
        // session/prompt): an agent that fails one of them has ended the
        // session, so the failure takes the same teardown funnel as every
        // other one. Without this the subprocess (and its MCP grandchildren)
        // would outlive the failed turn as orphans.
        if (routed) this.destroy(error);
        return;
      }
      case 'session-update': {
        const turn = this.activeTurn;
        if (turn === null || turn.sessionId !== message.sessionId) {
          this.recordDiagnostic(
            `session/update for inactive session ${message.sessionId}`,
          );
          return;
        }
        turn.queue.push({ type: 'update', update: message.update });
        return;
      }
      case 'agent-request': {
        void this.answerAgentRequest(message.id, message.method, message.params);
        return;
      }
      case 'agent-notification': {
        this.recordDiagnostic(`ignored agent notification: ${message.method}`);
        return;
      }
    }
  }

  /**
   * Agent-initiated requests must never be left unanswered — silence would
   * hang the agent (and therefore the turn). Increment 1 has no interactive
   * permission UI, so `session/request_permission` is answered with a
   * `cancelled` outcome; everything else gets JSON-RPC -32601.
   */
  private async answerAgentRequest(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    let frame: string;
    if (method === ACP_METHODS.sessionRequestPermission) {
      let result: unknown = { outcome: { outcome: 'cancelled' } };
      if (this.requestPermission) {
        try {
          result = await this.requestPermission(params);
        } catch (error) {
          this.recordDiagnostic(`permission UI failed: ${String(error)}`);
        }
      }
      frame = buildResponseFrame(id, result);
    } else {
      frame = buildErrorResponseFrame(
        id,
        JSONRPC_METHOD_NOT_FOUND,
        `Method not found: ${method}`,
      );
    }
    this.writeFrame(frame).catch((error: unknown) => {
      this.recordDiagnostic(
        `failed to answer agent request ${method}: ${String(error)}`,
      );
    });
  }

  /** Returns whether the frame actually settled one of our own requests. */
  private settleResponse(
    id: JsonRpcId,
    outcome: { ok: true; result: unknown } | { ok: false; error: AcpClientError },
  ): boolean {
    const key = String(id);
    const pendingRequest = this.pending.get(key);
    if (pendingRequest === undefined) {
      this.recordDiagnostic(`response for unknown request id ${key}`);
      return false;
    }
    this.pending.delete(key);
    if (pendingRequest.timer !== null) clearTimeout(pendingRequest.timer);
    pendingRequest.settle(outcome);
    return true;
  }

  // -- outbound -------------------------------------------------------------

  private sendRequest(
    method: string,
    params: unknown,
    timeoutMs: number | null,
  ): Promise<unknown> {
    if (this.disposedWith !== null) {
      return Promise.reject(
        new AcpClientError('disposed', this.disposedWith.message),
      );
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const key = String(id);

    return new Promise<unknown>((resolve, reject) => {
      const pendingRequest: PendingRequest = {
        method,
        timer:
          timeoutMs === null
            ? null
            : setTimeout(() => {
                this.pending.delete(key);
                this.destroy(
                  new AcpClientError(
                    'request-timeout',
                    `${method} did not respond within ${timeoutMs}ms`,
                  ),
                );
                reject(
                  new AcpClientError(
                    'request-timeout',
                    `${method} did not respond within ${timeoutMs}ms`,
                  ),
                );
              }, timeoutMs),
        settle: (outcome) => {
          if (outcome.ok) resolve(outcome.result);
          else reject(outcome.error);
        },
      };
      this.pending.set(key, pendingRequest);

      this.writeFrame(buildRequestFrame(id, method, params)).catch(
        (error: unknown) => {
          const stillPending = this.pending.get(key);
          if (stillPending !== undefined) {
            this.pending.delete(key);
            if (stillPending.timer !== null) clearTimeout(stillPending.timer);
          }
          reject(
            error instanceof AcpClientError
              ? error
              : new AcpClientError('protocol', String(error)),
          );
        },
      );
    });
  }

  /**
   * Serialize one NDJSON frame to the agent's stdin, bounded by the write
   * timeout: a peer that stopped reading stdin would otherwise block us
   * forever (buzz WRITE_TIMEOUT model).
   */
  private writeFrame(frame: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stdin = this.child.stdin;
      if (this.disposedWith !== null || stdin === null || stdin.destroyed) {
        reject(
          new AcpClientError(
            this.disposedWith !== null ? 'disposed' : 'peer-exited',
            'agent stdin is not writable',
          ),
        );
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new AcpClientError(
          'write-timeout',
          `agent stopped reading stdin (write blocked for ${this.writeTimeoutMs}ms)`,
        );
        this.destroy(error);
        reject(error);
      }, this.writeTimeoutMs);
      stdin.write(frame, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          // A broken stdin pipe means the peer is dead — tear down so
          // nothing else queues writes against a corpse.
          const writeError = new AcpClientError(
            'peer-exited',
            `stdin write failed: ${error.message}`,
          );
          this.destroy(writeError);
          reject(writeError);
        } else {
          resolve();
        }
      });
    });
  }

  // -- timers / teardown ----------------------------------------------------

  private resetIdleTimer(turn: ActiveTurn): void {
    if (turn.idleTimer !== null) clearTimeout(turn.idleTimer);
    turn.idleTimer = setTimeout(() => {
      this.destroy(
        new AcpClientError(
          'idle-timeout',
          `no agent activity for ${turn.idleTimeoutMs}ms`,
        ),
      );
    }, turn.idleTimeoutMs);
  }

  /** Clear turn timers and detach it from the client (normal completion). */
  private settleTurn(turn: ActiveTurn): void {
    if (turn.idleTimer !== null) clearTimeout(turn.idleTimer);
    if (turn.hardTimer !== null) clearTimeout(turn.hardTimer);
    if (turn.drainTimer !== null) clearTimeout(turn.drainTimer);
    turn.idleTimer = null;
    turn.hardTimer = null;
    turn.drainTimer = null;
    if (this.activeTurn === turn) this.activeTurn = null;
  }

  /**
   * Single teardown funnel — EVERY failure and exit path lands here.
   * Kills the process group, rejects all pending requests, fails the
   * active turn. Idempotent: the first error wins.
   */
  private destroy(
    error: AcpClientError,
    options: { silentTurn?: boolean } = {},
  ): void {
    if (this.disposedWith !== null) return;
    this.disposedWith = error;

    const turn = this.activeTurn;
    if (turn !== null) {
      this.settleTurn(turn);
      if (options.silentTurn === true) {
        turn.queue.fail(new AcpClientError('disposed', 'client shut down'));
      } else {
        turn.queue.fail(error);
      }
    }

    for (const [key, pendingRequest] of this.pending) {
      this.pending.delete(key);
      if (pendingRequest.timer !== null) clearTimeout(pendingRequest.timer);
      pendingRequest.settle({ ok: false, error });
    }

    this.killProcessGroup();
  }

  /** Kill the harness and every process it spawned (see the helper). */
  private killProcessGroup(): void {
    killHarnessProcessTree(this.child);
  }

  private recordDiagnostic(detail: string): void {
    this.diagnosticsBuffer.push({ at: Date.now(), detail });
    if (this.diagnosticsBuffer.length > 200) this.diagnosticsBuffer.shift();
  }
}
