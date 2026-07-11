import { AEC_FRAME_SAMPLES, AEC_PCM_SAMPLE_RATE } from './aec-runtime';

export const AEC_PROTOCOL_MAGIC = 0x4e584145; // "NXAE"
export const AEC_PROTOCOL_VERSION = 1;
export const AEC_MAX_PAYLOAD_BYTES = 64 * 1024;
const HEADER_BYTES = 12;

export type AecFrameType =
  | 1 // hello JSON
  | 2 // hello-ack JSON
  | 3 // capture PCM16
  | 4 // render/far-end PCM16
  | 5 // processed PCM16
  | 6 // metrics JSON
  | 7 // error JSON
  | 8; // shutdown

export interface AecProtocolFrame {
  type: AecFrameType;
  payload: Buffer;
}

export interface AecHello {
  protocolVersion: number;
  backend: string;
  sampleRate: number;
  frameSamples: number;
}

export function encodeAecFrame(frame: AecProtocolFrame): Buffer {
  if (frame.payload.byteLength > AEC_MAX_PAYLOAD_BYTES) {
    throw new Error('AEC protocol payload exceeds limit');
  }
  const out = Buffer.allocUnsafe(HEADER_BYTES + frame.payload.byteLength);
  out.writeUInt32BE(AEC_PROTOCOL_MAGIC, 0);
  out.writeUInt16BE(AEC_PROTOCOL_VERSION, 4);
  out.writeUInt16BE(frame.type, 6);
  out.writeUInt32BE(frame.payload.byteLength, 8);
  frame.payload.copy(out, HEADER_BYTES);
  return out;
}

/** Streaming decoder. Keeps incomplete tails and rejects corrupt/unbounded
 * frames before allocating based on attacker-controlled lengths. */
export class AecProtocolDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): AecProtocolFrame[] {
    this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    const frames: AecProtocolFrame[] = [];
    while (this.pending.length >= HEADER_BYTES) {
      if (this.pending.readUInt32BE(0) !== AEC_PROTOCOL_MAGIC) {
        this.pending = Buffer.alloc(0);
        throw new Error('AEC protocol magic mismatch');
      }
      const version = this.pending.readUInt16BE(4);
      if (version !== AEC_PROTOCOL_VERSION) {
        this.pending = Buffer.alloc(0);
        throw new Error(`AEC protocol version mismatch: ${version}`);
      }
      const type = this.pending.readUInt16BE(6);
      if (type < 1 || type > 8) throw new Error(`AEC protocol frame type invalid: ${type}`);
      const length = this.pending.readUInt32BE(8);
      if (length > AEC_MAX_PAYLOAD_BYTES) {
        this.pending = Buffer.alloc(0);
        throw new Error('AEC protocol payload exceeds limit');
      }
      const total = HEADER_BYTES + length;
      if (this.pending.length < total) break;
      frames.push({
        type: type as AecFrameType,
        payload: Buffer.from(this.pending.subarray(HEADER_BYTES, total)),
      });
      this.pending = this.pending.subarray(total);
    }
    return frames;
  }
}

export function createAecHello(backend: string): AecHello {
  return {
    protocolVersion: AEC_PROTOCOL_VERSION,
    backend,
    sampleRate: AEC_PCM_SAMPLE_RATE,
    frameSamples: AEC_FRAME_SAMPLES,
  };
}

export function pcm16Payload(samples: Int16Array): Buffer {
  if (samples.length !== AEC_FRAME_SAMPLES) {
    throw new Error(`AEC PCM frame must contain ${AEC_FRAME_SAMPLES} samples`);
  }
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}
