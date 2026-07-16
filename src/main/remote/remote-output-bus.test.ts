// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ptyMocks = vi.hoisted(() => ({
  tap: null as ((sessionId: string, data: string) => void) | null,
  disposed: 0,
}));

vi.mock('../pty/pty-manager', () => ({
  tapSessionData: (cb: (sessionId: string, data: string) => void) => {
    ptyMocks.tap = cb;
    return () => {
      ptyMocks.disposed += 1;
      if (ptyMocks.tap === cb) ptyMocks.tap = null;
    };
  },
}));

import {
  clearPushCursors,
  peekPushCursor,
  subscribeEncodedSessionOutput,
} from './remote-output-bus';
import {
  clearRemoteTerminalStreams,
  encodeRemoteTerminalOutput,
} from './remote-terminal-streams';

type Delivery = { sessionId: string; seq: number; pushSeq: number; text: string };

describe('remote-output-bus', () => {
  beforeEach(() => {
    clearRemoteTerminalStreams();
    clearPushCursors();
  });

  it('encodes each chunk ONCE and fans the same frame out to every consumer', () => {
    const a: Delivery[] = [];
    const b: Delivery[] = [];
    const offA = subscribeEncodedSessionOutput({
      wants: () => true,
      deliver: (sessionId, encoded, text) =>
        a.push({ sessionId, seq: encoded.seq, pushSeq: encoded.pushSeq, text }),
    });
    const offB = subscribeEncodedSessionOutput({
      wants: () => true,
      deliver: (sessionId, encoded, text) =>
        b.push({ sessionId, seq: encoded.seq, pushSeq: encoded.pushSeq, text }),
    });

    ptyMocks.tap?.('sess-1', 'hello');
    ptyMocks.tap?.('sess-1', 'world');

    // Mesmo frame para os dois consumidores: a seq NÃO avança por consumidor.
    expect(a.map((d) => d.seq)).toEqual(b.map((d) => d.seq));
    expect(a[1]!.seq).toBe(a[0]!.seq + 1);
    expect(a.map((d) => d.pushSeq)).toEqual([1, 2]);
    expect(b.map((d) => d.pushSeq)).toEqual([1, 2]);
    expect(a.map((d) => d.text)).toEqual(['hello', 'world']);
    offA();
    offB();
  });

  it('keeps the push cursor immune to response-only encodes (no false gaps)', () => {
    const seen: Delivery[] = [];
    const off = subscribeEncodedSessionOutput({
      wants: () => true,
      deliver: (sessionId, encoded, text) =>
        seen.push({ sessionId, seq: encoded.seq, pushSeq: encoded.pushSeq, text }),
    });
    ptyMocks.tap?.('sess-1', 'a');
    // pane.read/pane.input encodam frames de RESPOSTA no mesmo stream — o seq
    // do frame avança, mas o cursor de push não pode.
    encodeRemoteTerminalOutput('sess-1', 'tail-do-pane-read');
    encodeRemoteTerminalOutput('sess-1', '');
    ptyMocks.tap?.('sess-1', 'b');

    expect(seen.map((d) => d.pushSeq)).toEqual([1, 2]); // consecutivo, sem gap
    expect(seen[1]!.seq).toBeGreaterThan(seen[0]!.seq + 1); // frame seq pulou
    expect(peekPushCursor('sess-1')).toBe(2);
    off();
  });

  it('does not encode (seq does not advance) when no consumer wants the session', () => {
    const off = subscribeEncodedSessionOutput({
      wants: (sessionId) => sessionId === 'sess-wanted',
      deliver: () => {},
    });
    ptyMocks.tap?.('sess-ignored', 'ruído');
    // Se o bus tivesse encodado, a próxima seq seria 2 — não 1.
    expect(encodeRemoteTerminalOutput('sess-ignored', 'probe').seq).toBe(1);
    expect(peekPushCursor('sess-ignored')).toBe(0);
    off();
  });

  it('slices oversized chunks into multiple sequential frames', () => {
    const seen: Delivery[] = [];
    const off = subscribeEncodedSessionOutput({
      wants: () => true,
      deliver: (sessionId, encoded, text) =>
        seen.push({ sessionId, seq: encoded.seq, pushSeq: encoded.pushSeq, text }),
    });
    ptyMocks.tap?.('sess-big', 'x'.repeat(24_000 + 10));
    expect(seen.length).toBe(2);
    expect(seen[0]!.text.length).toBe(24_000);
    expect(seen[1]!.text.length).toBe(10);
    expect(seen[1]!.seq).toBe(seen[0]!.seq + 1);
    expect(seen[1]!.pushSeq).toBe(seen[0]!.pushSeq + 1);
    off();
  });

  it('a throwing consumer never breaks delivery to the others', () => {
    const healthy: Delivery[] = [];
    const offBad = subscribeEncodedSessionOutput({
      wants: () => true,
      deliver: () => {
        throw new Error('boom');
      },
    });
    const offGood = subscribeEncodedSessionOutput({
      wants: () => true,
      deliver: (sessionId, encoded, text) =>
        healthy.push({ sessionId, seq: encoded.seq, pushSeq: encoded.pushSeq, text }),
    });
    expect(() => ptyMocks.tap?.('sess-1', 'safe')).not.toThrow();
    expect(healthy.map((d) => d.text)).toEqual(['safe']);
    offBad();
    offGood();
  });

  it('disposes the PTY tap when the last consumer unsubscribes', () => {
    const before = ptyMocks.disposed;
    const off = subscribeEncodedSessionOutput({
      wants: () => true,
      deliver: () => {},
    });
    expect(ptyMocks.tap).not.toBeNull();
    off();
    expect(ptyMocks.disposed).toBe(before + 1);
    expect(ptyMocks.tap).toBeNull();
  });
});
