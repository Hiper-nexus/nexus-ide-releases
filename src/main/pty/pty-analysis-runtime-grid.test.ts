// DSK-03: Main hands the detector grid its winsize and relays only the
// closed `detector-ghostty-unavailable` trace a Worker may raise.
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';

const traces = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../observability/main-trace', () => ({ trace: (event: Record<string, unknown>) => traces.push(event) }));

import {
  bindPtyAnalysisSession,
  configurePtyAnalysis,
  feedPtyAnalysis,
  flushPtyAnalysis,
  resizePtyAnalysis,
  setPtyAnalysisWorkerFactoryForTests,
  shutdownPtyAnalysis,
  startPtyAnalysis,
} from './pty-analysis-runtime';
import type { AnalysisInput } from './pty-analysis-protocol';

/** In-thread stand-in for the analysis Worker: acks every record. */
class FakeWorker extends EventEmitter {
  readonly posted: AnalysisInput[] = [];
  constructor() {
    super();
    // Created inside the factory, so Main's listeners exist before this fires.
    queueMicrotask(() => this.emit('message', { kind: 'ready' }));
  }
  postMessage(record: AnalysisInput): void {
    this.posted.push(record);
    queueMicrotask(() => this.emit('message', {
      kind: 'result', workerEpoch: record.workerEpoch, sessionId: record.sessionId, generation: record.generation,
      eventSeq: record.eventSeq, observedAt: record.observedAt, events: [],
      ackBytes: record.kind === 'data' ? Buffer.byteLength(record.data) : 0, done: true,
    }));
  }
  terminate(): Promise<number> { return Promise.resolve(0); }
}

let fake!: FakeWorker;
setPtyAnalysisWorkerFactoryForTests(() => (fake = new FakeWorker()) as unknown as Worker);
const grids = new Map<string, { cols: number; rows: number }>([['s', { cols: 120, rows: 40 }]]);
configurePtyAnalysis({ describe: () => ({ adapterId: 'claude', paneId: 'p' }), flow: () => {}, credit: () => {}, grid: (id) => grids.get(id) ?? null });
startPtyAnalysis();
afterEach(() => { if (fake) fake.posted.length = 0; });

const shape = (records: AnalysisInput[]) => records.map((r) => (r.kind === 'resize' ? `resize:${r.cols}x${r.rows}` : r.kind));

it('gives every (re)bind the PTY winsize and forwards each resize in stream order', async () => {
  bindPtyAnalysisSession('s');
  resizePtyAnalysis('s', 100, 30);
  feedPtyAnalysis('s', 'hello');
  expect(await flushPtyAnalysis('s')).toBe(true);
  expect(shape(fake.posted)).toEqual(['bind', 'resize:120x40', 'resize:100x30', 'data', 'flush']);
  fake.posted.length = 0;
  // A role/mission rebind starts a fresh Worker screen: the winsize goes again.
  bindPtyAnalysisSession('s');
  expect(await flushPtyAnalysis('s')).toBe(true);
  expect(shape(fake.posted)).toEqual(['bind', 'resize:120x40', 'flush']);
});

it('skips the winsize when Main has none and ignores resizes for unknown sessions', async () => {
  bindPtyAnalysisSession('no-grid');
  resizePtyAnalysis('never-bound', 80, 24);
  expect(await flushPtyAnalysis('no-grid')).toBe(true);
  expect(shape(fake.posted)).toEqual(['bind', 'flush']);
});

it('traces the grid fallback a Worker reports, and nothing else', () => {
  fake.emit('message', { kind: 'trace', event: { kind: 'detector-ghostty-unavailable', reason: 'unavailable', detail: 'ENOENT' } });
  fake.emit('message', { kind: 'trace', event: { kind: 'detector-ghostty-unavailable', reason: 'Not A Reason!', detail: 'x' } });
  fake.emit('message', { kind: 'trace', event: { kind: 'arbitrary', reason: 'unavailable' } });
  expect(traces.filter((event) => event.kind !== 'pty-analysis-degraded')).toEqual([
    { kind: 'detector-ghostty-unavailable', reason: 'unavailable', detail: 'ENOENT' },
  ]);
});

it('shuts down cleanly', async () => {
  await shutdownPtyAnalysis();
});
