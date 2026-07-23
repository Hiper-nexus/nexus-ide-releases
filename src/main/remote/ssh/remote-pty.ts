// Remote PTY over SSH transport + terminal-stream frames (Gap D5).
// Patterns inspired by stablyai/orca remote PTY/stream @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA concepts); Nexus-authored.
// See third_party/licenses/orca-MIT.txt.

import {
  type TerminalResumeResult,
} from './remote-reconnect';
import { TerminalStreamSession } from '../terminal-stream-session';
import type { SshSession } from './ssh-session-manager';

export type RemotePtyHandle = {
  readonly streamId: number;
  writeInput(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  /** Subscribe to encoded terminal-stream frames (Output). */
  onFrame(cb: (frame: Uint8Array) => void): void;
  getLastSeq(): number;
  resumeAfter(clientLastSeq: number): TerminalResumeResult;
};

export async function openRemotePty(
  session: SshSession,
  options: {
    streamId: number;
    cols: number;
    rows: number;
    replay?: {
      maxFrames?: number;
      maxBytes?: number;
    };
  },
): Promise<RemotePtyHandle> {
  if (!session.transport.openPty) {
    throw new Error('remote-pty: transport does not support PTY');
  }
  const pty = await session.transport.openPty(options.cols, options.rows);
  const stream = new TerminalStreamSession({
    streamId: options.streamId,
    maxBufferedFrames: options.replay?.maxFrames,
    maxBufferedBytes: options.replay?.maxBytes,
  });
  let frameCb: ((frame: Uint8Array) => void) | null = null;

  pty.onData((data) => {
    const frame = stream.encodeOutput(new TextEncoder().encode(data));
    frameCb?.(frame);
  });

  return {
    streamId: options.streamId,
    writeInput(data) {
      pty.write(data);
    },
    resize(cols, rows) {
      pty.resize(cols, rows);
      const frame = stream.encodeResized(
        new TextEncoder().encode(JSON.stringify({ cols, rows })),
      );
      frameCb?.(frame);
    },
    close() {
      pty.close();
      frameCb = null;
    },
    onFrame(cb) {
      frameCb = cb;
    },
    getLastSeq() {
      return stream.lastEncodedSeq;
    },
    resumeAfter(clientLastSeq) {
      return stream.resumeAfter(clientLastSeq);
    },
  };
}
