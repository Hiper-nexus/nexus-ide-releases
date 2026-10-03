import { PtyAnalysisCore } from '../pty-analysis-core';
import type { AnalysisInput } from '../pty-analysis-protocol';
/** Actual Worker reducer over a deterministic test-only transport. */
export function failoverAnalysisFixture(taps: Array<(id: string, data: string) => void>) {
  const cores = new Map<string, { core: PtyAnalysisCore; seq: number }>();
  const queued: Array<{ id: string; body: object }> = [];
  let busy = false;
  let sink: ((id: string, value: unknown) => void) | null = null;
  function record(id: string, body: object) {
    queued.push({ id, body }); if (busy) return;
    busy = true;
    try { while (queued.length) {
      const next = queued.shift()!;
      let entry = cores.get(next.id);
      if (!entry) {
        const core = new PtyAnalysisCore([], (result) => { for (const event of result.events) if (event.consumer === 'failover') sink?.(result.sessionId, event.value); });
        entry = { core, seq: 0 }; cores.set(next.id, entry);
        core.process({ sessionId: next.id, generation: 1, workerEpoch: 1, eventSeq: ++entry.seq, observedAt: Date.now(), kind: 'bind', binding: {} });
        core.process({ sessionId: next.id, generation: 1, workerEpoch: 1, eventSeq: ++entry.seq, observedAt: Date.now(), kind: 'arm', consumer: 'failover', registration: 1 });
      }
      entry.core.process({ sessionId: next.id, generation: 1, workerEpoch: 1, eventSeq: ++entry.seq, observedAt: Date.now(), ...next.body } as AnalysisInput);
    } } finally { busy = false; }
  }
  return {
    analysisClient: { control: (id: string, consumer: string, value: unknown) => record(id, { kind: 'control', consumer, value }) },
    isPtyAnalysisEnabled: () => false,
    flushPtyAnalysis: async (id: string) => { record(id, { kind: 'flush' }); return true; },
    subscribePtyAnalysis: (_consumer: string, callback: (id: string, value: unknown) => void) => {
      sink = callback; const tap = (id: string, data: string) => record(id, { kind: 'data', data }); taps.push(tap);
      return () => { const index = taps.indexOf(tap); if (index >= 0) taps.splice(index, 1); for (const entry of cores.values()) entry.core.close(); cores.clear(); sink = null; };
    },
  };
}
