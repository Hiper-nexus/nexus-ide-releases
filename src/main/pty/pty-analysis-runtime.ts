import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveGhosttyWasmPath } from '../detect/ghostty-runtime';
import { resolveManifestDir } from '../detect/manifest';
import { trace } from '../observability/main-trace';
import { PtyAnalysisClient } from './pty-analysis-client';
import { AnalysisJobProgress } from './pty-analysis-progress';
import { validAnalysisResult, validWorkerTrace, type AnalysisBinding, type AnalysisConsumer, type AnalysisFence, type AnalysisInput, type AnalysisWorkerMessage } from './pty-analysis-protocol';

let enabled = false;
let worker: Worker | null = null;
let physicalStop: Promise<void> = Promise.resolve();
let ready = false;
let pending: AnalysisInput | null = null;
let deadline: ReturnType<typeof setTimeout> | null = null;
let flow: (id: string, paused: boolean) => void = () => {};
let credit: (id: string, bytes: number) => void = () => {};
let workerFactory: ((progress: SharedArrayBuffer) => Worker) | null = null;
export function setPtyAnalysisWorkerFactoryForTests(factory: (progress: SharedArrayBuffer) => Worker): void {
  if (worker) throw new Error('analysis worker already started'); workerFactory = factory;
}
let describe: (id: string) => AnalysisBinding = () => ({});
let grid: (id: string) => { cols: number; rows: number } | null = () => null;
const failures: number[] = [];
const quarantinedManifests = new Set<string>();
let riskyManifest: string | null = null;
const bindings = new Map<string, AnalysisBinding>();
let progress: AnalysisJobProgress | null = null;
let activeRecord: AnalysisInput | null = null;
let activeToken = 0; let nextToken = 0; let workStartedToken = 0;
let deadlineActivity: number | null = null;
/** O resultado atrás dos timers do Main perdoa o prazo uma vez por job; sem resultado, a segunda vez derruba. */
let lateAckGranted = false;
function stopDeadline() { if (deadline) clearTimeout(deadline); deadline = null; deadlineActivity = null; }
function fail(reason: string) {
  stopDeadline(); const old = worker; worker = null; ready = false; pending = null; activeRecord = null; progress = null;
  if (reason === 'work-timeout' && riskyManifest) quarantinedManifests.add(riskyManifest);
  if (reason !== 'shutdown') failures.push(Date.now()); riskyManifest = null;
  analysisClient.fail(reason);
  if (old) { physicalStop = Promise.all([physicalStop, old.terminate()]).then(() => {}); void physicalStop.catch(() => {}); }
  return physicalStop;
}
/** Orçamento de trabalho de um registro depois que o Worker o começou, e prazo total de entrega. */
const WORK_BUDGET_MS = 250;
const DELIVERY_BUDGET_MS = 2_000;
function armDeadline(ms: number, reason: string, activity: number | null = null) {
  stopDeadline();
  deadlineActivity = activity;
  const owner = worker; const job = activeToken; const jobProgress = progress;
  deadline = setTimeout(() => {
    if (worker !== owner || (activity === null && activeToken !== job)) return;
    if (activity === null && (reason === 'work-check' || reason === 'delivery-timeout')) {
      // O Worker não posta work-start por registro (#17): o início está na memória
      // compartilhada. Terminou: o resultado só está atrás dos timers do Main (uma
      // vez por job; sem resultado de verdade vale o prazo de entrega). Começou: tem
      // 250 ms de trabalho a partir do INÍCIO. Não começou: vale o prazo de entrega.
      if (!lateAckGranted && jobProgress?.completed(job)) {
        lateAckGranted = true;
        trace({ kind: 'pty-analysis-main-delayed-ack', workerEpoch: activeRecord?.workerEpoch, job, budgetMs: ms });
        if (activeRecord) armDeadline(DELIVERY_BUDGET_MS, 'delivery-timeout'); else stopDeadline();
        return;
      }
      const elapsed = jobProgress?.elapsedMs(job) ?? null;
      if (elapsed !== null && !jobProgress?.completed(job)) {
        const left = WORK_BUDGET_MS - Math.max(0, elapsed);
        if (left > 0) { armDeadline(left, 'work-check'); return; }
        fail('work-timeout'); return;
      }
      if (reason === 'work-check') { armDeadline(DELIVERY_BUDGET_MS - WORK_BUDGET_MS, 'delivery-timeout'); return; }
      fail(reason); return;
    }
    // The result can be queued behind Main's timers after a long Main callback.
    // Only this exact job on this exact Worker can prove completion; a missing
    // ACK still has the separate, unchanged two-second delivery deadline.
    if (reason === 'work-timeout' && (activity === null ? jobProgress?.completed(job) : jobProgress?.completedActivity(activity))) {
      trace({ kind: 'pty-analysis-main-delayed-ack', workerEpoch: activeRecord?.workerEpoch, job, budgetMs: ms });
      lateAckGranted = true;
      if (activeRecord) armDeadline(2_000, 'delivery-timeout'); else stopDeadline();
      return;
    }
    fail(reason);
  }, ms); deadline.unref?.();
}
function ensureWorker() {
  if (worker) return;
  let appPath = process.cwd(); let packaged = false;
  try { const { app } = require('electron') as typeof import('electron'); appPath = app.getAppPath(); packaged = app.isPackaged; } catch {}
  const manifestDir = resolveManifestDir({ appPath, packaged, resourcesPath: process.resourcesPath });
  const ghosttyWasmPath = resolveGhosttyWasmPath({ appPath, packaged, resourcesPath: process.resourcesPath });
  progress = new AnalysisJobProgress();
  const created = workerFactory ? workerFactory(progress.buffer) : new Worker(path.join(__dirname, 'pty-analysis-worker-entry.js'), { workerData: { manifestDir, ghosttyWasmPath, quarantinedManifests: [...quarantinedManifests], analysisProgress: progress.buffer } });
  worker = created;
  armDeadline(2_000, 'startup-timeout');
  created.on('message', (message: AnalysisWorkerMessage) => {
    if (worker !== created) return;
    if (message.kind === 'ready') {
      ready = true; stopDeadline();
      if (pending) { const record = pending; pending = null; send(record); }
    } else if (message.kind === 'work-end') {
      if (message.activityToken !== undefined && message.activityToken === deadlineActivity) {
        stopDeadline(); if (activeRecord) armDeadline(2_000, 'delivery-timeout');
      }
      if (message.watchdogToken !== undefined && message.watchdogToken !== activeToken) return;
      riskyManifest = null;
    } else if (message.kind === 'work-start') {
      if (message.watchdogToken === undefined && Number.isSafeInteger(message.activityToken) && message.activityToken! > 0) {
        riskyManifest = typeof message.manifestId === 'string' && message.manifestId.length <= 128 ? message.manifestId : null;
        armDeadline(250, 'work-timeout', message.activityToken); return;
      }
      if (message.watchdogToken !== undefined && message.watchdogToken !== activeToken) return;
      if (message.watchdogToken === undefined && (message.workerEpoch !== activeRecord?.workerEpoch || message.job !== activeRecord?.eventSeq || message.sessionId !== activeRecord?.sessionId)) return;
      const manifest = (message as { manifestId?: unknown }).manifestId;
      riskyManifest = typeof manifest === 'string' && manifest.length <= 128 ? manifest : null;
      if (workStartedToken !== activeToken) { workStartedToken = activeToken; armDeadline(250, 'work-timeout'); }
    } else if (message.kind === 'trace') {
      const event = validWorkerTrace(message.event); if (event) trace({ ...event });
    } else if (message.kind === 'failed') fail(message.reason);
    else {
      if (validAnalysisResult(message) && message.done !== false && activeRecord &&
          message.workerEpoch === activeRecord.workerEpoch && message.generation === activeRecord.generation &&
          message.sessionId === activeRecord.sessionId && message.eventSeq === activeRecord.eventSeq &&
          message.ackBytes === (activeRecord.kind === 'data' ? Buffer.byteLength(activeRecord.data) : 0)) { stopDeadline(); activeRecord = null; }
      analysisClient.accept(message);
    }
  });
  created.once('error', () => { if (worker === created) fail('worker-error'); });
  created.once('exit', () => { if (worker === created) fail('worker-exit'); });
}
function send(record: AnalysisInput) {
  ensureWorker();
  if (!ready) { pending = record; return; }
  activeRecord = record; activeToken = nextToken = nextToken >= 0x7fffffff ? 1 : nextToken + 1;
  workStartedToken = 0; lateAckGranted = false; progress!.reset();
  // Covers a worker that stops consuming before posting work-start as well.
  if (deadlineActivity === null) armDeadline(WORK_BUDGET_MS, 'work-check');
  worker!.postMessage({ ...record, watchdogToken: activeToken });
}
export const analysisClient = new PtyAnalysisClient({ post: send, now: Date.now,
  flow: (id, paused) => flow(id, paused), acknowledged: (id, bytes) => credit(id, bytes), trace });
