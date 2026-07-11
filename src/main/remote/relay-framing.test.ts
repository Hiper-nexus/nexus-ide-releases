import { describe, expect, it } from 'vitest';
import {
  decodeRelayFrame,
  encodeRelayFrame,
  MAX_RELAY_FRAME_BYTES,
} from './relay-framing';

describe('relay-framing', () => {
  it('round-trips length-prefixed frames', () => {
    const payload = new TextEncoder().encode('ping');
    const wire = encodeRelayFrame(payload);
    const decoded = decodeRelayFrame(wire);
    expect(new TextDecoder().decode(decoded!.frame)).toBe('ping');
    expect(decoded!.rest.length).toBe(0);
  });

  it('returns null (not throw) while a frame is still incomplete', () => {
    const wire = encodeRelayFrame(new TextEncoder().encode('hello'));
    expect(decodeRelayFrame(wire.subarray(0, 6))).toBeNull();
  });

  it('rejects an oversized announced length instead of buffering unboundedly', () => {
    // Craft a header announcing MAX+1 bytes; the reader must throw, not wait.
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_RELAY_FRAME_BYTES + 1, false);
    expect(() => decodeRelayFrame(header)).toThrow(/exceeds/);
  });
});
