/**
 * Matemática PURA da janela de supressão de wake e do gate de reabertura do
 * mic pós-TTS. Extraída para ser testável e para MATAR o auto-diálogo: a
 * supressão precisa cobrir a duração REAL da fala (não um valor fixo curto que
 * lapsava no meio de uma resposta de ~20s, deixando o "Hey Jarvis" auto-disparar
 * na própria voz), e a reabertura do reply só pode acontecer depois que o
 * playback drenou + uma margem de cauda acústica (com AEC desligado o alto-
 * falante volta cru pro mic).
 */

/** Cauda acústica após o áudio digital drenar (reverberação/decay da sala). */
export const TTS_TAIL_GUARD_MS = 1_200;
/** Guarda drain→reabertura do mic no reply (substitui o flat 700ms). */
export const REPLY_REOPEN_TAIL_MS = 1_200;
/** Piso: mesmo uma fala curta segura o wake por isto (cold TTS + rede). */
export const MIN_WAKE_SUPPRESSION_MS = 4_500;
/** Teto: cobre uma resposta longa inteira (deadline do TTS ~40s) sem deixar o
 *  wake mudo para sempre se a medição de duração falhar. */
export const MAX_WAKE_SUPPRESSION_MS = 45_000;
/** Estimativa de fala por caractere (system-`say`: o renderer não tem o buffer
 *  de áudio para medir a duração real, então estima do tamanho do texto). */
export const MS_PER_SPOKEN_CHAR = 70;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Janela de supressão de wake para a duração REAL do playback + cauda. Um
 * playback de 23s suprime ~23s+cauda em vez de um teto curto — é o que impedia
 * o wake.detected de disparar no meio da resposta (auto-diálogo).
 */
export function playbackWakeSuppressionMs(
  playbackMs: number,
  tailMs: number = TTS_TAIL_GUARD_MS,
): number {
  const safe = Number.isFinite(playbackMs) && playbackMs > 0 ? playbackMs : 0;
  return clamp(
    Math.ceil(safe) + tailMs,
    MIN_WAKE_SUPPRESSION_MS,
    MAX_WAKE_SUPPRESSION_MS,
  );
}

/** Duração (ms) de um chunk PCM16 mono: bytes/2 amostras ÷ sampleRate. */
export function pcm16DurationMs(byteLength: number, sampleRate: number): number {
  if (byteLength <= 0 || sampleRate <= 0) return 0;
  const samples = Math.floor(byteLength / 2);
  return (samples / sampleRate) * 1_000;
}

/**
 * Supressão para UM chunk de áudio realtime: duração do chunk + cauda. Cada
 * chunk que chega re-estende a janela, então o streaming contínuo nunca deixa
 * uma brecha para o wake auto-disparar (substitui o fixo de 1200ms).
 */
export function realtimeChunkSuppressionMs(
  chunkMs: number,
  tailMs: number = TTS_TAIL_GUARD_MS,
): number {
  const safe = Number.isFinite(chunkMs) && chunkMs > 0 ? chunkMs : 0;
  return Math.ceil(safe) + tailMs;
}

/** Guarda pós-drain antes do mic do reply reabrir (a fala NUNCA volta no mic). */
export function replyReopenDelayMs(tailMs: number = REPLY_REOPEN_TAIL_MS): number {
  return tailMs;
}

/** Duração estimada da fala do texto (system-`say`, sem buffer de áudio). */
export function estimatedSpeechMs(charCount: number): number {
  const safe = Number.isFinite(charCount) && charCount > 0 ? charCount : 0;
  return safe * MS_PER_SPOKEN_CHAR;
}
