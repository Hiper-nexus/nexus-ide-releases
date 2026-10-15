import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { beforeEach, expect, it, vi } from 'vitest';
import { AnalysisJobProgress } from './pty-analysis-progress';
import * as initialRuntime from './pty-analysis-runtime';
let { analysisClient, bindPtyAnalysisSession, feedPtyAnalysis, flushPtyAnalysis, setPtyAnalysisWorkerFactoryForTests, shutdownPtyAnalysis, startPtyAnalysis } = initialRuntime;
beforeEach(async () => {
  vi.resetModules();
  ({ analysisClient, bindPtyAnalysisSession, feedPtyAnalysis, flushPtyAnalysis, setPtyAnalysisWorkerFactoryForTests, shutdownPtyAnalysis, startPtyAnalysis } = await import('./pty-analysis-runtime'));
});

/**
 * #17: o worker não posta `work-start` a cada registro. O início do trabalho
 * vai para a memória compartilhada e o Main confere em 250 ms; o resultado é a
 * única mensagem por registro.
 */
const fixture = (name: string) => new URL(`./__tests__/${name}`, import.meta.url);

it('AnalysisJobProgress mede o tempo de trabalho no relógio monotônico e só para o token em andamento', () => {
  const progress = new AnalysisJobProgress();
  expect(progress.elapsedMs(1)).toBeNull();
  progress.start(1);
  // Relógio de parede dando um salto (sleep do Mac, ajuste de NTP) não conta como trabalho.
  const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
  try {
    const elapsed = progress.elapsedMs(1);
    expect(elapsed).not.toBeNull();
    expect(elapsed!).toBeGreaterThanOrEqual(0);
    expect(elapsed!).toBeLessThan(1_000);
  } finally { wall.mockRestore(); }
  expect(progress.elapsedMs(2)).toBeNull();
  progress.reset();
  expect(progress.elapsedMs(1)).toBeNull();
});

it('o entry do worker de produção não posta work-start por registro, só o da avaliação com manifesto', () => {
  const entry = fs.readFileSync(path.join(process.cwd(), 'src/main/pty/pty-analysis-worker-entry.ts'), 'utf8');
  expect(entry.match(/kind: 'work-start'/g)).toHaveLength(1);
  expect(entry).toContain("activityToken");
});

it('mede mensagens do worker por registro: protocolo antigo 2, protocolo enxuto 1', async () => {
  const run = async (file: string) => {
    const messages: Record<string, number> = {};
    let worker!: Worker;
    setPtyAnalysisWorkerFactoryForTests((progress) => {
      worker = new Worker(fixture(file), { workerData: { analysisProgress: progress } }); return worker;
    });
    startPtyAnalysis(); bindPtyAnalysisSession('count'); await flushPtyAnalysis('count');
    worker.on('message', (message: { kind: string }) => { messages[message.kind] = (messages[message.kind] ?? 0) + 1; });
    for (let i = 0; i < 40; i += 1) { feedPtyAnalysis('count', `chunk ${i}\n`); expect(await flushPtyAnalysis('count')).toBe(true); }
    const total = Object.values(messages).reduce((sum, n) => sum + n, 0);
    await shutdownPtyAnalysis();
    return { messages, total };
  };
  const legacy = await run('analysis-progress-worker.cjs');
  vi.resetModules();
  ({ analysisClient, bindPtyAnalysisSession, feedPtyAnalysis, flushPtyAnalysis, setPtyAnalysisWorkerFactoryForTests, shutdownPtyAnalysis, startPtyAnalysis } = await import('./pty-analysis-runtime'));
  const lean = await run('analysis-lean-worker.cjs');
  console.info('[perf-budget] pty-analysis worker messages', JSON.stringify({ legacy, lean }));
  expect(lean.messages['work-start'] ?? 0).toBe(0);
  expect(lean.total).toBeLessThan(legacy.total);
}, 10_000);

