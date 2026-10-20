/**
 * Minimal RIFF/WAVE reader (F-1593): format and duration of a PCM recording
 * the renderer sends for voice cloning. Pure. Anything but uncompressed PCM
 * is refused, so a renamed file or a truncated upload never reaches the
 * provider.
 */

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly durationSec: number;
  readonly dataBytes: number;
}

export function readWavInfo(bytes: Uint8Array): WavInfo {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.length < 44 ||
    buffer.toString('latin1', 0, 4) !== 'RIFF' ||
    buffer.toString('latin1', 8, 12) !== 'WAVE'
  ) {
    throw new Error('gravação não é WAV');
  }
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataBytes = -1;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataBytes = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || dataBytes < 0) throw new Error('WAV sem cabeçalho de formato ou sem áudio');
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error('WAV precisa ser PCM de 16 bits');
  }
  if (format.channels < 1 || format.channels > 2) throw new Error('WAV precisa ser mono ou estéreo');
  if (format.sampleRate < 16_000 || format.sampleRate > 96_000) {
    throw new Error('taxa de amostragem fora de 16 a 96 kHz');
  }
  const bytesPerSecond = format.sampleRate * format.channels * 2;
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    durationSec: dataBytes / bytesPerSecond,
    dataBytes,
  };
}
