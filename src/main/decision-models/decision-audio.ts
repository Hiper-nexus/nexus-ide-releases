import type { DecisionAudio } from '../../shared/decision-models';

/** Limites publicados para o Clef-omni: até 4 clipes, 8 MiB e 300 s cada, 16 MiB somados (áudio + vídeo). */
export const MAX_DECISION_AUDIO_CLIPS = 4;
export const MAX_DECISION_AUDIO_BYTES = 8 * 1024 * 1024;
export const MAX_DECISION_AUDIO_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_DECISION_AUDIO_SECONDS = 300;
const MAX_BASE64_CHARS = Math.ceil(MAX_DECISION_AUDIO_BYTES / 3) * 4;

/**
 * Duração pelo cabeçalho WAV (byteRate do `fmt ` e tamanho do `data`).
 * Cabeçalho ilegível = null: o clipe é recusado, nunca enviado por suposição.
 */
export function wavDurationSeconds(bytes: Buffer): number | null {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= bytes.length) byteRate = bytes.readUInt32LE(offset + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      // Gravadores em streaming deixam 0 ou 0xFFFFFFFF: vale o que de fato veio.
      const available = bytes.length - offset - 8;
      const dataBytes = size === 0 || size > available ? available : size;
      return dataBytes / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

function isMp3(bytes: Buffer): boolean {
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') return true;
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

/**
 * Assinatura real (RIFF/WAVE ou MP3), tamanho e duração. MP3 não tem duração
 * barata e confiável sem decodificar: o teto de 8 MiB é o limite efetivo.
 */
export function validateDecisionAudio(audio: unknown): audio is readonly DecisionAudio[] {
  if (!Array.isArray(audio) || audio.length === 0 || audio.length > MAX_DECISION_AUDIO_CLIPS) return false;
  let totalBytes = 0;
  for (const clip of audio) {
    if (!clip || typeof clip !== 'object' || typeof clip.base64 !== 'string') return false;
    if (clip.base64.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(clip.base64)) return false;
    const bytes = Buffer.from(clip.base64, 'base64');
    if (!bytes.length || bytes.length > MAX_DECISION_AUDIO_BYTES || bytes.toString('base64') !== clip.base64) return false;
    if (clip.content_type === 'audio/wav') {
      const seconds = wavDurationSeconds(bytes);
      if (seconds === null || !Number.isFinite(seconds) || seconds > MAX_DECISION_AUDIO_SECONDS) return false;
    } else if (clip.content_type !== 'audio/mpeg' || !isMp3(bytes)) return false;
    totalBytes += bytes.length;
    if (totalBytes > MAX_DECISION_AUDIO_TOTAL_BYTES) return false;
  }
  return true;
}

/** O Clef-omni recebe áudio como `data:audio/*`; URLs remotas não existem neste contrato. */
export function decisionAudioDataUrl(clip: DecisionAudio): string {
  return `data:${clip.content_type};base64,${clip.base64}`;
}
