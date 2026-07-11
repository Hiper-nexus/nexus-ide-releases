// Adapted from stablyai/orca relay-protocol framing concepts @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: minimal length-prefix
// frames for remote relay without full ORCA relay stack; bounded frame length
// so a malicious/buggy peer cannot force unbounded buffering.

/**
 * Hard upper bound on a single relay frame payload. A remote peer controls the
 * 32-bit length prefix; without a cap, the reader would accumulate up to ~4 GiB
 * waiting for `4 + len` bytes. 16 MiB is generous for terminal/relay traffic and
 * bounds the accumulation. Oversized frames are a protocol violation, not an
 * "incomplete buffer" condition, so they throw instead of returning null.
 */
export const MAX_RELAY_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeRelayFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_RELAY_FRAME_BYTES) {
    throw new Error(`relay frame payload exceeds ${MAX_RELAY_FRAME_BYTES} bytes`);
  }
  const out = new Uint8Array(4 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

/**
 * Returns the framed payload and the remaining bytes, or null when the buffer
 * does not yet hold a complete frame. Throws when the announced length exceeds
 * MAX_RELAY_FRAME_BYTES so the caller drops the peer instead of buffering
 * unboundedly toward an attacker-chosen length.
 */
export function decodeRelayFrame(
  buffer: Uint8Array,
): { frame: Uint8Array; rest: Uint8Array } | null {
  if (buffer.length < 4) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const len = view.getUint32(0, false);
  if (len > MAX_RELAY_FRAME_BYTES) {
    throw new Error(`relay frame length ${len} exceeds ${MAX_RELAY_FRAME_BYTES} bytes`);
  }
  if (buffer.length < 4 + len) return null;
  return {
    frame: buffer.subarray(4, 4 + len),
    rest: buffer.subarray(4 + len),
  };
}