export function configurePtyAnalysis(deps: { describe: typeof describe; flow: typeof flow; credit: typeof credit; grid?: typeof grid }) {
  describe = deps.describe; flow = deps.flow; credit = deps.credit; grid = deps.grid ?? (() => null);
}
export function startPtyAnalysis() { enabled = true; }
export function isPtyAnalysisEnabled() { return enabled; }
export function bindPtyAnalysisSession(id: string) {
  if (!enabled) return 0;
  while (failures.length && Date.now() - failures[0] >= 60_000) failures.shift();
  if (analysisClient.metrics().degraded && failures.length <= 3 && !worker) analysisClient.recoverFreshSessions();
  const binding = describe(id); bindings.set(id, binding);
  const generation = analysisClient.bind(id, binding);
  // Every (re)bind starts a fresh screen in the Worker: give it the winsize.
  const size = grid(id); if (size) analysisClient.resize(id, size.cols, size.rows);
  return generation;
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
export function resizePtyAnalysis(id: string, cols: number, rows: number) { if (enabled && analysisClient.has(id)) analysisClient.resize(id, cols, rows); }
export function exitPtyAnalysis(id: string) { analysisClient.exit(id); bindings.delete(id); }
export function terminatePtyAnalysis(id: string) { analysisClient.terminate(id); }
export function subscribePtyAnalysis(consumer: AnalysisConsumer, callback: (id: string, value: unknown, fence: AnalysisFence) => void, config?: unknown) {
  return analysisClient.subscribe(consumer, callback, config);
}
export function flushPtyAnalysis(id: string): Promise<boolean> { return analysisClient.barrier(id); }
export async function shutdownPtyAnalysis(): Promise<void> { enabled = false; await fail('shutdown'); }

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

export function getPtyAnalysisLimitEvidence(sessionId: string, now = Date.now()):
  { status: 'accepted'; binding: { paneId: string; adapterId: string }; hit: import('../orch/limit-detector').LimitHit | null } | { status: 'unavailable' } {
  if (analysisClient.status(sessionId) !== 'active') return { status: 'unavailable' };
  const binding = describe(sessionId);
  if (!binding.paneId || !binding.adapterId) return { status: 'unavailable' };
  const cached = analysisClient.latest(sessionId, 'failover');
  if (!cached || now - cached.fence.observedAt > 10_000 || now < cached.fence.observedAt) return { status: 'unavailable' };
  const proposal = cached.value as import('../orch/failover-text-core').FailoverTextProposal;
  return proposal.scanned ? { status: 'accepted', binding: { paneId: binding.paneId, adapterId: binding.adapterId }, hit: proposal.hit ?? null } : { status: 'unavailable' };
}
