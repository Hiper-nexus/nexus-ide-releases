import { describe, expect, it } from 'vitest';
import { joinMp3, parseMp3 } from './mp3-frames';

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames (418 padded). */
function frame(fill = 0x11, padding = false): Buffer {
  const length = 417 + (padding ? 1 : 0);
  const bytes = Buffer.alloc(length, fill);
  bytes[0] = 0xff;
  bytes[1] = 0xfb; // MPEG-1, Layer III, no CRC
  bytes[2] = 0x90 | (padding ? 0x02 : 0); // 128 kbps, 44.1 kHz
  bytes[3] = 0x00; // stereo
  return bytes;
}

function infoFrame(): Buffer {
  const bytes = frame(0);
  bytes.write('Info', 4 + 32, 'latin1');
  return bytes;
}

function id3v2(size: number): Buffer {
  const header = Buffer.alloc(10 + size, 0x20);
  header.write('ID3', 0, 'latin1');
  header[3] = 4;
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  return header;
}

describe('parseMp3', () => {
  it('conta quadros e calcula a duração real', () => {
    const audio = parseMp3(Buffer.concat([frame(), frame(0x22, true), frame()]));
    expect(audio.frameCount).toBe(3);
    expect(audio.sampleRate).toBe(44_100);
    expect(audio.samplesPerFrame).toBe(1152);
    expect(audio.durationMs).toBe(Math.round((3 * 1152 * 1000) / 44_100));
    expect(audio.frames.length).toBe(417 * 2 + 418);
  });

  it('tira ID3v2, quadro Info e ID3v1 do áudio', () => {
    const tagV1 = Buffer.alloc(128, 0x20);
    tagV1.write('TAG', 0, 'latin1');
    const audio = parseMp3(Buffer.concat([id3v2(64), infoFrame(), frame(), frame(), tagV1]));
    expect(audio.frameCount).toBe(2);
    expect(audio.frames.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfb]));
    expect(audio.frames.length).toBe(417 * 2);
  });

  it('lê o atraso do codificador no cabeçalho LAME do quadro Info', () => {
    const info = infoFrame();
    const tagAt = 4 + 32;
    info.writeUInt32BE(0, tagAt + 4); // sem campos opcionais
    info.write('LAME3.100', tagAt + 8, 'latin1');
    // 12 bits de atraso (576) + 12 bits de preenchimento (0)
    info[tagAt + 8 + 21] = 576 >> 4;
    info[tagAt + 8 + 22] = (576 & 0x0f) << 4;
    const audio = parseMp3(Buffer.concat([info, frame()]));
    expect(audio.leadingMs).toBe(Math.round(((576 + 529) * 1000) / 44_100));
  });

  it('sem cabeçalho LAME, sem atraso conhecido', () => {
    expect(parseMp3(Buffer.concat([infoFrame(), frame()])).leadingMs).toBe(0);
  });

  it('ressincroniza depois de lixo entre quadros', () => {
    const audio = parseMp3(Buffer.concat([Buffer.from([1, 2, 3]), frame(), frame()]));
    expect(audio.frameCount).toBe(2);
  });

  it('arquivo sem quadro algum é erro', () => {
    expect(() => parseMp3(Buffer.from('não é mp3'))).toThrow(/sem quadros/);
  });
});

describe('joinMp3', () => {
  it('soma quadros e duração dos trechos', () => {
    const first = parseMp3(Buffer.concat([infoFrame(), frame(), frame()]));
    const second = parseMp3(Buffer.concat([infoFrame(), frame()]));
    const joined = joinMp3([first, second]);
    expect(joined.frameCount).toBe(3);
    expect(joined.durationMs).toBe(Math.round((3 * 1152 * 1000) / 44_100));
    expect(joined.startsMs).toEqual([0, Math.round((2 * 1152 * 1000) / 44_100)]);
    // O quadro Info de cada trecho saiu: o arquivo final é só áudio.
    expect(parseMp3(joined.frames).frameCount).toBe(3);
  });

  it('recusa trechos com taxas diferentes', () => {
    const a = parseMp3(frame());
    expect(() => joinMp3([a, { ...a, sampleRate: 48_000 }])).toThrow(/taxas/);
  });
});
