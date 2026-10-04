import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { analysisClient, bindPtyAnalysisSession, configurePtyAnalysis, feedPtyAnalysis, flushPtyAnalysis, setPtyAnalysisWorkerFactoryForTests, shutdownPtyAnalysis, startPtyAnalysis, statePtyAnalysis, subscribePtyAnalysis } from './pty-analysis-runtime';

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
