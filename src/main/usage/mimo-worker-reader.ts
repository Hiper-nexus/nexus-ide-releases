import path from 'node:path';
import type { EventEmitter } from 'node:events';
import { parseMimoWorkerReply, type MimoWorkerReply, type MimoWorkerRequest } from './mimo-worker-protocol';

export interface MimoReaderProcess {
  postMessage(message: MimoWorkerRequest): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error' | 'exit' | 'spawn', listener: () => void): unknown;
  /** Signal the exact owned process; false retains the handle/proof for retry. */
  terminate(): boolean;
}
export type MimoProcessFactory = (entryPath: string) => MimoReaderProcess;
export interface MimoReaderOptions {
  readonly workerPath?: string; readonly timeoutMs?: number; readonly processFactory?: MimoProcessFactory;
}
const DEFAULT_WORKER_PATH = path.join(__dirname, 'mimo-usage-worker-entry.js');
let workerPath = DEFAULT_WORKER_PATH;
function forkUtility(entryPath: string): MimoReaderProcess {
  // Lazy import keeps this module testable; production never forks Electron as Node
  // (RunAsNode is fused off) and never opts into unsigned native libraries.
  const { utilityProcess } = require('electron') as typeof import('electron');
  const child = utilityProcess.fork(entryPath, [], { serviceName: 'nexus-mimo-usage', stdio: 'ignore',
    execArgv: ['--max-old-space-size=64'] });
  return {
    postMessage: message => child.postMessage(message),
    on: (event: string, listener: (...args: any[]) => void) => (child as EventEmitter).on(event, listener),
    terminate: () => {
      const pid = child.pid;
      if (!pid || pid === process.pid) return false;
      // utilityProcess.kill() uses SIGTERM on POSIX. SIGKILL interrupts even an
      // active sqlite3_step; the owned child is not reaped until its exit event.
      try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
    },
  };
}
let processFactory: MimoProcessFactory = forkUtility;
/** Main-owned configuration; no hook/renderer argument selects executable code. */
export function configureMimoUsageWorkerPath(value: string): void { workerPath = path.resolve(value); }
export function configureMimoUsageProcessFactory(value: MimoProcessFactory): void { processFactory = value; }
let validator: MimoWorkerReader | null = null;
export function mimoValidationReader(): MimoWorkerReader { return validator ??= new MimoWorkerReader(); }
export async function stopMimoValidationReader(): Promise<void> {
  const old = validator; await old?.stop(); if (validator === old) validator = null;
}
interface OwnedProcess {
  readonly child: MimoReaderProcess; readonly exited: Promise<void>; readonly resolveExit: () => void;
  terminating: boolean; retry: ReturnType<typeof setTimeout> | null;
}

/** One physically killable utility process and bounded FIFO; no Main SQLite fallback. */
export class MimoWorkerReader {
  readonly #path: string;
  readonly #timeoutMs: number;
  readonly #factory: MimoProcessFactory;
  #worker: OwnedProcess | null = null;
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;
  #job = 0;
  #stopped = false;
  #stopFlight: Promise<void> | null = null;
  #pending: { job: number; resolve: (value: MimoWorkerReply | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(options: MimoReaderOptions = {}) {
    this.#path = options.workerPath ?? workerPath;
    this.#timeoutMs = options.timeoutMs ?? 4_000;
    this.#factory = options.processFactory ?? processFactory;
  }
  read(input: Omit<MimoWorkerRequest, 'job'>): Promise<MimoWorkerReply | null> {
    if (this.#stopped || this.#queued >= 32) return Promise.resolve(null);
    this.#queued++;
    const run = this.#tail.then(() => this.#run(input));
    this.#tail = run.then(() => undefined, () => undefined);
    return run.finally(() => this.#queued--);
  }
  #ensureWorker(): OwnedProcess {
    if (this.#worker) return this.#worker;
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const worker: OwnedProcess = { child: this.#factory(this.#path), exited, resolveExit, terminating: false, retry: null };
    this.#worker = worker;
    worker.child.on('message', raw => {
      if (this.#worker !== worker || this.#stopped || worker.terminating) return;
      const reply = parseMimoWorkerReply(raw);
      if (!reply || reply.job !== this.#pending?.job) { this.#terminate(worker); return; }
      this.#settle(reply);
    });
    worker.child.on('error', () => this.#terminate(worker));
    worker.child.on('spawn', () => { if (worker.terminating) this.#terminate(worker); });
    worker.child.on('exit', () => {
      if (worker.retry) clearTimeout(worker.retry);
      worker.retry = null;
      if (this.#worker === worker) { this.#worker = null; this.#settle(null); }
      worker.resolveExit();
    });
    return worker;
  }
  #terminate(worker: OwnedProcess): void {
    if (this.#worker !== worker) return;
    worker.terminating = true;
    try { worker.child.terminate(); } catch { /* Retain physical ownership until exit. */ }
    if (!worker.retry) {
      worker.retry = setTimeout(() => { worker.retry = null; this.#terminate(worker); }, 100);
      worker.retry.unref();
    }
  }
  #settle(value: MimoWorkerReply | null): void {
    const pending = this.#pending; this.#pending = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(value); }
  }
  async #run(input: Omit<MimoWorkerRequest, 'job'>): Promise<MimoWorkerReply | null> {
    if (this.#stopped) return null;
    let worker: OwnedProcess | undefined;
    try {
      worker = this.#ensureWorker(); const job = ++this.#job;
      return await new Promise<MimoWorkerReply | null>(resolve => {
        const timer = setTimeout(() => this.#terminate(worker!), this.#timeoutMs);
        timer.unref(); this.#pending = { job, resolve, timer };
        worker!.child.postMessage({ ...input, job });
      });
    } catch {
      if (worker) { this.#terminate(worker); await worker.exited; }
      else this.#settle(null);
      return null;
    }
  }
  stop(): Promise<void> {
    this.#stopped = true;
    if (this.#worker) this.#terminate(this.#worker);
    if (this.#stopFlight) return this.#stopFlight;
    this.#stopFlight = Promise.all([this.#worker?.exited, this.#tail]).then(() => undefined);
    return this.#stopFlight;
  }
}
