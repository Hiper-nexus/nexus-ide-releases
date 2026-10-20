import { describe, expect, it } from 'vitest';
import { concat, decodeWav, durationSec, encodeWav, resample, trim, type Pcm16 } from './wav-pcm';

function tone(sampleRate: number, seconds: number, value = 1000): Pcm16 {
  return { sampleRate, samples: new Int16Array(Math.round(sampleRate * seconds)).fill(value) };
}

function stereoWav(sampleRate: number, frames: Array<[number, number]>): Buffer {
  const data = Buffer.alloc(frames.length * 4);
  frames.forEach(([left, right], index) => {
    data.writeInt16LE(left, index * 4);
    data.writeInt16LE(right, index * 4 + 2);
  });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('wav-pcm', () => {
  it('encodes and decodes mono PCM16 without loss', () => {
    const pcm: Pcm16 = { sampleRate: 24_000, samples: Int16Array.from([0, 1, -1, 32767, -32768, 1234]) };
    const back = decodeWav(encodeWav(pcm));
    expect(back.sampleRate).toBe(24_000);
    expect(Array.from(back.samples)).toEqual(Array.from(pcm.samples));
  });

  it('mixes stereo down to mono', () => {
    const back = decodeWav(stereoWav(16_000, [[100, 300], [-200, 200]]));
    expect(Array.from(back.samples)).toEqual([200, 0]);
  });

  it('skips unknown chunks before data', () => {
    const plain = encodeWav({ sampleRate: 8_000, samples: Int16Array.from([5, 6]) });
    const list = Buffer.alloc(8 + 4);
    list.write('LIST', 0, 'latin1');
    list.writeUInt32LE(4, 4);
    list.write('INFO', 8, 'latin1');
    const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
    expect(Array.from(decodeWav(withList).samples)).toEqual([5, 6]);
  });

  it('refuses what is not PCM16 WAV', () => {
    expect(() => decodeWav(Buffer.from('not a wav file at all, definitely not one'.padEnd(64, '.')))).toThrow(/não é WAV/);
    const float = encodeWav(tone(8_000, 0.01));
    float.writeUInt16LE(3, 20);
    expect(() => decodeWav(float)).toThrow(/PCM 16 bits/);
  });

  it('resamples, trims and measures duration', () => {
    const half = resample(tone(48_000, 1), 24_000);
    expect(half.sampleRate).toBe(24_000);
    expect(half.samples.length).toBe(24_000);
    expect(durationSec(half)).toBe(1);
    expect(durationSec(trim(half, 0.5))).toBe(0.5);
    expect(trim(half, 5)).toBe(half);
  });

  it('joins clips with silence between them and reports where each starts', () => {
    const joined = concat([tone(24_000, 1), tone(48_000, 0.5)], 250);
    expect(joined.pcm.sampleRate).toBe(24_000);
    expect(joined.startsMs).toEqual([0, 1250]);
    expect(durationSec(joined.pcm)).toBeCloseTo(1.75, 3);
    expect(joined.pcm.samples[24_000 + 10]).toBe(0);
    expect(() => concat([])).toThrow();
  });
});
