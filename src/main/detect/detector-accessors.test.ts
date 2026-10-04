import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const h = vi.hoisted(() => ({
  dataTaps: new Set<(sessionId: string, data: string) => void>(),
  exitTaps: new Set<(sessionId: string) => void>(),
}));

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: () => ({ adapterId: 'claude', paneId: 'p1' }),
  tapSessionData: (cb: (s: string, d: string) => void) => {
    h.dataTaps.add(cb);
    return () => h.dataTaps.delete(cb);
  },
  tapSessionExit: (cb: (s: string) => void) => {
    h.exitTaps.add(cb);
    return () => h.exitTaps.delete(cb);
  },
}));
vi.mock('../orch/agent-status', () => ({
  applyScreenDetectionEvent: vi.fn(),
}));
vi.mock('../pty/pty-analysis-runtime', async () => {
  const { PtyAnalysisCore } = await import('../pty/pty-analysis-core');
  const { loadManifestDir } = await import('./manifest');
  const { compileManifest } = await import('./compiler');
  const manifests = loadManifestDir(path.join(process.cwd(), 'resources/agent-detection')).map(row => compileManifest(row.manifest));
  const texts = new Map<string, string>();
  let flush: (id: string) => void = () => {};
  return {
    analysisClient: { text: (id: string) => texts.get(id) ?? '', generation: () => 1 },
    flushPtyAnalysis: async (id: string) => { flush(id); return true; },
    subscribePtyAnalysis: (_consumer: string, publish: (id: string, value: unknown, fence: { generation: number }) => void) => {
      const cores = new Map<string, { core: InstanceType<typeof PtyAnalysisCore>; seq: number }>();
      const tap = (id: string, data: string) => {
        let entry = cores.get(id);
        if (!entry) {
          const core = new PtyAnalysisCore(manifests, result => {
            if (result.screenText !== undefined) texts.set(result.sessionId, result.screenText);
            for (const event of result.events) if (event.consumer === 'screen') publish(result.sessionId, event.value, result);
          });
          entry = { core, seq: 0 }; cores.set(id, entry);
          core.process({ sessionId: id, generation: 1, workerEpoch: 1, eventSeq: ++entry.seq, observedAt: Date.now(), kind: 'bind', binding: { adapterId: 'claude', paneId: 'p1' } });
          core.process({ sessionId: id, generation: 1, workerEpoch: 1, eventSeq: ++entry.seq, observedAt: Date.now(), kind: 'arm', consumer: 'screen', registration: 1 });
        }
        entry.core.process({ sessionId: id, generation: 1, workerEpoch: 1, eventSeq: ++entry.seq, observedAt: Date.now(), kind: 'data', data });
      };
      flush = id => {
        const entry = cores.get(id); if (!entry) return;
        entry.core.process({ sessionId: id, generation: 1, workerEpoch: 1, eventSeq: ++entry.seq, observedAt: Date.now(), kind: 'flush' });
      };
      h.dataTaps.add(tap);
      return () => { h.dataTaps.delete(tap); for (const entry of cores.values()) entry.core.close(); cores.clear(); texts.clear(); };
    },
  };
});

import {
  __resetAgentScreenDetectionForTests,
  activeScreenText,
  startAgentScreenDetection,
  tapActiveScreenDetections,
} from './detector';
import { flushPtyAnalysis } from '../pty/pty-analysis-runtime';

describe('active-detector accessors', () => {
  afterEach(() => {
    __resetAgentScreenDetectionForTests();
    vi.useRealTimers();
  });

  it('null quando a detecção não está ativa', () => {
    expect(tapActiveScreenDetections(() => {})).toBeNull();
    expect(activeScreenText('s1')).toBeNull();
  });

  it('tap recebe records e activeScreenText devolve a cauda', async () => {
    vi.useFakeTimers();
    const dispose = startAgentScreenDetection();
    const records: unknown[] = [];
    const untap = tapActiveScreenDetections((r) => records.push(r));
    expect(untap).not.toBeNull();
    for (const tap of h.dataTaps) tap('s1', 'hello screen\n');
    vi.advanceTimersByTime(200);
    await flushPtyAnalysis('s1');
    expect(records.length).toBeGreaterThan(0);
    expect(activeScreenText('s1')).toContain('hello screen');
    untap?.();
    const count = records.length;
    for (const tap of h.dataTaps) tap('s1', 'more\n');
    vi.advanceTimersByTime(200);
    expect(records.length).toBe(count);
    dispose();
    expect(tapActiveScreenDetections(() => {})).toBeNull();
  });
});
