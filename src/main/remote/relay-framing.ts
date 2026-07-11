// Adapted from stablyai/orca relay-protocol framing concepts @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: minimal length-prefix
// frames for remote relay without full ORCA relay stack.

export function encodeRelayFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

export function decodeRelayFrame(
  buffer: Uint8Array,
): { frame: Uint8Array; rest: Uint8Array } | null {
  if (buffer.length < 4) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const len = view.getUint32(0, false);
  if (buffer.length < 4 + len) return null;
  return {
    frame: buffer.subarray(4, 4 + len),
    rest: buffer.subarray(4 + len),
  };
}