it('sem work-start por registro, um job travado no meio do trabalho ainda derruba o worker em ~250 ms', async () => {
  setPtyAnalysisWorkerFactoryForTests((progress) => new Worker(fixture('analysis-lean-worker.cjs'), { workerData: { analysisProgress: progress } }));
  startPtyAnalysis(); bindPtyAnalysisSession('poison'); expect(await flushPtyAnalysis('poison')).toBe(true);
  try {
    const startedAt = performance.now();
    feedPtyAnalysis('poison', 'poison');
    expect(await flushPtyAnalysis('poison')).toBe(false);
    const elapsed = performance.now() - startedAt;
    expect(analysisClient.metrics().lastFailure).toBe('work-timeout');
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1_500);
    expect(analysisClient.status('poison')).toBe('degraded');
  } finally { await shutdownPtyAnalysis(); }
}, 10_000);

it('Main bloqueado além de 250 ms depois do envio não derruba um job que já terminou', async () => {
  setPtyAnalysisWorkerFactoryForTests((progress) => new Worker(fixture('analysis-lean-worker.cjs'), { workerData: { analysisProgress: progress } }));
  startPtyAnalysis(); bindPtyAnalysisSession('main-busy'); expect(await flushPtyAnalysis('main-busy')).toBe(true);
  try {
    feedPtyAnalysis('main-busy', 'done-quickly');
    const until = Date.now() + 400; while (Date.now() < until) Math.imul(31, 17);
    expect(await flushPtyAnalysis('main-busy')).toBe(true);
    expect(analysisClient.status('main-busy')).toBe('active');
  } finally { await shutdownPtyAnalysis(); }
}, 10_000);

it('job que ainda nem começou só cai no prazo de entrega de 2 s, não nos 250 ms de trabalho', async () => {
  // Worker que nunca consome o registro: nada na memória compartilhada.
  setPtyAnalysisWorkerFactoryForTests(() => new Worker("const { parentPort } = require('node:worker_threads'); parentPort.postMessage({ kind: 'ready' }); setInterval(() => {}, 1000);", { eval: true }));
  startPtyAnalysis(); bindPtyAnalysisSession('idle-worker');
  try {
    const startedAt = performance.now();
    expect(await flushPtyAnalysis('idle-worker')).toBe(false);
    const elapsed = performance.now() - startedAt;
    expect(analysisClient.metrics().lastFailure).toBe('delivery-timeout');
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(3_500);
  } finally { await shutdownPtyAnalysis(); }
}, 10_000);

it('worker que só começa depois de 1,7 s e termina logo não é morto quando o Main fica bloqueado além do prazo de entrega', async () => {
  setPtyAnalysisWorkerFactoryForTests((progress) => new Worker(fixture('analysis-late-worker.cjs'), { workerData: { analysisProgress: progress } }));
  startPtyAnalysis(); bindPtyAnalysisSession('late-complete'); expect(await flushPtyAnalysis('late-complete')).toBe(true);
  try {
    feedPtyAnalysis('late-complete', 'late-complete');
    // Main preso de 1,6 s a 2,4 s na fase `check` (setImmediate): o prazo de 2 s vence DENTRO do
    // bloqueio e, na volta, a fase de timers roda ANTES de entregar o resultado que já está na fila.
    await new Promise<void>((resolve) => setTimeout(() => setImmediate(() => { const until = Date.now() + 800; while (Date.now() < until) Math.imul(31, 17); resolve(); }), 1_600));
    expect(await flushPtyAnalysis('late-complete')).toBe(true);
    expect(analysisClient.status('late-complete')).toBe('active');
  } finally { await shutdownPtyAnalysis(); }
}, 15_000);

it('worker que começa perto do prazo de entrega e trava recebe o orçamento de trabalho, não o corte de entrega', async () => {
  setPtyAnalysisWorkerFactoryForTests((progress) => new Worker(fixture('analysis-late-worker.cjs'), { workerData: { analysisProgress: progress } }));
  startPtyAnalysis(); bindPtyAnalysisSession('late-poison'); expect(await flushPtyAnalysis('late-poison')).toBe(true);
  try {
    const startedAt = performance.now();
    feedPtyAnalysis('late-poison', 'late-poison');
    expect(await flushPtyAnalysis('late-poison')).toBe(false);
    const elapsed = performance.now() - startedAt;
    // Começou em ~1,9 s e travou: cai ~250 ms depois do início como work-timeout, não aos 2 s como delivery-timeout.
    expect(analysisClient.metrics().lastFailure).toBe('work-timeout');
    expect(elapsed).toBeGreaterThanOrEqual(2_100);
    expect(elapsed).toBeLessThan(3_500);
  } finally { await shutdownPtyAnalysis(); }
}, 15_000);
