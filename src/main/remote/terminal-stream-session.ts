// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: production session
// wrapper around shared terminal-stream-protocol with seq/reconnect resume.
// Resynced 2026-09-11: no code changed — this wrapper only uses the
// Output/Resized/Subscribe opcodes and the frame shape, neither touched by
// the JSON size/structure limits or new opcodes added to the protocol module.

import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from '../../shared/terminal-stream-protocol';
import {
  resolveTerminalResume,
  type TerminalResumeResult,
} from './ssh/remote-reconnect';

export type TerminalStreamSessionOptions = {
  readonly streamId: number;
  readonly initialSeq?: number;
  readonly maxBufferedFrames?: number;
  readonly maxBufferedBytes?: number;
};

const DEFAULT_MAX_BUFFERED_FRAMES = 256;
const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

/**
 * Production-facing stream session: encodes/decodes frames and tracks the last
 * acknowledged sequence for reconnect/resume.
 */
export class TerminalStreamSession {
  readonly streamId: number;
  #nextSeq: number;
  #lastRxSeq: number;
  readonly #maxBufferedFrames: number;
  readonly #maxBufferedBytes: number;
  readonly #buffered = new Map<number, Uint8Array>();
  #bufferedBytes = 0;

  constructor(options: TerminalStreamSessionOptions) {
    this.streamId = options.streamId;
    this.#nextSeq = options.initialSeq ?? 1;
    this.#lastRxSeq = 0;
    this.#maxBufferedFrames = positiveInteger(
      options.maxBufferedFrames,
      DEFAULT_MAX_BUFFERED_FRAMES,
      'maxBufferedFrames',
    );
    this.#maxBufferedBytes = positiveInteger(
      options.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
      'maxBufferedBytes',
    );
  }

  get lastReceivedSeq(): number {
    return this.#lastRxSeq;
  }

  /** Last sequence number assigned to an outbound encode* call (0 if none). */
  get lastEncodedSeq(): number {
    return this.#nextSeq - 1;
  }

  encodeOutput(payload: Uint8Array): Uint8Array {
    return this.#encodeBuffered(TerminalStreamOpcode.Output, payload);
  }

  encodeResized(payload: Uint8Array): Uint8Array {
    return this.#encodeBuffered(TerminalStreamOpcode.Resized, payload);
  }

  encodeSubscribe(): Uint8Array {
    return this.#encodeBuffered(
      TerminalStreamOpcode.Subscribe,
      new Uint8Array(0),
    );
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
      if (frame.seq <= this.#lastRxSeq) return null;
      this.#lastRxSeq = frame.seq;
      return frame;
    } catch {
      return null;
    }
  }

  /** Resume cursor for reconnect: peer should resend after lastReceivedSeq. */
  resumeFromSeq(): number {
    return this.#lastRxSeq;
  }

  /**
   * Replay every frame after a peer's contiguous cursor, or explicitly require
   * a snapshot when count/byte eviction or a gap makes lossless replay
   * impossible.
   */
  resumeAfter(clientLastSeq: number): TerminalResumeResult {
    const result = resolveTerminalResume(
      this.#buffered,
      clientLastSeq,
      this.lastEncodedSeq,
    );
    if (result.snapshotRequired) return result;
    return {
      ...result,
      frames: result.frames.map((frame) => frame.slice()),
    };
  }

  #encodeBuffered(
    opcode: TerminalStreamOpcode,
    payload: Uint8Array,
  ): Uint8Array {
    const seq = this.#nextSeq++;
    const frame: TerminalStreamFrame = {
      opcode,
      streamId: this.streamId,
      seq,
      payload,
    };
    const encoded = encodeTerminalStreamFrame(frame);
    const retained = encoded.slice();
    this.#buffered.set(seq, retained);
    this.#bufferedBytes += retained.byteLength;
    this.#evictOverflow();
    return encoded;
  }

  #evictOverflow(): void {
    while (
      this.#buffered.size > this.#maxBufferedFrames
      || this.#bufferedBytes > this.#maxBufferedBytes
    ) {
      const oldest = this.#buffered.entries().next().value as
        | [number, Uint8Array]
        | undefined;
      if (!oldest) break;
      this.#buffered.delete(oldest[0]);
      this.#bufferedBytes -= oldest[1].byteLength;
    }
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1 || Math.floor(value) !== value) {
    throw new Error(`terminal-stream-session: ${label} must be a positive integer`);
  }
  return value;
}
