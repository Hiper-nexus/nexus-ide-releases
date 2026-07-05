/**
 * PTY host protocol + main-side dispatcher — pure logic, no electron / node-pty
 * imports so it unit-tests directly under vitest (same convention as
 * pane-pipe-core.ts). The native @lydell/node-pty addon runs in an isolated
 * utilityProcess (docs/ARCHITECTURE.md §B.2); this module owns the message
 * contract and the bookkeeping that turns host events back into per-session
 * callbacks. pty-host-client.ts wires it to the real utilityProcess.
 */

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

/** main → host (control). */
export type HostControlMsg =
  | ({ type: 'spawn' } & PtySpawnSpec)
  | { type: 'write'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string };

/** host → main (events). */
export type HostEventMsg =
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; exitCode: number; signal?: number };

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
  kill(): void;
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
  /** The child died: finalize every live session exactly once. */
  handleHostDown(): void;
  /** Live session count (tests / diagnostics). */
  sessionCount(): number;
}

/**
 * Build the main-side bridge. `dispatchEvent`/`handleHostDown` are driven by the
 * client from the utilityProcess's message/exit events; `host.spawn` is called
 * by pty-manager. A session's handlers are dropped on its first `exit` so a
 * later duplicate (e.g. our own kill echoing back) is a no-op — the idempotency
 * the exit path depends on.
 */
export function createPtyHostBridge(transport: HostTransport): PtyHostBridge {
  const handlers = new Map<string, PtySessionHandlers>();

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
        kill: () => transport.post({ type: 'kill', sessionId: spec.sessionId }),
      };
    },
  };

  function dispatchEvent(msg: HostEventMsg): void {
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
    const orphans = [...handlers.values()];
    handlers.clear();
    for (const h of orphans) h.onExit(-1, undefined);
  }

  return { host, dispatchEvent, handleHostDown, sessionCount: () => handlers.size };
}
