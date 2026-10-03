import { periodicTaskSnapshot } from '../observability/periodic-task';
import { recentTraceContext, mainTraceStatus } from '../observability/main-trace';
import { analysisClient } from '../pty/pty-analysis-runtime';

let previous: { at: number; bytes: number } | null = null;
/** Only bounded Main-owned labels/counters; no terminal bytes, paths or prompt content. */
export function sampleHangRuntimeContext() {
  const at = Date.now();
  const analysis = analysisClient.metrics();
  const elapsed = previous ? at - previous.at : 0;
  const outputBytesPerSecond = previous && elapsed > 0
    ? Math.max(0, analysis.admittedBytes - previous.bytes) * 1000 / elapsed : null;
  previous = { at, bytes: analysis.admittedBytes };
  return {
    sampledAt: at,
    events: recentTraceContext().slice(-32),
    periodic: periodicTaskSnapshot(),
    analysis: { ...analysis, outputBytesPerSecond },
    trace: mainTraceStatus(),
  };
}
