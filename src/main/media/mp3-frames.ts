/**
 * MP3 frame reader for joining TTS chunks (F-1591). Pure.
 *
 * A long narration is synthesized in chunks. Concatenating the MP3 bytes is a
 * valid stream, but every chunk may carry an ID3 tag and a Xing/Info frame:
 * kept in the middle of the file they confuse players, and the Info frame of
 * the first chunk advertises the length of that chunk only. The time offset
 * of chunk N is the real playing time of chunks 0..N-1, which is frames x
 * samples-per-frame / sample rate, not the end of the last aligned character.
 */

export interface Mp3Audio {
  /** Audio frames only: no ID3v2/ID3v1 tag, no Xing/Info/VBRI frame. */
  readonly frames: Buffer;
  readonly frameCount: number;
  readonly sampleRate: number;
  readonly samplesPerFrame: number;
  readonly durationMs: number;
  /**
   * Silence before the first spoken sample once the Info frame is gone:
   * encoder delay from the LAME tag plus the 529-sample decoder delay. Zero
   * when the encoder did not say. Word times of the chunk start after it.
   */
  readonly leadingMs: number;
}

/** Fixed MP3 decoder delay (samples) that gapless players trim with the LAME delay. */
const DECODER_DELAY_SAMPLES = 529;

const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44_100, 48_000, 32_000], // MPEG-1
  2: [22_050, 24_000, 16_000], // MPEG-2
  0: [11_025, 12_000, 8_000], // MPEG-2.5
};

interface FrameHeader {
  readonly length: number;
  readonly sampleRate: number;
  readonly samplesPerFrame: number;
  readonly sideInfoBytes: number;
}

