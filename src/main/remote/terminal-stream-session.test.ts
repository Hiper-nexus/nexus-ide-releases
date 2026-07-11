import { describe, expect, it } from 'vitest';
import { TerminalStreamOpcode } from '../../shared/terminal-stream-protocol';
import { TerminalStreamSession } from './terminal-stream-session';

describe('TerminalStreamSession', () => {
  it('round-trips output frames and tracks resume seq', () => {
    const a = new TerminalStreamSession({ streamId: 7 });
    const b = new TerminalStreamSession({ streamId: 7 });
    const payload = new TextEncoder().encode('hello');
    const wire = a.encodeOutput(payload);
    const frame = b.receive(wire);
    expect(frame?.opcode).toBe(TerminalStreamOpcode.Output);
    expect(new TextDecoder().decode(frame!.payload)).toBe('hello');
    expect(b.resumeFromSeq()).toBe(1);
    const wire2 = a.encodeOutput(new TextEncoder().encode('world'));
    b.receive(wire2);
    expect(b.resumeFromSeq()).toBe(2);
  });

  it('rejects frames for other stream ids', () => {
    const a = new TerminalStreamSession({ streamId: 1 });
    const b = new TerminalStreamSession({ streamId: 2 });
    expect(b.receive(a.encodeOutput(new Uint8Array([1])))).toBeNull();
  });

  it('rejects duplicate and older inbound sequence numbers', () => {
    const sender = new TerminalStreamSession({ streamId: 3 });
    const receiver = new TerminalStreamSession({ streamId: 3 });
    const first = sender.encodeOutput(new TextEncoder().encode('first'));
    const second = sender.encodeOutput(new TextEncoder().encode('second'));

    expect(receiver.receive(first)?.seq).toBe(1);
    expect(receiver.receive(second)?.seq).toBe(2);
    expect(receiver.receive(second)).toBeNull();
    expect(receiver.receive(first)).toBeNull();
    expect(receiver.resumeFromSeq()).toBe(2);
  });
});
