/**
 * PTY host — the isolated utilityProcess that owns every live @lydell/node-pty
 * handle (docs/ARCHITECTURE.md §B.2). A native segfault or FD leak in the addon
 * crashes THIS process, not main/UI; the supervisor (pty-host-client.ts) then
 * finalizes the orphaned sessions and re-forks on the next spawn.
 *
 * This file runs in a utilityProcess, NOT the main process. It talks to main
 * exclusively over `process.parentPort` and does no policy of its own: file,
 * args, cwd and env are all resolved by the (trusted) main process and arrive
 * fully-formed. The host is a dumb executor.
 */
import * as nodePty from '@lydell/node-pty';
import type { HostControlMsg, HostEventMsg } from './pty-host-core';

// Electron injects `parentPort` onto the utilityProcess's `process`. @types/node
// doesn't know about it, so type only what we use rather than pulling in the
// electron global namespace (tsconfig `types` is node-only).
interface ParentPortLike {
  on(event: 'message', listener: (e: { data: HostControlMsg }) => void): void;
  postMessage(message: HostEventMsg): void;
}
const parentPort = (process as unknown as { parentPort: ParentPortLike })
  .parentPort;

const procs = new Map<string, nodePty.IPty>();

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
  procs.set(spec.sessionId, proc);
  proc.onData((data) => post({ type: 'data', sessionId: spec.sessionId, data }));
  proc.onExit(({ exitCode, signal }) => {
    procs.delete(spec.sessionId);
    post({ type: 'exit', sessionId: spec.sessionId, exitCode, signal });
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
        procs.get(msg.sessionId)?.write(msg.data);
      } catch {
        // PTY died between the ownership check in main and this write.
      }
      return;
    case 'resize':
      try {
        procs.get(msg.sessionId)?.resize(msg.cols, msg.rows);
      } catch {
        // A resize racing process exit can throw; safe to ignore.
      }
      return;
    case 'kill':
      try {
        procs.get(msg.sessionId)?.kill();
      } catch {
        // Already dead.
      }
      return;
  }
});
