import { Worker } from 'node:worker_threads';
import { beforeEach, expect, it, vi } from 'vitest';
import * as initialRuntime from './pty-analysis-runtime';
let { analysisClient, bindPtyAnalysisSession, configurePtyAnalysis, feedPtyAnalysis, flushPtyAnalysis, setPtyAnalysisWorkerFactoryForTests, shutdownPtyAnalysis, startPtyAnalysis, statePtyAnalysis, subscribePtyAnalysis } = initialRuntime;
beforeEach(async () => {
  vi.resetModules();
  ({ analysisClient, bindPtyAnalysisSession, configurePtyAnalysis, feedPtyAnalysis, flushPtyAnalysis, setPtyAnalysisWorkerFactoryForTests, shutdownPtyAnalysis, startPtyAnalysis, statePtyAnalysis, subscribePtyAnalysis } = await import('./pty-analysis-runtime'));
});

it('keeps completed Worker output when Main misses the 250ms timer window', async () => {
  let worker!: Worker;
  let shared!: SharedArrayBuffer;
  setPtyAnalysisWorkerFactoryForTests((progress: SharedArrayBuffer | undefined) => {
    shared = progress ?? new SharedArrayBuffer(32);
    worker = new Worker(new URL('./__tests__/analysis-progress-worker.cjs', import.meta.url), { workerData: { analysisProgress: shared } });
    return worker;
  });
  configurePtyAnalysis({ describe: () => ({ adapterId: 'codex', paneId: 'main-delay' }), flow: () => {}, credit: () => {} });
  startPtyAnalysis(); bindPtyAnalysisSession('main-delay'); expect(await flushPtyAnalysis('main-delay')).toBe(true);
  let blocked = false;
  worker.on('message', message => {
    if (message.kind !== 'work-start' || blocked) return;
    blocked = true;
    setImmediate(() => { const until = Date.now() + 350; while (Date.now() < until) Math.imul(31, 17); });
  });
  try {
    feedPtyAnalysis('main-delay', 'completed-before-ack');
    expect(await flushPtyAnalysis('main-delay')).toBe(true);
    expect(analysisClient.status('main-delay')).toBe('active');
    expect(Atomics.load(new BigInt64Array(shared), 1)).toBeGreaterThan(0n);
  } finally { await shutdownPtyAnalysis(); }
}, 5_000);

it('does not let completed shared progress hide a missing result beyond the delivery deadline', async () => {
  setPtyAnalysisWorkerFactoryForTests(progress => new Worker(new URL('./__tests__/analysis-progress-worker.cjs', import.meta.url), { workerData: { analysisProgress: progress } }));
  startPtyAnalysis(); bindPtyAnalysisSession('missing-ack'); expect(await flushPtyAnalysis('missing-ack')).toBe(true);
  try {
    const startedAt = performance.now();
    feedPtyAnalysis('missing-ack', 'missing-ack');
    expect(await flushPtyAnalysis('missing-ack')).toBe(false);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2_000);
    expect(performance.now() - startedAt).toBeLessThan(3_500);
    expect(analysisClient.metrics().lastFailure).toBe('delivery-timeout');
  } finally { await shutdownPtyAnalysis(); }
}, 5_000);

it('physically terminates a Worker that never becomes ready within two seconds', async () => {
  setPtyAnalysisWorkerFactoryForTests(() => new Worker('setInterval(() => {}, 1000)', { eval: true }));
  startPtyAnalysis(); const startedAt = performance.now(); bindPtyAnalysisSession('startup-stall');
  try {
    expect(await flushPtyAnalysis('startup-stall')).toBe(false);
    expect(analysisClient.metrics().lastFailure).toBe('startup-timeout');
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2_000);
    expect(performance.now() - startedAt).toBeLessThan(3_500);
  } finally { await shutdownPtyAnalysis(); }
}, 5_000);

it('physically terminates an infinite background regex even after the last job completed', async () => {
  setPtyAnalysisWorkerFactoryForTests(progress => new Worker(new URL('./__tests__/analysis-progress-worker.cjs', import.meta.url), { workerData: { analysisProgress: progress } }));
  startPtyAnalysis(); bindPtyAnalysisSession('background-poison'); expect(await flushPtyAnalysis('background-poison')).toBe(true);
  try {
    feedPtyAnalysis('background-poison', 'background-poison'); expect(await flushPtyAnalysis('background-poison')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(analysisClient.status('background-poison')).toBe('degraded');
    expect(analysisClient.metrics().lastFailure).toBe('work-timeout');
  } finally { await shutdownPtyAnalysis(); }
}, 5_000);

it('preserves completed background evaluation when Main processes its end after 250ms', async () => {
  let worker!: Worker;
  setPtyAnalysisWorkerFactoryForTests(progress => {
    worker = new Worker(new URL('./__tests__/analysis-progress-worker.cjs', import.meta.url), { workerData: { analysisProgress: progress } }); return worker;
  });
  startPtyAnalysis(); bindPtyAnalysisSession('background-delay'); expect(await flushPtyAnalysis('background-delay')).toBe(true);
  const ended = new Promise<void>(resolve => worker.on('message', message => {
    if (message.kind === 'work-start' && message.activityToken) setImmediate(() => { const until = Date.now() + 350; while (Date.now() < until) Math.imul(31, 17); });
    if (message.kind === 'work-end') resolve();
  }));
  try {
    feedPtyAnalysis('background-delay', 'background-complete'); expect(await flushPtyAnalysis('background-delay')).toBe(true);
    await ended;
    expect(analysisClient.status('background-delay')).toBe('active');
    expect(await flushPtyAnalysis('background-delay')).toBe(true);
  } finally { await shutdownPtyAnalysis(); }
}, 5_000);

it('revokes delayed old-generation responses, terminates poison physically, and recovers only fresh generations', async () => {
  setPtyAnalysisWorkerFactoryForTests(() => new Worker(new URL('./__tests__/analysis-scripted-worker.cjs', import.meta.url)));
  configurePtyAnalysis({ describe: () => ({ adapterId: 'codex', paneId: 'finite' }), flow: () => {}, credit: () => {} });
  startPtyAnalysis(); const responses: unknown[] = [];
  const dispose = subscribePtyAnalysis('prompt', (_id, value) => responses.push(value));
  bindPtyAnalysisSession('adopted'); await flushPtyAnalysis('adopted');
  const oldGeneration = analysisClient.generation('adopted'); feedPtyAnalysis('adopted', 'delayed response');
  bindPtyAnalysisSession('adopted'); await flushPtyAnalysis('adopted');
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(analysisClient.generation('adopted')).toBeGreaterThan(oldGeneration!); expect(responses).toEqual([]);
  feedPtyAnalysis('adopted', 'poison:' + 'a'.repeat(5_000) + '!');
  const started = performance.now(); expect(await flushPtyAnalysis('adopted')).toBe(false);
  expect(performance.now() - started).toBeLessThan(1_000); expect(analysisClient.status('adopted')).toBe('degraded');
  bindPtyAnalysisSession('fresh'); expect(await flushPtyAnalysis('fresh')).toBe(true);
  expect(analysisClient.status('adopted')).toBe('degraded'); expect(analysisClient.status('fresh')).toBe('active');
  statePtyAnalysis('adopted', 'idle'); analysisClient.control('adopted', 'prompt', {});
  expect(await flushPtyAnalysis('fresh')).toBe(true);
  dispose(); await shutdownPtyAnalysis(); expect(analysisClient.metrics().inFlight).toBe(false);
}, 10_000);
