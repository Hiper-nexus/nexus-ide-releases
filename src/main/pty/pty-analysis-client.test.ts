import { describe, expect, it } from 'vitest';
import { PtyAnalysisClient } from './pty-analysis-client';
import type { AnalysisInput, AnalysisResult } from './pty-analysis-protocol';

function fixture() {
  const sent: AnalysisInput[] = [];
  const pauses: [string, boolean][] = [];
  const client = new PtyAnalysisClient({
    post: (record) => sent.push(record),
    flow: (id, paused) => pauses.push([id, paused]),
    now: () => 100,
  });
  const ack = (events: AnalysisResult['events'] = []) => {
    const record = sent.at(-1)!;
    client.accept({ ...record, kind: 'result', events, ackBytes: record.kind === 'data' ? Buffer.byteLength(record.data) : 0 });
  };
  return { client, sent, pauses, ack };
}

describe('ordered off-Main analysis', () => {
  it('keeps a marker in the middle of a flood and counts UTF-8 bytes', () => {
    const { client, sent, ack } = fixture();
    client.bind('s', { adapterId: 'codex' }); ack();
    const raw = 'é'.repeat(60_000) + 'PRONTO: entregue\n' + 'x'.repeat(80_000);
    client.data('s', raw);
    let delivered = '';
    while (client.metrics().pendingBytes > 0 || client.metrics().inFlight) {
      const record = sent.at(-1)!;
      if (record.kind === 'data') delivered += record.data;
      ack();
    }
    expect(delivered).toBe(raw);
    expect(client.metrics().admittedBytes).toBe(Buffer.byteLength(raw));
    expect(client.metrics().ackedBytes).toBe(Buffer.byteLength(raw));
    expect(sent.filter((r) => r.kind === 'data').every((r) => Buffer.byteLength(r.data) <= 65_536)).toBe(true);
  });

  it('serves another session before draining a flood', () => {
    const { client, sent, ack } = fixture();
    client.bind('a', {}); ack(); client.bind('b', {}); ack();
    client.data('a', 'x'.repeat(180_000)); client.data('b', 'ready\n');
    ack();
    expect(sent.at(-1)?.sessionId).toBe('b');
  });

  it('fences reused ids, old epochs, unsubscribe and termination but accepts sealed final verdicts', () => {
    const { client, sent, ack } = fixture();
    const seen: string[] = [];
    const dispose = client.subscribe('completion', (id) => seen.push(id));
    client.bind('s', {}); ack(); ack();
    client.data('s', 'PRONTO: ok');
    const old = sent.at(-1)!;
    client.exit('s');
    client.accept({ ...old, kind: 'result', ackBytes: Buffer.byteLength(old.kind === 'data' ? old.data : ''), events: [{ consumer: 'completion', registration: 1, value: { marker: 'ready' }, archival: true }] });
    expect(seen).toEqual(['s']);
    ack(); client.bind('s', {}); ack();
    client.accept({ ...old, kind: 'result', ackBytes: Buffer.byteLength(old.kind === 'data' ? old.data : ''), events: [{ consumer: 'completion', registration: 1, value: {}, archival: true }] });
    expect(seen).toHaveLength(1);
    dispose();
    client.data('s', 'PRONTO: other');
    ack([{ consumer: 'completion', registration: 1, value: {}, archival: true }]);
    expect(seen).toHaveLength(1);
  });

  it('hard bounds held-ack queues and declares degraded without a synchronous text fallback', () => {
    const { client, pauses, ack } = fixture();
    client.bind('s', {}); ack();
    client.data('s', 'x'.repeat(240_000));
    expect(client.data('s', 'x'.repeat(240_000))).toBe(false);
    expect(client.metrics().pendingBytes).toBeLessThanOrEqual(262_144);
    expect(client.status('s')).toBe('degraded');
    expect(pauses).toContainEqual(['s', true]);
  });
});
