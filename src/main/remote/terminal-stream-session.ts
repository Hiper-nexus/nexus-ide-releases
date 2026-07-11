// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: production session
// wrapper around shared terminal-stream-protocol with seq/reconnect resume.

import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from '../../shared/terminal-stream-protocol';

export type TerminalStreamSessionOptions = {
  readonly streamId: number;
  readonly initialSeq?: number;
};

/**
 * Production-facing stream session: encodes/decodes frames and tracks the last
 * acknowledged sequence for reconnect/resume.
 */
export class TerminalStreamSession {
  readonly streamId: number;
  #nextSeq: number;
  #lastRxSeq: number;

  constructor(options: TerminalStreamSessionOptions) {
    this.streamId = options.streamId;
    this.#nextSeq = options.initialSeq ?? 1;
    this.#lastRxSeq = 0;
  }

  get lastReceivedSeq(): number {
    return this.#lastRxSeq;
  }

  /** Last sequence number assigned to an outbound encode* call (0 if none). */
  get lastEncodedSeq(): number {
    return this.#nextSeq - 1;
  }

  encodeOutput(payload: Uint8Array): Uint8Array {
    const frame: TerminalStreamFrame = {
      opcode: TerminalStreamOpcode.Output,
      streamId: this.streamId,
      seq: this.#nextSeq++,
      payload,
    };
    return encodeTerminalStreamFrame(frame);
  }

  encodeSubscribe(): Uint8Array {
    return encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Subscribe,
      streamId: this.streamId,
      seq: this.#nextSeq++,
      payload: new Uint8Array(0),
    });
  }

  /**
   * Decode an inbound frame; update lastReceivedSeq when seq is monotonic.
   * Returns null for malformed frames.
   */
  receive(bytes: Uint8Array): TerminalStreamFrame | null {
    try {
      const frame = decodeTerminalStreamFrame(bytes);
      if (!frame) return null;
      if (frame.streamId !== this.streamId) return null;
      if (frame.seq > this.#lastRxSeq) this.#lastRxSeq = frame.seq;
      return frame;
    } catch {
      return null;
    }
  }

  /** Resume cursor for reconnect: peer should resend after lastReceivedSeq. */
  resumeFromSeq(): number {
    return this.#lastRxSeq;
  }
}
