// Vendored from can1357/oh-my-pi@03c48d073 packages/hashline (MIT)
// NexusIDE port note: upstream calls `Bun.hash.xxHash32(text, 0)`. NexusIDE
// runs on Node/Electron, so this file provides a spec-exact xxHash32
// implementation (https://github.com/Cyan4973/xxHash — XXH32) over the UTF-8
// bytes of the input, producing bit-identical values to Bun's native hash.

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

const UTF8_ENCODER = new TextEncoder();

function rotl32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function round(acc: number, lane: number): number {
  const added = (acc + Math.imul(lane, PRIME32_2)) >>> 0;
  return Math.imul(rotl32(added, 13), PRIME32_1) >>> 0;
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

/**
 * xxHash32 of `input` (strings are hashed as their UTF-8 bytes), returned as
 * an unsigned 32-bit integer. Matches `Bun.hash.xxHash32` and the reference
 * XXH32 implementation for every input and seed.
 */
export function xxHash32(input: string | Uint8Array, seed = 0): number {
  const data = typeof input === 'string' ? UTF8_ENCODER.encode(input) : input;
  const length = data.length;
  let offset = 0;
  let hash: number;

  if (length >= 16) {
    let v1 = (seed + PRIME32_1 + PRIME32_2) >>> 0;
    let v2 = (seed + PRIME32_2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - PRIME32_1) >>> 0;
    const stripeLimit = length - 16;
    while (offset <= stripeLimit) {
      v1 = round(v1, readU32LE(data, offset));
      v2 = round(v2, readU32LE(data, offset + 4));
      v3 = round(v3, readU32LE(data, offset + 8));
      v4 = round(v4, readU32LE(data, offset + 12));
      offset += 16;
    }
    hash = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
  } else {
    hash = (seed + PRIME32_5) >>> 0;
  }

  hash = (hash + length) >>> 0;

  while (offset + 4 <= length) {
    hash = (hash + Math.imul(readU32LE(data, offset), PRIME32_3)) >>> 0;
    hash = Math.imul(rotl32(hash, 17), PRIME32_4) >>> 0;
    offset += 4;
  }

  while (offset < length) {
    hash = (hash + Math.imul(data[offset], PRIME32_5)) >>> 0;
    hash = Math.imul(rotl32(hash, 11), PRIME32_1) >>> 0;
    offset += 1;
  }

  hash ^= hash >>> 15;
  hash = Math.imul(hash, PRIME32_2) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, PRIME32_3) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}
