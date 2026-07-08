/**
 * Endpointing (VAD) da captura de comando — módulo PURO (sem deps de áudio),
 * testável no vitest como wake-rearm/wake-health.
 *
 * Gap 6: antes a captura SEMPRE esperava o piso `minListenMs` (3,2s/1,5s) antes
 * que o silêncio pudesse encerrar — latência morta mesmo quando o usuário já
 * terminou um comando curto. Agora, se ele já falou um comando de VERDADE
 * (>= VAD_MIN_SPEECH_MS de fala real) e ficou em silêncio por `silenceMs`,
 * encerra JÁ, sem esperar o piso. O piso só protege o INÍCIO (antes de haver
 * fala suficiente — ack/pre-roll/hesitação), nunca a cauda de um comando pronto.
 */

/** Fala real mínima para encerrar antes do piso — evita cortar num blip curto. */
export const VAD_MIN_SPEECH_MS = 500;

export interface EndpointState {
  /** Já cruzou o piso de "ouviu fala" (heardSpeech). */
  heardSpeech: boolean;
  /** Total acumulado de fala real (ms). */
  speechMs: number;
  /** Silêncio contínuo desde a última fala (ms). */
  silentMs: number;
  /** Duração total da captura até agora (ms). */
  totalMs: number;
  /** Silêncio que encerra a fala (ms). */
  silenceMs: number;
  /** Piso mínimo antes de o silêncio poder encerrar (ms). */
  minListenMs: number;
  /** Teto duro da captura (ms). */
  maxMs: number;
  /** Override do mínimo de fala para o atalho VAD. */
  vadMinSpeechMs?: number;
}

/** True quando a captura de comando deve encerrar agora. */
export function shouldEndpointUtterance(s: EndpointState): boolean {
  // Teto duro: encerra independentemente de tudo.
  if (s.totalMs >= s.maxMs) return true;
  // Sem fala real ainda: nunca encerra por silêncio (janela de início aberta).
  if (!s.heardSpeech) return false;
  // Ainda não houve silêncio suficiente pós-fala.
  if (s.silentMs < s.silenceMs) return false;
  // Comando terminado: se já foi fala de verdade, encerra sem esperar o piso;
  // senão, respeita o piso mínimo (protege blips/hesitações no começo).
  const enoughSpeech = s.speechMs >= (s.vadMinSpeechMs ?? VAD_MIN_SPEECH_MS);
  return enoughSpeech || s.totalMs >= s.minListenMs;
}
