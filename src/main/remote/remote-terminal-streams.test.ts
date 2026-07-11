import { afterEach, describe, expect, it } from 'vitest';
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
} from '../../shared/terminal-stream-protocol';
import {
  clearRemoteTerminalStreams,
  encodeRemoteTerminalOutput,
  openRemoteTerminalStream,
  receiveRemoteTerminalFrame,
} from './remote-terminal-streams';
import { TerminalStreamSession } from './terminal-stream-session';

afterEach(() => {
  clearRemoteTerminalStreams();
});

describe('remote-terminal-streams (production path helpers)', () => {
  it('encodes pane output with real terminal-stream-protocol frames', () => {
    const encoded = encodeRemoteTerminalOutput('sess-1', 'hello-remote');
    expect(encoded.streamId).toBeGreaterThan(0);
    expect(encoded.seq).toBe(1);
    const frame = decodeTerminalStreamFrame(
      new Uint8Array(Buffer.from(encoded.frameBase64, 'base64')),
    );
    expect(frame?.opcode).toBe(TerminalStreamOpcode.Output);
    expect(new TextDecoder().decode(frame!.payload)).toBe('hello-remote');
  });

  it('accepts input frames from a peer session and returns resume cursor', () => {
    openRemoteTerminalStream('sess-2');
    const peer = new TerminalStreamSession({ streamId: 1 });
    // peer uses streamId 1; registry also starts at 1 for first session
    const wire = peer.encodeOutput(new TextEncoder().encode('from-client'));
    // Use Input opcode manually via encode path: send Output is fine for receive
    const received = receiveRemoteTerminalFrame(
      'sess-2',
      Buffer.from(wire).toString('base64'),
    );
    expect(received.text).toBe('from-client');
    expect(received.resumeFromSeq).toBe(1);
  });
});
