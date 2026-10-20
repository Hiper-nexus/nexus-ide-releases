import { describe, expect, it } from 'vitest';
import { mp4DurationSeconds } from './mp4-duration';

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function largeBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 'latin1');
  header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([header, payload]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const payload = Buffer.alloc(100);
  payload[0] = 0;
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return box('mvhd', payload);
}

function mvhdV1(timescale: number, duration: bigint): Buffer {
  const payload = Buffer.alloc(112);
  payload[0] = 1;
  payload.writeUInt32BE(timescale, 20);
  payload.writeBigUInt64BE(duration, 24);
  return box('mvhd', payload);
}

const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2mp41', 'latin1'));

describe('mp4DurationSeconds (F-1587)', () => {
  it('lê a duração do mvhd versão 0 (moov no início, faststart)', () => {
    const file = Buffer.concat([
      ftyp,
      box('moov', mvhdV0(1000, 8_042)),
      box('mdat', Buffer.alloc(64)),
    ]);
    expect(mp4DurationSeconds(file)).toBe(8.042);
  });

  it('acha o moov depois de um mdat grande com tamanho de 64 bits', () => {
    const file = Buffer.concat([
      ftyp,
      largeBox('mdat', Buffer.alloc(256)),
      box('moov', Buffer.concat([box('udta', Buffer.alloc(4)), mvhdV1(90_000, 900_000n)])),
    ]);
    expect(mp4DurationSeconds(file)).toBe(10);
  });

  it('sem mvhd legível é null, nunca um chute', () => {
    expect(mp4DurationSeconds(Buffer.from('veo-bytes'))).toBeNull();
    expect(mp4DurationSeconds(Buffer.concat([ftyp, box('mdat', Buffer.alloc(8))]))).toBeNull();
    expect(mp4DurationSeconds(Buffer.concat([ftyp, box('moov', mvhdV0(0, 10))]))).toBeNull();
    expect(mp4DurationSeconds(Buffer.concat([ftyp, box('moov', mvhdV0(600, 0xffffffff))]))).toBeNull();
    // Caixa que promete mais bytes do que o arquivo tem.
    const truncated = Buffer.concat([ftyp, box('moov', mvhdV0(1000, 5000))]).subarray(0, ftyp.length + 20);
    expect(mp4DurationSeconds(truncated)).toBeNull();
  });
});
