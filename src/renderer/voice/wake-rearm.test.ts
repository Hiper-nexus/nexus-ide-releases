import { describe, expect, it } from 'vitest';

import { REARM_SLOW_MS, RESTART_BACKOFF_MS, nextRearmDelay } from './wake-rearm';

/**
 * Política de rearme do mic do wake: backoff rápido (1s/3s/8s) e depois rearme
 * lento INFINITO. A mudança-chave do "morreu sozinha": hoje, esgotado o
 * backoff rápido, o mic fica morto até toggle manual. Agora ele nunca desiste
 * — cai num rearme a cada 30s até o dispositivo voltar.
 */
describe('wake-rearm nextRearmDelay', () => {
  it('usa o backoff rápido nas primeiras tentativas', () => {
    expect(nextRearmDelay(0)).toBe(RESTART_BACKOFF_MS[0]);
    expect(nextRearmDelay(1)).toBe(RESTART_BACKOFF_MS[1]);
    expect(nextRearmDelay(2)).toBe(RESTART_BACKOFF_MS[2]);
  });

  it('transiciona para o rearme lento após o backoff rápido', () => {
    expect(nextRearmDelay(RESTART_BACKOFF_MS.length)).toBe(REARM_SLOW_MS);
  });

  it('nunca desiste: tenta o rearme lento indefinidamente', () => {
    expect(nextRearmDelay(50)).toBe(REARM_SLOW_MS);
    expect(nextRearmDelay(1_000)).toBe(REARM_SLOW_MS);
  });
});
