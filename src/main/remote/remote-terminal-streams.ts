// Production registry: binds TerminalStreamSession (ORCA protocol) to remote-bridge
// pane I/O. Local ProjectExecutionScope authority is enforced by the bridge
// before these helpers are called.
//
// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: session registry keyed
// by Nexus PTY sessionId for remote-bridge production path.

import {
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from '../../shared/terminal-stream-protocol';
import { TerminalStreamSession } from './terminal-stream-session';

const sessions = new Map<string, TerminalStreamSession>();
let nextStreamId = 1;

export function getOrCreateRemoteTerminalStream(
  sessionId: string,
): TerminalStreamSession {
  let session = sessions.get(sessionId);
  if (!session) {
    session = new TerminalStreamSession({ streamId: nextStreamId++ });
    sessions.set(sessionId, session);
  }
  return session;
}

export function clearRemoteTerminalStreams(): void {
  sessions.clear();
  nextStreamId = 1;
}

export function encodeRemoteTerminalOutput(
  sessionId: string,
  text: string,
): {
  streamId: number;
  frameBase64: string;
  seq: number;
  resumeFromSeq: number;
} {
  const session = getOrCreateRemoteTerminalStream(sessionId);
  const payload = new TextEncoder().encode(text);
  const frame = session.encodeOutput(payload);
  return {
    streamId: session.streamId,
    frameBase64: Buffer.from(frame).toString('base64'),
    seq: session.lastEncodedSeq,
    resumeFromSeq: session.resumeFromSeq(),
  };
}

export function openRemoteTerminalStream(sessionId: string): {
  streamId: number;
  subscribeFrameBase64: string;
  resumeFromSeq: number;
} {
  const session = getOrCreateRemoteTerminalStream(sessionId);
  const frame = session.encodeSubscribe();
  return {
    streamId: session.streamId,
    subscribeFrameBase64: Buffer.from(frame).toString('base64'),
    resumeFromSeq: session.resumeFromSeq(),
  };
}

export function receiveRemoteTerminalFrame(
  sessionId: string,
  frameBase64: string,
): {
  frame: TerminalStreamFrame;
  text: string | null;
  resumeFromSeq: number;
} {
  const session = getOrCreateRemoteTerminalStream(sessionId);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(frameBase64, 'base64'));
  } catch {
    throw new Error('invalid stream frame encoding');
  }
  const frame = session.receive(bytes);
  if (!frame) throw new Error('invalid stream frame');
  const text =
    frame.opcode === TerminalStreamOpcode.Input ||
    frame.opcode === TerminalStreamOpcode.Output
      ? new TextDecoder().decode(frame.payload)
      : null;
  return {
    frame,
    text,
    resumeFromSeq: session.resumeFromSeq(),
  };
}
