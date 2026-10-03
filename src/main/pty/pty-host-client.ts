import { startPtyAnalysis, shutdownPtyAnalysis } from './pty-analysis-runtime';
import path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import {
  createPtyHostBridge,
  type HostControlMsg,
  type HostEventMsg,
  type PtyHost,
  type PtyHostBridge,
} from './pty-host-core';

/**
 * Supervisor for the PTY host utilityProcess (docs/ARCHITECTURE.md §B.2).
 * Isolated from the pure bridge in pty-host-core.ts so it is the ONLY PTY module
 * that imports electron at runtime — pty-manager stays electron-free and its
 * unit tests never fork a process.
 *
 * The child is forked lazily on the first spawn and re-forked after a crash: on
 * the child's `exit` we tell the bridge to finalize every orphaned session, then
 * the next spawn's `ensure()` starts a fresh host.
 */

let child: UtilityProcess | null = null;
let bridge: PtyHostBridge | null = null;

/** Built sibling of main.js — `.vite/build/pty-host-entry.js`, inside the asar
 * in a packaged app. The utilityProcess can load app code from the asar; only
 * the node-pty .node binding is unpacked. Its mutable Darwin spawn-helper is
 * forbidden, and the native binding starts Apple's /usr/bin/perl instead. */
function hostEntryPath(): string {
  return path.join(__dirname, 'pty-host-entry.js');
}

function forkChild(): void {
  const c = utilityProcess.fork(hostEntryPath(), [], {
    serviceName: 'nexus-pty-host',
  });
  child = c;
  c.on('message', (data: HostEventMsg) => bridge?.dispatchEvent(data));
  c.once('exit', () => {
    // Only react to the crash/exit of the CURRENT child (a stale handler from a
    // previously-replaced process must not wipe the live host's sessions).
    if (child !== c) return;
    child = null;
    bridge?.handleHostDown();
  });
}

const transport = {
  ensure(): void {
    if (!child) forkChild();
  },
  post(msg: HostControlMsg): void {
    child?.postMessage(msg);
  },
};

/** Create (once) and return the PTY host injected into pty-manager. */
export function createRealPtyHost(): PtyHost {
  startPtyAnalysis();
  if (!bridge) {
    // The transport wait is bounded on every platform (pty-host-core). Darwin's
    // signed responsibility supervisor still owns the exact descendant proof —
    // it just runs a bounded SIGTERM→SIGKILL escalation on the host side now, so
    // one stuck-but-alive child can no longer hang app quit (v0.25.0 blocker).
    bridge = createPtyHostBridge(transport);
  }
  return bridge.host;
}

/** Kill the host on app quit. Its death takes every child PTY with it. */
const hostStopFlights = new WeakMap<UtilityProcess, Promise<void>>();
export async function shutdownPtyHost(): Promise<void> {
  const analysisStopped = shutdownPtyAnalysis();
  const c = child;
  let hostStopped: Promise<void> = Promise.resolve();
  if (c) {
    const existing = hostStopFlights.get(c);
    if (existing) hostStopped = existing;
    else {
      let signalled = false;
      hostStopped = new Promise<void>((resolve, reject) => {
        const exited = () => { if (child === c) child = null; hostStopFlights.delete(c); resolve(); };
        c.once('exit', exited);
        signalled = c.kill();
        if (!signalled) { c.removeListener('exit', exited); reject(new Error('PTY host stop could not be signalled')); }
      });
      if (signalled) hostStopFlights.set(c, hostStopped);
    }
  }
  // A signalling failure retains the exact live handle for retry, and never
  // skips physical analysis settlement before reporting the failure.
  const settled = await Promise.allSettled([analysisStopped, hostStopped]);
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
}
