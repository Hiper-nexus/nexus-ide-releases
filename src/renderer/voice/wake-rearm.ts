/**
 * Política de rearme do stream do mic do wake word. Módulo PURO (sem deps de
 * áudio nem `?url`) para ser testável isoladamente no vitest.
 *
 * Antes: o backoff era só `[1s, 3s, 8s]` e, esgotado, o mic ficava MORTO até
 * toggle manual — o "morreu sozinha" em estado terminal. Agora: esgotado o
 * backoff rápido, dispara onDied (HUD avisa) E entra num rearme lento INFINITO
 * a cada 30s, até o dispositivo de áudio voltar. O mic nunca mais fica morto
 * por opção própria.
 */
export const RESTART_BACKOFF_MS = [1_000, 3_000, 8_000] as const;
export const REARM_SLOW_MS = 30_000;

/**
 * Próximo delay de rearme (ms) após a tentativa `attempt` (0-indexed).
 * - tentativas 0..N-1: backoff rápido (RESTART_BACKOFF_MS);
 * - a partir dali: rearme lento fixo (REARM_SLOW_MS), para sempre.
 */
export function nextRearmDelay(attempt: number): number {
  return attempt < RESTART_BACKOFF_MS.length ? RESTART_BACKOFF_MS[attempt] : REARM_SLOW_MS;
}
