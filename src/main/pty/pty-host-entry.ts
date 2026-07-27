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
import {
  PhysicalExitReceipts,
  PreSpawnFailureTombstones,
  type HostControlMsg,
  type HostEventMsg,
} from './pty-host-core';
import {
  terminatePtyProcessTree,
  type PtyProcessTreeTerminationProof,
} from './pty-descendant-termination';
import {
  currentDarwinPtySupervisorRuntime,
  isProvenDarwinPtySupervisorExit,
  supervisedPtyCommand,
} from './darwin-pty-supervisor';
import { darwinNodePtyBootstrapLaunch } from './darwin-node-pty-bootstrap';

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
  readonly exitObservation: Promise<{
    readonly exitCode: number;
    readonly signal?: number;
  }>;
  readonly resolveExitObservation: (
    observation: { readonly exitCode: number; readonly signal?: number },
  ) => void;
  readonly darwinResponsibilitySupervisor: boolean;
  termination: Promise<PtyProcessTreeTerminationProof> | null;
}

const procs = new Map<string, HostPtyEntry>();
const preSpawnFailures = new PreSpawnFailureTombstones();
const physicalExitReceipts = new PhysicalExitReceipts();
const completePhysicalExitProof: PtyProcessTreeTerminationProof =
  Object.freeze({
    ok: true,
    rootExited: true,
    descendantsExited: true,
  });

function post(msg: HostEventMsg): void {
  parentPort.postMessage(msg);
}

function postSpawnFailure(sessionId: string, error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  post({
    type: 'data',
    sessionId,
    data: `\r\n[nexus] falha ao iniciar o processo: ${text}\r\n`,
  });
  post({ type: 'exit', sessionId, exitCode: -1 });
}

function handleSpawn(spec: Extract<HostControlMsg, { type: 'spawn' }>): void {
  // A reused id must never inherit proof from an older failed attempt.
  preSpawnFailures.forget(spec.sessionId);
  physicalExitReceipts.forget(spec.sessionId);

  let command: ReturnType<typeof supervisedPtyCommand>;
  try {
    command = supervisedPtyCommand(
      currentDarwinPtySupervisorRuntime(
        __dirname,
        spec.darwinTrustProfile,
      ),
      spec.file,
      spec.args,
      spec.darwinExecutableSeal,
    );
  } catch (error) {
    // The supervisor preflight failed before nodePty.spawn was called. Record
    // this exact negative-spawn fact before publishing exit so a concurrent
    // app-shutdown termination can prove that no process tree ever existed.
    preSpawnFailures.record(spec.sessionId);
    postSpawnFailure(spec.sessionId, error);
    return;
  }

  let proc: nodePty.IPty;
  try {
    const launch =
      process.platform === 'darwin'
        ? darwinNodePtyBootstrapLaunch(
            spec.cwd,
            command.file,
            command.args,
            spec.env,
          )
        : {
            file: command.file,
            args: command.args,
            cwd: spec.cwd,
            env: spec.env,
          };
    proc = nodePty.spawn(launch.file, [...launch.args], {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: launch.cwd,
      env: launch.env,
    });
  } catch (error) {
    // nodePty.spawn may throw after native work has begun. Without a host entry
    // and a physical inventory, that ambiguity must remain fail-closed.
    postSpawnFailure(spec.sessionId, error);
    return;
  }
  let resolveExited!: () => void;
  let resolveExitObservation!: (
    observation: { readonly exitCode: number; readonly signal?: number },
  ) => void;
  const entry: HostPtyEntry = {
    proc,
    exited: new Promise<void>((resolve) => {
      resolveExited = resolve;
    }),
    resolveExited: () => resolveExited(),
    exitObservation: new Promise((resolve) => {
      resolveExitObservation = resolve;
    }),
    resolveExitObservation: (observation) =>
      resolveExitObservation(observation),
    darwinResponsibilitySupervisor: process.platform === 'darwin',
    termination: null,
  };
  procs.set(spec.sessionId, entry);
  proc.onData((data) => post({ type: 'data', sessionId: spec.sessionId, data }));
  proc.onExit(({ exitCode, signal }) => {
    const observation = {
      exitCode,
      ...(signal === undefined ? {} : { signal }),
    };
    // The signed Darwin supervisor cannot return normally until it has killed
    // and twice proven absence of its entire responsibility cohort. Preserve
    // that receipt before removing the live handle: Main's terminate request
    // may be queued immediately behind this exit event.
    if (
      entry.darwinResponsibilitySupervisor &&
      isProvenDarwinPtySupervisorExit(observation)
    ) {
      physicalExitReceipts.record(
        spec.sessionId,
        completePhysicalExitProof,
      );
    }
    if (procs.get(spec.sessionId) === entry) {
      procs.delete(spec.sessionId);
    }
    entry.resolveExited();
    entry.resolveExitObservation(observation);
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

/**
 * The signed Darwin helper keeps the node-pty root PID alive until its
 * responsibility cohort has reached a SIGSTOP fixed point, received
 * audit-token-fenced SIGKILL, and passed two empty scans.  Killing that root
 * from the generic PPID scanner would destroy the proof authority itself.
 * Therefore its clean exit callback is the native proof receipt.
 */
async function terminateDarwinResponsibilitySupervisor(
  entry: HostPtyEntry,
): Promise<PtyProcessTreeTerminationProof> {
  try {
    entry.proc.kill('SIGTERM');
  } catch (error) {
    return failedTerminationProof(error);
  }
  const observation = await entry.exitObservation;
  if (!isProvenDarwinPtySupervisorExit(observation)) {
    return {
      ok: false,
      rootExited: true,
      descendantsExited: false,
      error:
        `O supervisor Darwin saiu por sinal ${observation.signal}; ` +
        'a prova de responsabilidade não foi emitida.',
    };
  }
  return {
    ok: true,
    rootExited: true,
    descendantsExited: true,
  };
}

function handleTerminate(
  msg: Extract<HostControlMsg, { type: 'terminate' }>,
): void {
  const entry = procs.get(msg.sessionId);
  if (!entry) {
    const receipt = physicalExitReceipts.read(msg.sessionId);
    if (receipt) {
      post({
        type: 'termination-result',
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        proof: receipt,
      });
      return;
    }
    if (preSpawnFailures.consume(msg.sessionId)) {
      post({
        type: 'termination-result',
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        proof: {
          ok: true,
          rootExited: true,
          descendantsExited: true,
        },
      });
      return;
    }
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
  const operation =
    entry.termination ??
    (entry.darwinResponsibilitySupervisor
      ? terminateDarwinResponsibilitySupervisor(entry)
      : terminatePtyProcessTree(
          {
            rootPid: entry.proc.pid,
            ownsRoot: () => procs.get(msg.sessionId) === entry,
            killRoot: (signal) => entry.proc.kill(signal),
            rootExited: entry.exited,
          },
          {
            termTimeoutMs: msg.termTimeoutMs,
            killTimeoutMs: msg.killTimeoutMs,
          },
        ));
  entry.termination = operation;
  void operation.then(
    (proof) => {
      physicalExitReceipts.record(msg.sessionId, proof);
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
