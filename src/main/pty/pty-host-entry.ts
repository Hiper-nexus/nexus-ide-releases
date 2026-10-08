import { watchDarwinHeavyCommand } from './darwin-heavy-command';
import { nestedHeavyJobBaseCommand } from './darwin-pty-supervisor';
import { OwnedCommandProcesses } from './owned-command-process';
import { PtyOutputCredits } from './pty-output-credits';
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
import { execFile } from 'node:child_process';
import {
  attributeSessionFootprints,
  parseRssProcessTable,
  type SessionFootprint,
} from './pane-footprint';
import {
  escalateDarwinSupervisorTermination,
  PhysicalExitReceipts,
  PreSpawnFailureTombstones,
  type HostControlMsg,
  type HostEventMsg,
} from './pty-host-core';
import {
  killPtyRoot,
  terminatePtyProcessTree,
  type PtyProcessTreeTerminationProof,
} from './pty-descendant-termination';
import {
  currentDarwinPtySupervisorRuntime,
  isProvenDarwinPtySupervisorExit,
  supervisedPtyCommand,
  supervisedJobCommand,
} from './darwin-pty-supervisor';
import { spawnFailureGuidance } from './spawn-failure-guidance';
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
  /** QLT-11: metade da identidade do root (PID + início) no footprint. */
  readonly spawnedAtMs: number;
  readonly outputCredits: PtyOutputCredits;
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
const commandProcesses = new OwnedCommandProcesses((sessionId) => { const entry = procs.get(sessionId); return entry ? { pid: entry.proc.pid, identity: entry } : null; }, undefined, process.platform === 'darwin' ? (pid) => watchDarwinHeavyCommand(currentDarwinPtySupervisorRuntime(__dirname), pid) : undefined);

/** F-572: uma leitura de `ps`, atribuída por root de sessão (PID + início). */
function captureFootprints(): Promise<SessionFootprint[]> {
  const roots = [...procs.entries()].map(([sessionId, entry]) => ({
    sessionId,
    rootPid: entry.proc.pid,
    spawnedAtMs: entry.spawnedAtMs,
  }));
  if (roots.length === 0 || process.platform === 'win32') {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,rss=,lstart='],
      {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 3_000,
        killSignal: 'SIGKILL',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(attributeSessionFootprints(parseRssProcessTable(stdout), roots));
      },
    );
  });
}
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
  // Known supervisor preflight classes get one actionable sentence on top;
  // the raw text always stays as evidence.
  const guidance = spawnFailureGuidance(text);
  const lines = [`\r\n[nexus] falha ao iniciar o processo: ${text}\r\n`];
  if (guidance) {
    lines.push(`[nexus] ${guidance}\r\n`);
  }
  post({ type: 'data', sessionId, data: lines.join('') });
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
    // Logo após o fork (nodePty.spawn já retornou): o `lstart` do root cai aqui.
    spawnedAtMs: Date.now(),
    outputCredits: new PtyOutputCredits({
      send: (data) => post({ type: 'data', sessionId: spec.sessionId, data }),
      pause: () => { try { proc.pause(); } catch {} },
      resume: () => { try { proc.resume(); } catch {} },
    }),
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
  proc.onData((data) => entry.outputCredits.push(data));
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
    entry.outputCredits.seal(() => post({ type: 'exit', sessionId: spec.sessionId, exitCode, signal }));
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
 * audit-token-fenced SIGKILL, and passed two empty scans; its clean exit
 * callback is the native proof receipt. Historically main waited on that exit
 * UNBOUNDED — one stuck-but-alive child that never posted its exit pinned app
 * quit forever (v0.25.0 release blocker). The escalation state machine now
 * bounds the wait: the exact receipt still wins whenever it arrives inside the
 * grace windows, but an unresponsive root is force-killed and settled
 * fail-closed past the final grace so quit proceeds instead of hanging. The
 * grace windows come from Main's terminate request (termTimeoutMs/killTimeoutMs)
 * so the transport deadline in pty-host-core stays strictly larger.
 */
