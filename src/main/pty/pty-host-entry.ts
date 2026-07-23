/**
 * PTY host — the isolated utilityProcess that owns every live @lydell/node-pty
 * handle (docs/ARCHITECTURE.md §B.2). A native segfault or FD leak in the addon
 * crashes THIS process, not main/UI; the supervisor (pty-host-client.ts) then
 * publishes host loss and re-forks on the next spawn. An authority-critical
 * termination remains fail-closed because host loss is not descendant proof.
 *
 * This file runs in a utilityProcess, NOT the main process. It talks to main
 * exclusively over `process.parentPort` and does no policy of its own: file,
 * args, cwd and env are all resolved by the (trusted) main process and arrive
 * fully-formed. The host is a dumb executor.
 */
import * as nodePty from '@lydell/node-pty';
import type { HostControlMsg, HostEventMsg } from './pty-host-core';
import {
  terminatePtyProcessTree,
  type PtyProcessTreeTerminationProof,
} from './pty-descendant-termination';

// Electron injects `parentPort` onto the utilityProcess's `process`. @types/node
// doesn't know about it, so type only what we use rather than pulling in the
// electron global namespace (tsconfig `types` is node-only).
interface ParentPortLike {
  on(event: 'message', listener: (e: { data: HostControlMsg }) => void): void;
  postMessage(message: HostEventMsg): void;
}
const parentPort = (process as unknown as { parentPort: ParentPortLike })
  .parentPort;

interface HostPtyEntry {
  readonly proc: nodePty.IPty;
  readonly exited: Promise<void>;
  readonly resolveExited: () => void;
  termination: Promise<PtyProcessTreeTerminationProof> | null;
}

const procs = new Map<string, HostPtyEntry>();

function post(msg: HostEventMsg): void {
  parentPort.postMessage(msg);
}

function handleSpawn(spec: Extract<HostControlMsg, { type: 'spawn' }>): void {
  let proc: nodePty.IPty;
  try {
    proc = nodePty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
    });
  } catch (err) {
    // node-pty usually reports a bad binary as an exit(1), but a bad cwd or an
    // OS-level failure throws synchronously. Surface it in the pane, then close
    // the session so main's exit path frees tokens/artifacts.
    const text = err instanceof Error ? err.message : String(err);
    post({
      type: 'data',
      sessionId: spec.sessionId,
      data: `\r\n[nexus] falha ao iniciar o processo: ${text}\r\n`,
    });
    post({ type: 'exit', sessionId: spec.sessionId, exitCode: -1 });
    return;
  }
  let resolveExited!: () => void;
  const entry: HostPtyEntry = {
    proc,
    exited: new Promise<void>((resolve) => {
      resolveExited = resolve;
    }),
    resolveExited: () => resolveExited(),
    termination: null,
  };
  procs.set(spec.sessionId, entry);
  proc.onData((data) => post({ type: 'data', sessionId: spec.sessionId, data }));
  proc.onExit(({ exitCode, signal }) => {
    if (procs.get(spec.sessionId) === entry) {
      procs.delete(spec.sessionId);
    }
    entry.resolveExited();
    post({ type: 'exit', sessionId: spec.sessionId, exitCode, signal });
  });
}

function failedTerminationProof(error: unknown): PtyProcessTreeTerminationProof {
  return {
    ok: false,
    rootExited: false,
    descendantsExited: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function handleTerminate(
  msg: Extract<HostControlMsg, { type: 'terminate' }>,
): void {
  const entry = procs.get(msg.sessionId);
  if (!entry) {
    post({
      type: 'termination-result',
      sessionId: msg.sessionId,
      requestId: msg.requestId,
      proof: {
        ok: false,
        rootExited: false,
        descendantsExited: false,
        error: 'A sessão PTY não existe no host atual.',
      },
    });
    return;
  }
  const operation = entry.termination ?? terminatePtyProcessTree({
    rootPid: entry.proc.pid,
    ownsRoot: () => procs.get(msg.sessionId) === entry,
    killRoot: (signal) => entry.proc.kill(signal),
    rootExited: entry.exited,
  }, {
    termTimeoutMs: msg.termTimeoutMs,
    killTimeoutMs: msg.killTimeoutMs,
  });
  entry.termination = operation;
  void operation.then(
    (proof) => {
      post({
        type: 'termination-result',
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        proof,
      });
    },
    (error) => {
      post({
        type: 'termination-result',
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        proof: failedTerminationProof(error),
      });
    },
  ).finally(() => {
    if (entry.termination === operation) entry.termination = null;
  });
}

parentPort.on('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'spawn':
      handleSpawn(msg);
      return;
    case 'write':
      try {
        procs.get(msg.sessionId)?.proc.write(msg.data);
      } catch {
        // PTY died between the ownership check in main and this write.
      }
      return;
    case 'resize':
      try {
        procs.get(msg.sessionId)?.proc.resize(msg.cols, msg.rows);
      } catch {
        // A resize racing process exit can throw; safe to ignore.
      }
      return;
    case 'kill':
      try {
        procs.get(msg.sessionId)?.proc.kill(msg.signal);
      } catch {
        // Already dead.
      }
      return;
    case 'terminate':
      handleTerminate(msg);
      return;
  }
});
