import { describe, expect, it } from 'vitest';
import { decodeRelayFrame, encodeRelayFrame } from './relay-framing';

describe('relay-framing', () => {
  it('round-trips length-prefixed frames', () => {
    const payload = new TextEncoder().encode('ping');
    const wire = encodeRelayFrame(payload);
    const decoded = decodeRelayFrame(wire);
    expect(new TextDecoder().decode(decoded!.frame)).toBe('ping');
    expect(decoded!.rest.length).toBe(0);
  });
});