function terminateDarwinResponsibilitySupervisor(
  entry: HostPtyEntry,
  termTimeoutMs: number,
  killTimeoutMs: number,
): Promise<PtyProcessTreeTerminationProof> {
  return escalateDarwinSupervisorTermination({
    termGraceMs: termTimeoutMs,
    killGraceMs: killTimeoutMs,
    sendSignal: (signal) => entry.proc.kill(signal),
    exitObservation: entry.exitObservation,
    isProvenExit: isProvenDarwinPtySupervisorExit,
    delay: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
  });
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
      ? terminateDarwinResponsibilitySupervisor(
          entry,
          msg.termTimeoutMs,
          msg.killTimeoutMs,
        )
      : terminatePtyProcessTree(
          {
            rootPid: entry.proc.pid,
            ownsRoot: () => procs.get(msg.sessionId) === entry,
            killRoot: (signal) => killPtyRoot(entry.proc, signal),
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
    case 'prepare-command':
      try {
        const command = supervisedJobCommand(currentDarwinPtySupervisorRuntime(__dirname), msg.file, msg.args);
        post({ type: 'prepared-command', requestId: msg.requestId, command });
      } catch { post({ type: 'prepared-command', requestId: msg.requestId, command: null }); }
      return;
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
    case 'prepare-native-heavy-job-base':
      try { post({ type: 'native-heavy-job-base', requestId: msg.requestId, command: nestedHeavyJobBaseCommand(currentDarwinPtySupervisorRuntime(__dirname)) }); }
      catch { post({ type: 'native-heavy-job-base', requestId: msg.requestId, command: null }); } return;
    case 'command-process-confirm':
      commandProcesses.confirmRequest(msg.sessionId, msg.requestId, msg.claimId); return;
    case 'command-process-cancel':
      commandProcesses.cancelRequest(msg.sessionId, msg.requestId); return;
    case 'command-process':
      void (async () => {
        const claimId = msg.op === 'claim' ? await commandProcesses.claimForRequest(msg.sessionId, msg.requestId, msg.pid, msg.proof) : msg.claimId;
        let stopped: boolean | undefined;
        if (msg.op === 'stop') { try { await commandProcesses.stop(msg.sessionId, msg.claimId); stopped = true; } catch { stopped = false; } }
        const state = msg.op === 'probe' ? await commandProcesses.probe(msg.sessionId, msg.claimId) : null;
        const borrowed = msg.op === 'borrow' ? await commandProcesses.borrow(msg.sessionId, msg.claimId, msg.pid) : undefined;
        post({ type: 'command-process-result', requestId: msg.requestId, sessionId: msg.sessionId, claimId, state, borrowed, ...(stopped === undefined ? {} : { stopped }) });
      })().catch(() => post({ type: 'command-process-result', requestId: msg.requestId, sessionId: msg.sessionId, claimId: null, state: 'unknown' }));
      return;
    case 'analysis-credit':
      procs.get(msg.sessionId)?.outputCredits.grant(msg.bytes);
      return;
    case 'output-flow':
      try { const proc = procs.get(msg.sessionId)?.proc; if (msg.paused) proc?.pause(); else proc?.resume(); } catch {}
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
        const target = procs.get(msg.sessionId)?.proc;
        // F-659: no Windows o node-pty recusa qualquer sinal (o erro era
        // engolido aqui como "já morto" e o processo seguia vivo).
        if (target) {
          if (msg.signal) killPtyRoot(target, msg.signal);
          else target.kill();
        }
      } catch {
        // Already dead.
      }
      return;
    case 'terminate':
      handleTerminate(msg);
      return;
    case 'footprint-probe':
      // F-572: RSS da árvore de cada sessão (root = node-pty pid). Uma única
      // leitura de `ps` para todas; win32 não tem `ps` → lista vazia (o main
      // trata ausência como telemetria ausente, nunca como pressão).
      void captureFootprints().then((footprints) => {
        post({ type: 'footprint-report', requestId: msg.requestId, footprints });
      });
      return;
    case 'liveness-probe':
      // Verdade física do host: handle presente no mapa = sessão viva aqui.
      // Ausente = nenhum processo atende a sessão neste host (morto ou nunca
      // nascido) — o main decide com strikes + graça, nunca num probe só.
      post({
        type: 'liveness-report',
        requestId: msg.requestId,
        live: msg.sessionIds.filter((sessionId) => procs.has(sessionId)),
      });
      return;
  }
});
