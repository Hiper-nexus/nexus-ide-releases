import { describe, expect, it } from 'vitest';
import { PtyAnalysisCore } from './pty-analysis-core';
import type { AnalysisInput, AnalysisResult } from './pty-analysis-protocol';

function fixture() {
  const results: AnalysisResult[] = [];
  const core = new PtyAnalysisCore([], (result) => results.push(result));
  let seq = 0;
  const feed = (body: object) => core.process({ workerEpoch: 1, generation: 1, sessionId: 's', eventSeq: ++seq, observedAt: 100 + seq, ...body } as AnalysisInput);
  feed({ kind: 'bind', binding: { adapterId: 'codex' } });
  return { core, feed, results };
}

describe('production analysis reducers', () => {
  it('preserves split ANSI/OSC and local dev URLs', () => {
    const raw = '\x1b[32mLocal: http://localhost:5173/\x1b[0m\n\x1b]133;E;echo hello\x07\x1b]133;B\x07\x1b]133;D;0\x07';
    for (let split = 0; split <= raw.length; split++) {
      const { core, feed, results } = fixture();
      feed({ kind: 'arm', consumer: 'dev-server', registration: 1 });
      feed({ kind: 'arm', consumer: 'command', registration: 1 });
      feed({ kind: 'data', data: raw.slice(0, split) });
      feed({ kind: 'data', data: raw.slice(split) });
      feed({ kind: 'flush' });
      const events = results.flatMap((r) => r.events);
      expect(events.filter((e) => e.consumer === 'dev-server').map((e) => e.value)).toContainEqual(['http://localhost:5173/']);
      expect(events.filter((e) => e.consumer === 'command').flatMap((e) => e.value)).toContainEqual({ kind: 'command_finished', exitCode: 0 });
      expect(results.at(-1)?.screenText).toBe('Local: http://localhost:5173/\n');
      core.close();
    }
  });
  it('scans quota markers in the middle of a megabyte instead of only its tail', () => {
    const { core, feed, results } = fixture();
    feed({ kind: 'arm', consumer: 'failover', registration: 1 });
    feed({ kind: 'data', data: 'x'.repeat(500_000) + '\nusage limit reached\n' + 'y'.repeat(500_000) });
    expect(results.flatMap((r) => r.events).some((e) => e.consumer === 'failover' && (e.value as { hit?: { kind: string } }).hit?.kind === 'rate-limit')).toBe(true);
    core.close();
  });
  it('seals PRONTO immediately before exit and excludes registered prompt echo', () => {
    const { core, feed, results } = fixture();
    feed({ kind: 'arm', consumer: 'completion', registration: 1, config: { prompt: 'Escreva PRONTO: <resumo>' } });
    feed({ kind: 'data', data: 'PRONTO: <resumo>\n' });
    expect(results.flatMap((r) => r.events)).toHaveLength(0);
    feed({ kind: 'data', data: 'PRONTO: código entregue' });
    feed({ kind: 'exit' });
    expect(results.at(-1)?.events).toContainEqual({ consumer: 'completion', registration: 1, value: { kind: 'done', text: 'código entregue', at: 105 }, archival: true });
    core.close();
  });
});
