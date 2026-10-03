import { periodicTaskSnapshot } from '../observability/periodic-task';
import { recentTraceContext, mainTraceStatus } from '../observability/main-trace';
import { analysisClient } from '../pty/pty-analysis-runtime';

let previous: { at: number; bytes: number } | null = null;
let previousSessions = new Map<string, number>();
/** Only bounded Main-owned labels/counters; no terminal bytes, paths or prompt content. */
export function sampleHangRuntimeContext() {
  const at = Date.now();
  const diagnostics = analysisClient.diagnostics();
  const analysis = diagnostics.metrics;
  const elapsed = previous ? at - previous.at : 0;
  const outputBytesPerSecond = previous && elapsed > 0
    ? Math.max(0, analysis.admittedBytes - previous.bytes) * 1000 / elapsed : null;
  const sessions = diagnostics.sessions.map(session => {
    const before = previousSessions.get(session.sessionId);
    return { sessionId: session.sessionId, status: session.status,
      pendingBytes: session.pendingBytes, totalAdmittedBytes: session.totalAdmittedBytes,
      totalAckedBytes: session.totalAckedBytes,
      outputBytesPerSecond: before !== undefined && elapsed > 0
        ? Math.max(0, session.totalAdmittedBytes - before) * 1000 / elapsed : null };
  });
  previous = { at, bytes: analysis.admittedBytes };
  previousSessions = new Map(sessions.map(session => [session.sessionId, session.totalAdmittedBytes]));
  return {
    sampledAt: at,
    events: recentTraceContext().slice(-32),
    periodic: periodicTaskSnapshot(),
    analysis: { ...analysis, outputBytesPerSecond, sessionRates: sessions },
    trace: mainTraceStatus(),
  };
}
