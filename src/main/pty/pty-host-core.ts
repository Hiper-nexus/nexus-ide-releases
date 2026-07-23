/**
 * PTY host protocol + main-side dispatcher — pure logic, no electron / node-pty
 * imports so it unit-tests directly under vitest (same convention as
 * pane-pipe-core.ts). The native @lydell/node-pty addon runs in an isolated
 * utilityProcess (docs/ARCHITECTURE.md §B.2); this module owns the message
 * contract and the bookkeeping that turns host events back into per-session
 * callbacks. pty-host-client.ts wires it to the real utilityProcess.
 */
import type { PtyProcessTreeTerminationProof } from './pty-descendant-termination';

/** Fully-resolved spawn request. The main process builds file/args/env (the
 * security-relevant work); the host only executes it. */
export interface PtySpawnSpec {
  sessionId: string;
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type PtyKillSignal = 'SIGTERM' | 'SIGKILL';

/** main → host (control). */
export type HostControlMsg =
  | ({ type: 'spawn' } & PtySpawnSpec)
  | { type: 'write'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string; signal?: PtyKillSignal }
  | {
      type: 'terminate';
      sessionId: string;
      requestId: string;
      termTimeoutMs: number;
      killTimeoutMs: number;
    };

/** host → main (events). */
export type HostEventMsg =
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; exitCode: number; signal?: number }
  | {
      type: 'termination-result';
      sessionId: string;
      requestId: string;
      proof: PtyProcessTreeTerminationProof;
    };

export interface PtySessionHandlers {
  onData: (data: string) => void;
  onExit: (exitCode: number, signal?: number) => void;
}

/**
 * Per-session proxy handed back to pty-manager in place of a raw node-pty
 * `IPty`. Every method just posts a control message to the host — the renderer
 * and orchestration layer never hold a real terminal handle.
 */
export interface PtyProcHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: PtyKillSignal): void;
  terminate(options: {
    readonly termTimeoutMs: number;
    readonly killTimeoutMs: number;
  }): Promise<PtyProcessTreeTerminationProof>;
}

export interface PtyHost {
  spawn(spec: PtySpawnSpec, handlers: PtySessionHandlers): PtyProcHandle;
}

/** Transport over the utilityProcess. `ensure()` lazily (re)forks the child. */
export interface HostTransport {
  ensure(): void;
  post(msg: HostControlMsg): void;
}

export interface PtyHostBridge {
  host: PtyHost;
  /** Feed one host→main event to the owning session's callbacks. */
  dispatchEvent(msg: HostEventMsg): void;
  /**
   * The child died: publish root loss exactly once. Authority-critical callers
   * still fail closed until a separate descendant proof succeeds.
   */
  handleHostDown(): void;
  /** Live session count (tests / diagnostics). */
  sessionCount(): number;
}

const TERMINATION_PROCESS_SCAN_BUDGET_MS = 4_000;
const TERMINATION_TRANSPORT_MARGIN_MS = 500;

/**
 * Build the main-side bridge. `dispatchEvent`/`handleHostDown` are driven by the
 * client from the utilityProcess's message/exit events; `host.spawn` is called
 * by pty-manager. A session's handlers are dropped on its first `exit` so a
 * later duplicate (e.g. our own kill echoing back) is a no-op — the idempotency
 * the exit path depends on.
 */
export function createPtyHostBridge(transport: HostTransport): PtyHostBridge {
  const handlers = new Map<string, PtySessionHandlers>();
  const pendingTerminations = new Map<
    string,
    {
      readonly sessionId: string;
      readonly resolve: (proof: PtyProcessTreeTerminationProof) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  let terminationCounter = 0;

  const host: PtyHost = {
    spawn(spec, h) {
      handlers.set(spec.sessionId, h);
      transport.ensure();
      transport.post({ type: 'spawn', ...spec });
      return {
        write: (data) =>
          transport.post({ type: 'write', sessionId: spec.sessionId, data }),
        resize: (cols, rows) =>
          transport.post({ type: 'resize', sessionId: spec.sessionId, cols, rows }),
        kill: (signal) =>
          transport.post({
            type: 'kill',
            sessionId: spec.sessionId,
            ...(signal ? { signal } : {}),
          }),
        terminate: ({ termTimeoutMs, killTimeoutMs }) => {
          const requestId =
            `pty-termination-${Date.now().toString(36)}-${++terminationCounter}`;
          return new Promise<PtyProcessTreeTerminationProof>((resolve) => {
            const deadlineMs =
              termTimeoutMs +
              killTimeoutMs +
              TERMINATION_PROCESS_SCAN_BUDGET_MS +
              TERMINATION_TRANSPORT_MARGIN_MS;
            const timer = setTimeout(() => {
              const pending = pendingTerminations.get(requestId);
              if (!pending || pending.sessionId !== spec.sessionId) return;
              pendingTerminations.delete(requestId);
              resolve({
                ok: false,
                rootExited: false,
                descendantsExited: false,
                error:
                  'O PTY host não respondeu dentro da janela física de término.',
              });
            }, deadlineMs);
            timer.unref?.();
            pendingTerminations.set(requestId, {
              sessionId: spec.sessionId,
              resolve,
              timer,
            });
            try {
              transport.post({
                type: 'terminate',
                sessionId: spec.sessionId,
                requestId,
                termTimeoutMs,
                killTimeoutMs,
              });
            } catch (error) {
              const pending = pendingTerminations.get(requestId);
              if (pending) clearTimeout(pending.timer);
              pendingTerminations.delete(requestId);
              resolve({
                ok: false,
                rootExited: false,
                descendantsExited: false,
                error:
                  error instanceof Error
                    ? error.message
                    : 'PTY host termination request failed',
              });
            }
          });
        },
      };
    },
  };

  function dispatchEvent(msg: HostEventMsg): void {
    if (msg.type === 'termination-result') {
      const pending = pendingTerminations.get(msg.requestId);
      if (!pending || pending.sessionId !== msg.sessionId) return;
      clearTimeout(pending.timer);
      pendingTerminations.delete(msg.requestId);
      pending.resolve(msg.proof);
      return;
    }
    const h = handlers.get(msg.sessionId);
    if (!h) return;
    if (msg.type === 'data') {
      h.onData(msg.data);
      return;
    }
    handlers.delete(msg.sessionId);
    h.onExit(msg.exitCode, msg.signal);
  }

  function handleHostDown(): void {
    const pending = [...pendingTerminations.values()];
    pendingTerminations.clear();
    for (const operation of pending) {
      clearTimeout(operation.timer);
      operation.resolve({
        ok: false,
        rootExited: false,
        descendantsExited: false,
        error:
          'O PTY host encerrou antes da prova física dos descendentes.',
      });
    }
    const orphans = [...handlers.values()];
    handlers.clear();
    for (const h of orphans) h.onExit(-1, undefined);
  }

  return { host, dispatchEvent, handleHostDown, sessionCount: () => handlers.size };
}
