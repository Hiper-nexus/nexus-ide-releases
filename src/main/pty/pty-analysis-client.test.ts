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
  it('seals EOF as the last job and keeps its archival evidence through late controls', async () => {
    const { client, sent, ack } = fixture();
    client.subscribe('completion', () => {}); client.bind('s', {}); ack(); ack();
    client.data('s', 'PRONTO: complete'); client.exit('s');
    client.control('s', 'completion', { drop: true }); client.state('s', 'idle'); client.terminate('s');
    ack([{ consumer: 'completion', registration: 1, value: { kind: 'done' }, archival: true }]);
    expect(sent.at(-1)?.kind).toBe('exit'); ack();
    expect(sent.at(-1)?.kind).toBe('exit');
    expect(await client.barrier('s')).toBe(true);
    expect(client.evidence('s', 'completion')).toEqual([{ kind: 'done' }]);
  });
  it('records the reason that resolved an analysis barrier as false', async () => {
    const { client, ack } = fixture(); client.bind('s', {}); ack();
    client.data('s', 'last bytes'); const barrier = client.barrier('s');
    client.fail('work-timeout');
    expect(await barrier).toBe(false);
    expect(client.metrics()).toMatchObject({ lastFailure: 'work-timeout', degraded: true });
  });
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

  it('coalesces small output without crossing an input/control edge or losing chunk descriptors', () => {
    const { client, sent, ack } = fixture(); client.bind('s', {}); ack();
    client.data('s', 'first'); client.data('s', 'second'); client.data('s', 'third');
    client.input('s', '\r'); client.data('s', 'fourth');
    ack();
    const batch = sent.at(-1)!;
    expect(batch.kind).toBe('data');
    if (batch.kind === 'data') { expect(batch.data).toBe('secondthird'); expect(batch.pieces?.map((p) => p.chars)).toEqual([6, 5]); }
    ack(); expect(sent.at(-1)?.kind).toBe('input');
    ack(); expect(sent.at(-1)?.kind).toBe('data');
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

  it('exposes bounded per-session byte diagnostics without terminal content', () => {
    const { client, ack } = fixture(); client.bind('s', {}); ack(); client.data('s', 'secret é'); ack();
    const diagnostics = client.diagnostics();
    expect(diagnostics.sessions).toEqual([{ sessionId: 's', status: 'active', pendingBytes: 0, totalAdmittedBytes: 9, totalAckedBytes: 9 }]);
    expect(JSON.stringify(diagnostics)).not.toContain('secret');
    client.bind('s', {}); ack(); expect(client.diagnostics().sessions[0].totalAckedBytes).toBe(9);
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

  it('orders a winsize between the chunks around it (DSK-03 grid reflow)', () => {
    const { client, sent, ack } = fixture();
    client.bind('s', {}); ack();
    client.data('s', 'before'); client.resize('s', 120, 40); client.data('s', 'after');
    ack(); ack(); ack();
    expect(sent.slice(1).map((r) => (r.kind === 'resize' ? `resize:${r.cols}x${r.rows}` : r.kind === 'data' ? r.data : r.kind)))
      .toEqual(['before', 'resize:120x40', 'after']);
  });
});