function readHeader(buffer: Buffer, offset: number): FrameHeader | null {
  if (offset + 4 > buffer.length) return null;
  const b1 = buffer[offset + 1];
  const b2 = buffer[offset + 2];
  const b3 = buffer[offset + 3];
  if (buffer[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  if (version === 1 || layer !== 1) return null; // reserved version; Layer III only
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
  const padding = (b2 >> 1) & 0x01;
  const mono = ((b3 >> 6) & 0x03) === 3;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3)[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  const length = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  if (length < 4) return null;
  return {
    length,
    sampleRate,
    samplesPerFrame: mpeg1 ? 1152 : 576,
    sideInfoBytes: mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17,
  };
}

function id3v2Size(buffer: Buffer, offset: number): number {
  if (buffer.toString('latin1', offset, offset + 3) !== 'ID3' || offset + 10 > buffer.length) return 0;
  const size =
    ((buffer[offset + 6] & 0x7f) << 21) |
    ((buffer[offset + 7] & 0x7f) << 14) |
    ((buffer[offset + 8] & 0x7f) << 7) |
    (buffer[offset + 9] & 0x7f);
  const footer = (buffer[offset + 5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

function isInfoFrame(buffer: Buffer, offset: number, header: FrameHeader): boolean {
  const tagAt = offset + 4 + header.sideInfoBytes;
  const tag = buffer.toString('latin1', tagAt, tagAt + 4);
  if (tag === 'Xing' || tag === 'Info') return true;
  return buffer.toString('latin1', offset + 36, offset + 40) === 'VBRI';
}

/** Encoder delay (samples) from the LAME extension of a Xing/Info frame, or 0. */
function lameEncoderDelay(buffer: Buffer, offset: number, header: FrameHeader): number {
  const tagAt = offset + 4 + header.sideInfoBytes;
  const tag = buffer.toString('latin1', tagAt, tagAt + 4);
  if (tag !== 'Xing' && tag !== 'Info') return 0;
  const flags = buffer.readUInt32BE(tagAt + 4);
  let lameAt = tagAt + 8;
  if (flags & 0x1) lameAt += 4; // frames
  if (flags & 0x2) lameAt += 4; // bytes
  if (flags & 0x4) lameAt += 100; // TOC
  if (flags & 0x8) lameAt += 4; // quality
  const frameEnd = offset + header.length;
  if (lameAt + 24 > frameEnd) return 0;
  const encoder = buffer.toString('latin1', lameAt, lameAt + 4);
  if (encoder !== 'LAME' && encoder !== 'Lavc' && encoder !== 'Lavf') return 0;
  return (buffer[lameAt + 21] << 4) | (buffer[lameAt + 22] >> 4);
}

/**
 * Parse an MP3 file into its audio frames. Throws when no frame is found or
 * the stream changes sample rate (a chunk the joiner cannot place in time).
 */
export function parseMp3(buffer: Buffer): Mp3Audio {
  const frames: Buffer[] = [];
  let sampleRate = 0;
  let samplesPerFrame = 0;
  let offset = 0;
  let firstFrame = true;
  let leadingSamples = 0;
  // Trailing ID3v1 ("TAG", 128 bytes) is never audio.
  const end =
    buffer.length >= 128 && buffer.toString('latin1', buffer.length - 128, buffer.length - 125) === 'TAG'
      ? buffer.length - 128
      : buffer.length;
  while (offset < end) {
    const tag = id3v2Size(buffer, offset);
    if (tag > 0) {
      offset += tag;
      continue;
    }
    const header = readHeader(buffer, offset);
    if (!header || offset + header.length > end) {
      offset += 1; // resync on garbage between frames
      continue;
    }
    // A false sync inside data is rejected when the next frame does not follow.
    const next = offset + header.length;
    if (next < end && !readHeader(buffer, next) && id3v2Size(buffer, next) === 0) {
      offset += 1;
      continue;
    }
    if (sampleRate && header.sampleRate !== sampleRate) {
      throw new Error('mp3 com taxa de amostragem variável no meio do arquivo');
    }
    if (firstFrame && isInfoFrame(buffer, offset, header)) {
      const delay = lameEncoderDelay(buffer, offset, header);
      if (delay > 0) leadingSamples = delay + DECODER_DELAY_SAMPLES;
    } else {
      frames.push(buffer.subarray(offset, next));
      sampleRate = header.sampleRate;
      samplesPerFrame = header.samplesPerFrame;
    }
    firstFrame = false;
    offset = next;
  }
  if (frames.length === 0) throw new Error('mp3 sem quadros de áudio');
  return {
    frames: Buffer.concat(frames),
    frameCount: frames.length,
    sampleRate,
    samplesPerFrame,
    durationMs: Math.round((frames.length * samplesPerFrame * 1000) / sampleRate),
    leadingMs: Math.round((leadingSamples * 1000) / sampleRate),
  };
}

/**
 * Join parsed chunks; all of them must share the sample rate. The joined
 * `leadingMs` is the first chunk's; the start of every chunk is in `startsMs`.
 */
export function joinMp3(
  chunks: readonly Mp3Audio[],
): Mp3Audio & { readonly startsMs: readonly number[] } {
  if (chunks.length === 0) throw new Error('nenhum trecho de áudio para juntar');
  const { sampleRate, samplesPerFrame } = chunks[0];
  if (chunks.some((chunk) => chunk.sampleRate !== sampleRate)) {
    throw new Error('trechos de narração com taxas de amostragem diferentes');
  }
  const startsMs: number[] = [];
  let framesBefore = 0;
  for (const chunk of chunks) {
    startsMs.push(Math.round((framesBefore * samplesPerFrame * 1000) / sampleRate));
    framesBefore += chunk.frameCount;
  }
  return {
    frames: Buffer.concat(chunks.map((chunk) => chunk.frames)),
    frameCount: framesBefore,
    sampleRate,
    samplesPerFrame,
    durationMs: Math.round((framesBefore * samplesPerFrame * 1000) / sampleRate),
    leadingMs: chunks[0].leadingMs,
    startsMs,
  };
}
