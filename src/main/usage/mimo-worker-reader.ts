import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { parseMimoWorkerReply, type MimoWorkerReply, type MimoWorkerRequest } from './mimo-worker-protocol';

export interface MimoReaderOptions { readonly workerPath?: string; readonly timeoutMs?: number }
const DEFAULT_WORKER_PATH = path.join(__dirname, 'mimo-usage-worker-entry.js');
let workerPath = DEFAULT_WORKER_PATH;
/** Main-owned runtime configuration; no hook/renderer argument selects executable code. */
export function configureMimoUsageWorkerPath(value: string): void { workerPath = path.resolve(value); }
let validator: MimoWorkerReader | null = null;
export function mimoValidationReader(): MimoWorkerReader { return validator ??= new MimoWorkerReader(); }
export async function stopMimoValidationReader(): Promise<void> {
  const old = validator; await old?.stop(); if (validator === old) validator = null;
}

/** One physical worker and bounded FIFO, never a synchronous Main fallback. */
export class MimoWorkerReader {
  readonly #path: string;
  readonly #timeoutMs: number;
  #worker: Worker | null = null;
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;
  #job = 0;
  #stopped = false;
  #stopFlight: Promise<void> | null = null;
  #pending: { job: number; resolve: (value: MimoWorkerReply | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(options: MimoReaderOptions = {}) {
    this.#path = options.workerPath ?? workerPath;
    this.#timeoutMs = options.timeoutMs ?? 4_000;
  }
  read(input: Omit<MimoWorkerRequest, 'job'>): Promise<MimoWorkerReply | null> {
    if (this.#stopped || this.#queued >= 32) return Promise.resolve(null);
    this.#queued++;
    const run = this.#tail.then(() => this.#run(input));
    this.#tail = run.then(() => undefined, () => undefined);
    return run.finally(() => this.#queued--);
  }
  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(this.#path, { resourceLimits: { maxOldGenerationSizeMb: 64 } });
    this.#worker = worker;
    worker.on('message', raw => {
      if (this.#worker !== worker || this.#stopped) return;
      const reply = parseMimoWorkerReply(raw);
      if (!reply || reply.job !== this.#pending?.job) { void worker.terminate(); return; }
      this.#settle(reply);
    });
    worker.on('error', () => { void worker.terminate(); });
    worker.on('exit', () => {
      if (this.#worker === worker) { this.#worker = null; this.#settle(null); }
    });
    return worker;
  }
  #settle(value: MimoWorkerReply | null): void {
    const pending = this.#pending; this.#pending = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(value); }
  }
  async #run(input: Omit<MimoWorkerRequest, 'job'>): Promise<MimoWorkerReply | null> {
    if (this.#stopped) return null;
    try {
      const worker = this.#ensureWorker(); const job = ++this.#job;
      return await new Promise<MimoWorkerReply | null>(resolve => {
        const timer = setTimeout(() => { void worker.terminate(); }, this.#timeoutMs);
        timer.unref(); this.#pending = { job, resolve, timer };
        worker.postMessage({ ...input, job });
      });
    } catch { this.#settle(null); return null; }
  }
  stop(): Promise<void> {
    if (this.#stopFlight) return this.#stopFlight;
    this.#stopped = true;
    const termination = this.#worker?.terminate();
    this.#stopFlight = Promise.all([termination, this.#tail]).then(() => undefined);
    return this.#stopFlight;
  }
}
