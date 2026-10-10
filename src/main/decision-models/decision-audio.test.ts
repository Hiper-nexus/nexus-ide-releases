import { describe, expect, it } from 'vitest';
import { decisionAudioDataUrl, validateDecisionAudio, wavDurationSeconds } from './decision-audio';
import { syntheticWav } from './decision-audio.fixture';

const wav = (seconds = 1) => ({ content_type: 'audio/wav' as const, base64: syntheticWav(seconds).toString('base64') });
const MP3_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x64]);

describe('decision audio limits', () => {
  it('accepts short WAV and MP3 clips and reads the WAV duration from its header', () => {
    expect(wavDurationSeconds(syntheticWav(1.5))).toBeCloseTo(1.5, 5);
    expect(validateDecisionAudio([wav()])).toBe(true);
    expect(validateDecisionAudio([{ content_type: 'audio/mpeg', base64: Buffer.concat([MP3_HEADER, Buffer.alloc(64)]).toString('base64') }])).toBe(true);
    expect(validateDecisionAudio([{ content_type: 'audio/mpeg', base64: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]).toString('base64') }])).toBe(true);
  });

  it('rejects mislabelled or forged signatures, remote URLs and empty lists', () => {
    expect(validateDecisionAudio([])).toBe(false);
    expect(validateDecisionAudio(['https://example.com/clip.wav'])).toBe(false);
    expect(validateDecisionAudio([{ ...wav(), content_type: 'audio/mpeg' }])).toBe(false);
    expect(validateDecisionAudio([{ content_type: 'audio/wav', base64: Buffer.concat([MP3_HEADER, Buffer.alloc(64)]).toString('base64') }])).toBe(false);
    expect(validateDecisionAudio([{ content_type: 'audio/ogg', base64: wav().base64 }])).toBe(false);
    expect(validateDecisionAudio([{ content_type: 'audio/wav', base64: 'not base64!' }])).toBe(false);
  });

  it('rejects more than four clips', () => {
    expect(validateDecisionAudio(Array.from({ length: 5 }, () => wav(0.1)))).toBe(false);
  });

  it('rejects a WAV longer than 300 seconds even when it fits in 8 MiB', () => {
    const sampleRate = 8_000; const long = syntheticWav(1);
    // 8 kHz mono 8-bit: 301 s cabem em ~2,4 MB.
    long.writeUInt32LE(sampleRate, 24); long.writeUInt32LE(sampleRate, 28);
    const data = Buffer.alloc(301 * sampleRate);
    const header = long.subarray(0, 44); header.writeUInt32LE(data.length, 40);
    expect(validateDecisionAudio([{ content_type: 'audio/wav', base64: Buffer.concat([header, data]).toString('base64') }])).toBe(false);
  });

  it('rejects a clip above 8 MiB and a total above 16 MiB', () => {
    const big = Buffer.concat([MP3_HEADER, Buffer.alloc(8 * 1024 * 1024)]);
    expect(validateDecisionAudio([{ content_type: 'audio/mpeg', base64: big.toString('base64') }])).toBe(false);
    const almost = Buffer.concat([MP3_HEADER, Buffer.alloc(6 * 1024 * 1024)]).toString('base64');
    expect(validateDecisionAudio([1, 2, 3].map(() => ({ content_type: 'audio/mpeg' as const, base64: almost })))).toBe(false);
  });

  it('serializes a clip as a data URL, never a remote reference', () => {
    expect(decisionAudioDataUrl({ content_type: 'audio/wav', base64: 'UklGRg==' })).toBe('data:audio/wav;base64,UklGRg==');
  });
});
