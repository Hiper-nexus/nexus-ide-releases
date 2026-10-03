import { afterEach, expect, it, vi } from 'vitest';
const source = vi.hoisted(() => ({ bytes: 10 }));
vi.mock('../pty/pty-analysis-runtime', () => ({ analysisClient: {
  diagnostics: () => ({ metrics: { admittedBytes: source.bytes }, sessions: [{
    sessionId: 'pty-one', status: 'active', pendingBytes: 0, totalAdmittedBytes: source.bytes, totalAckedBytes: source.bytes,
  }] }),
} }));
vi.mock('../observability/main-trace', () => ({ recentTraceContext: () => [], mainTraceStatus: () => ({ queuedBytes: 0, dropped: 0 }) }));
vi.mock('../observability/periodic-task', () => ({ periodicTaskSnapshot: () => ({ tasks: [] }) }));
import { sampleHangRuntimeContext } from './runtime-context';
afterEach(() => vi.useRealTimers());
it('records per-session throughput between heartbeats and tolerates a generation reset', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  expect(sampleHangRuntimeContext().analysis.sessionRates[0].outputBytesPerSecond).toBeNull();
  source.bytes = 5010; vi.setSystemTime(2000);
  const sample = sampleHangRuntimeContext();
  expect(sample.analysis.outputBytesPerSecond).toBe(5000);
  expect(sample.analysis.sessionRates[0].outputBytesPerSecond).toBe(5000);
  source.bytes = 2; vi.setSystemTime(3000);
  expect(sampleHangRuntimeContext().analysis.sessionRates[0].outputBytesPerSecond).toBe(0);
});
