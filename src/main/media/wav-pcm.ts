/**
 * PCM16 WAV helpers for the Gemini voice path (F-1601): the replication API
 * recommends 24 kHz mono 16-bit, the TTS answers 24 kHz mono 16-bit WAV per
 * request, and a narration is several requests joined. Pure Buffer work.
 */

export interface Pcm16 {
  readonly sampleRate: number;
  /** Mono samples, -32768..32767. */
  readonly samples: Int16Array;
}

function chunkAt(buffer: Buffer, id: string): { offset: number; size: number } | null {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const name = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (name === id) return { offset: offset + 8, size: Math.min(size, buffer.length - offset - 8) };
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** PCM16 WAV (mono or stereo, any rate) → mono samples. */
export function decodeWav(bytes: Uint8Array): Pcm16 {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 44 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('áudio não é WAV');
  }
  const fmt = chunkAt(buffer, 'fmt ');
  const data = chunkAt(buffer, 'data');
  if (!fmt || !data) throw new Error('WAV sem formato ou sem dados');
  const audioFormat = buffer.readUInt16LE(fmt.offset);
  const channels = buffer.readUInt16LE(fmt.offset + 2);
  const sampleRate = buffer.readUInt32LE(fmt.offset + 4);
  const bits = buffer.readUInt16LE(fmt.offset + 14);
  if (audioFormat !== 1 || bits !== 16 || channels < 1 || channels > 2 || sampleRate < 8_000) {
    throw new Error('WAV precisa ser PCM 16 bits, mono ou estéreo');
  }
  const frames = Math.floor(data.size / (2 * channels));
  const samples = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const base = data.offset + frame * 2 * channels;
    samples[frame] =
      channels === 1 ? buffer.readInt16LE(base) : Math.round((buffer.readInt16LE(base) + buffer.readInt16LE(base + 2)) / 2);
  }
  return { sampleRate, samples };
}

export function encodeWav(pcm: Pcm16): Buffer {
  const data = Buffer.alloc(pcm.samples.length * 2);
  for (let index = 0; index < pcm.samples.length; index += 1) data.writeInt16LE(pcm.samples[index], index * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(pcm.sampleRate, 24);
  header.writeUInt32LE(pcm.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Linear resampling: enough for a voice sample going to a speech model. */
export function resample(pcm: Pcm16, targetRate: number): Pcm16 {
  if (pcm.sampleRate === targetRate) return pcm;
  const ratio = pcm.sampleRate / targetRate;
  const length = Math.floor(pcm.samples.length / ratio);
  const out = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(pcm.samples.length - 1, left + 1);
    const fraction = position - left;
    out[index] = Math.round(pcm.samples[left] * (1 - fraction) + pcm.samples[right] * fraction);
  }
  return { sampleRate: targetRate, samples: out };
}

export function durationSec(pcm: Pcm16): number {
  return pcm.samples.length / pcm.sampleRate;
}

export function trim(pcm: Pcm16, maxSec: number): Pcm16 {
  const max = Math.floor(maxSec * pcm.sampleRate);
  return pcm.samples.length <= max ? pcm : { sampleRate: pcm.sampleRate, samples: pcm.samples.slice(0, max) };
}

/** Joins mono clips at one rate, with `gapMs` of silence between them; returns where each starts. */
export function concat(parts: readonly Pcm16[], gapMs = 0): { pcm: Pcm16; startsMs: number[] } {
  if (parts.length === 0) throw new Error('nada para juntar');
  const rate = parts[0].sampleRate;
  const gap = Math.round((gapMs / 1000) * rate);
  const normalized = parts.map((part) => resample(part, rate));
  const total = normalized.reduce((sum, part) => sum + part.samples.length, 0) + gap * (normalized.length - 1);
  const samples = new Int16Array(total);
  const startsMs: number[] = [];
  let cursor = 0;
  normalized.forEach((part, index) => {
    startsMs.push(Math.round((cursor / rate) * 1000));
    samples.set(part.samples, cursor);
    cursor += part.samples.length + (index < normalized.length - 1 ? gap : 0);
  });
  return { pcm: { sampleRate: rate, samples }, startsMs };
}
