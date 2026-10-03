import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveManifestDir } from '../detect/manifest';
import { trace } from '../observability/main-trace';
import { PtyAnalysisClient } from './pty-analysis-client';
import type { AnalysisBinding, AnalysisConsumer, AnalysisFence, AnalysisInput, AnalysisWorkerMessage } from './pty-analysis-protocol';

let enabled = false;
let worker: Worker | null = null;
let ready = false;
let pending: AnalysisInput | null = null;
let deadline: ReturnType<typeof setTimeout> | null = null;
let flow: (id: string, paused: boolean) => void = () => {};
let credit: (id: string, bytes: number) => void = () => {};
let describe: (id: string) => AnalysisBinding = () => ({});
const bindings = new Map<string, AnalysisBinding>();
function stopDeadline() { if (deadline) clearTimeout(deadline); deadline = null; }
function fail(reason: string) {
  stopDeadline(); const old = worker; worker = null; ready = false; pending = null;
  analysisClient.fail(reason); void old?.terminate();
}
function armDeadline(ms: number, reason: string) {
  stopDeadline(); deadline = setTimeout(() => fail(reason), ms); deadline.unref?.();
}
function ensureWorker() {
  if (worker) return;
  let appPath = process.cwd(); let packaged = false;
  try { const { app } = require('electron') as typeof import('electron'); appPath = app.getAppPath(); packaged = app.isPackaged; } catch {}
  const manifestDir = resolveManifestDir({ appPath, packaged, resourcesPath: process.resourcesPath });
  const created = new Worker(path.join(__dirname, 'pty-analysis-worker-entry.js'), { workerData: { manifestDir } });
  worker = created;
  armDeadline(2_000, 'startup-timeout');
  created.on('message', (message: AnalysisWorkerMessage) => {
    if (worker !== created) return;
    if (message.kind === 'ready') {
      ready = true; stopDeadline();
      if (pending) { const record = pending; pending = null; send(record); }
    } else if (message.kind === 'work-start') {
      armDeadline(250, 'work-timeout');
    } else if (message.kind === 'failed') fail(message.reason);
    else {
      if (message.done !== false) stopDeadline();
      analysisClient.accept(message);
    }
  });
  created.once('error', () => { if (worker === created) fail('worker-error'); });
  created.once('exit', () => { if (worker === created) fail('worker-exit'); });
}
function send(record: AnalysisInput) {
  ensureWorker();
  if (!ready) { pending = record; return; }
  // Covers a worker that stops consuming before posting work-start as well.
  armDeadline(2_000, 'delivery-timeout'); worker!.postMessage(record);
}
export const analysisClient = new PtyAnalysisClient({ post: send, now: Date.now,
  flow: (id, paused) => flow(id, paused), acknowledged: (id, bytes) => credit(id, bytes), trace });
export function configurePtyAnalysis(deps: { describe: typeof describe; flow: typeof flow; credit: typeof credit }) {
  describe = deps.describe; flow = deps.flow; credit = deps.credit;
}
export function startPtyAnalysis() { enabled = true; }
export function isPtyAnalysisEnabled() { return enabled; }
export function bindPtyAnalysisSession(id: string) {
  if (!enabled) return 0;
  const binding = describe(id); bindings.set(id, binding); return analysisClient.bind(id, binding);
}
function ensureBinding(id: string) {
  if (!enabled) return;
  if (!analysisClient.has(id)) bindPtyAnalysisSession(id);
  const next = describe(id); const previous = bindings.get(id);
  if (next.adapterId !== previous?.adapterId || next.paneId !== previous?.paneId || next.model !== previous?.model) {
    bindings.set(id, next); analysisClient.control(id, 'screen', { binding: next });
  }
}
export function feedPtyAnalysis(id: string, data: string) {
  if (!enabled) return;
  ensureBinding(id);
  if (!analysisClient.data(id, data)) credit(id, Buffer.byteLength(data));
}
export function inputPtyAnalysis(id: string, data: string) { if (!enabled) return; ensureBinding(id); analysisClient.input(id, data); }
export function statePtyAnalysis(id: string, state: string) { if (analysisClient.has(id)) analysisClient.state(id, state); }
export function exitPtyAnalysis(id: string) { analysisClient.exit(id); bindings.delete(id); }
export function terminatePtyAnalysis(id: string) { analysisClient.terminate(id); }
export function subscribePtyAnalysis(consumer: AnalysisConsumer, callback: (id: string, value: unknown, fence: AnalysisFence) => void, config?: unknown) {
  return analysisClient.subscribe(consumer, callback, config);
}
export function flushPtyAnalysis(id: string): Promise<boolean> { return analysisClient.barrier(id); }
export function shutdownPtyAnalysis() { fail('shutdown'); }

/** Per-session finite watch. Watch ids fence cancellation/re-arm independently
 * of the worker subscription's generation, so simultaneous pastes are safe. */
const sessionWatches = new Map<AnalysisConsumer, Map<string, { id: number; callback: (value: unknown) => void }>>();
const sessionWatchSubscriptions = new Set<AnalysisConsumer>();
let watchId = 0;
export function watchPtyAnalysisSession(consumer: AnalysisConsumer, sessionId: string, config: object, callback: (value: unknown) => void): () => void {
  let watches = sessionWatches.get(consumer);
  if (!watches) { watches = new Map(); sessionWatches.set(consumer, watches); }
  if (!sessionWatchSubscriptions.has(consumer)) {
    sessionWatchSubscriptions.add(consumer);
    subscribePtyAnalysis(consumer, (id, value) => {
      const watch = sessionWatches.get(consumer)?.get(id);
      if (watch && (value as { watchId?: number }).watchId === watch.id) watch.callback(value);
    });
  }
  ensureBinding(sessionId);
  const watch = { id: ++watchId, callback }; watches.set(sessionId, watch);
  analysisClient.arm(sessionId, consumer, { ...config, watchId: watch.id });
  return () => { if (watches!.get(sessionId) === watch) { watches!.delete(sessionId); analysisClient.control(sessionId, consumer, { cancel: watch.id }); } };
}
