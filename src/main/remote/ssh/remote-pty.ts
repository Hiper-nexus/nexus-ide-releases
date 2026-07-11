// Remote PTY over SSH transport + terminal-stream frames (Gap D5).
// Patterns inspired by stablyai/orca remote PTY/stream @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA concepts); Nexus-authored.
// See third_party/licenses/orca-MIT.txt.

import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from '../../../shared/terminal-stream-protocol';
import type { SshSession } from './ssh-session-manager';

export type RemotePtyHandle = {
  readonly streamId: number;
  writeInput(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  /** Subscribe to encoded terminal-stream frames (Output). */
  onFrame(cb: (frame: Uint8Array) => void): void;
  getLastSeq(): number;
};

export async function openRemotePty(
  session: SshSession,
  options: { streamId: number; cols: number; rows: number },
): Promise<RemotePtyHandle> {
  if (!session.transport.openPty) {
    throw new Error('remote-pty: transport does not support PTY');
  }
  const pty = await session.transport.openPty(options.cols, options.rows);
  let seq = 0;
  let frameCb: ((frame: Uint8Array) => void) | null = null;

  pty.onData((data) => {
    seq += 1;
    const frame: TerminalStreamFrame = {
      opcode: TerminalStreamOpcode.Output,
      streamId: options.streamId,
      seq,
      payload: new TextEncoder().encode(data),
    };
    frameCb?.(encodeTerminalStreamFrame(frame));
  });

  return {
    streamId: options.streamId,
    writeInput(data) {
      pty.write(data);
    },
    resize(cols, rows) {
      pty.resize(cols, rows);
      seq += 1;
      const frame: TerminalStreamFrame = {
        opcode: TerminalStreamOpcode.Resized,
        streamId: options.streamId,
        seq,
        payload: new TextEncoder().encode(JSON.stringify({ cols, rows })),
      };
      frameCb?.(encodeTerminalStreamFrame(frame));
    },
    close() {
      pty.close();
      frameCb = null;
    },
    onFrame(cb) {
      frameCb = cb;
    },
    getLastSeq() {
      return seq;
    },
  };
}
