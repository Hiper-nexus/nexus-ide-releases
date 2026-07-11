import { describe, expect, it } from 'vitest';
import {
  AEC_PROTOCOL_VERSION,
  AecProtocolDecoder,
  createAecHello,
  encodeAecFrame,
  pcm16Payload,
} from './aec-protocol';

describe('AEC helper protocol', () => {
  it('decodes fragmented and coalesced frames without losing boundaries', () => {
    const one = encodeAecFrame({ type: 1, payload: Buffer.from('{"hello":1}') });
    const two = encodeAecFrame({ type: 6, payload: Buffer.from('{"erl":12}') });
    const wire = Buffer.concat([one, two]);
    const decoder = new AecProtocolDecoder();
    expect(decoder.push(wire.subarray(0, 7))).toEqual([]);
    const frames = decoder.push(wire.subarray(7));
    expect(frames.map((frame) => frame.type)).toEqual([1, 6]);
    expect(frames[1]?.payload.toString()).toContain('erl');
  });

  it('rejects corrupt magic and oversized payloads', () => {
    const decoder = new AecProtocolDecoder();
    expect(() => decoder.push(Buffer.alloc(12))).toThrow(/magic mismatch/);
    expect(() => encodeAecFrame({ type: 1, payload: Buffer.alloc(65 * 1024) }))
      .toThrow(/exceeds limit/);
  });

  it('pins helper handshake and PCM geometry', () => {
    expect(createAecHello('wasapi-loopback')).toEqual({
      protocolVersion: AEC_PROTOCOL_VERSION,
      backend: 'wasapi-loopback',
      sampleRate: 16_000,
      frameSamples: 160,
    });
    expect(pcm16Payload(new Int16Array(160))).toHaveLength(320);
    expect(() => pcm16Payload(new Int16Array(159))).toThrow(/160 samples/);
  });
});
