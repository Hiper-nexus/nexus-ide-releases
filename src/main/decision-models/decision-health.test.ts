import { describe, expect, it } from 'vitest';
import {
  BREAKER_INITIAL_COOLDOWN_MS, BREAKER_MAX_COOLDOWN_MS, BREAKER_WINDOW_MS,
  decisionFailureTripsBreaker, isDecisionProviderBlocked, recordDecisionProviderFailure,
  recordDecisionProviderSuccess, resetDecisionHealthForTesting,
} from './decision-health';

describe('disjuntor dos provedores de decisão', () => {
  it('abre após 3 falhas de rede seguidas e deixa uma sonda depois do cooldown', () => {
    resetDecisionHealthForTesting();
    recordDecisionProviderFailure('jev', 'timeout', 0);
    recordDecisionProviderFailure('jev', 'server-error', 1_000);
    expect(isDecisionProviderBlocked('jev', 1_000)).toBe(false);
    recordDecisionProviderFailure('jev', 'rate-limited', 2_000);
    expect(isDecisionProviderBlocked('jev', 2_000)).toBe(true);
    expect(isDecisionProviderBlocked('jev', 2_000 + BREAKER_INITIAL_COOLDOWN_MS - 1)).toBe(true);
    expect(isDecisionProviderBlocked('jev', 2_000 + BREAKER_INITIAL_COOLDOWN_MS)).toBe(false);
  });

  it('a janela de 2 min reinicia a sequência quando o intervalo passa do prazo', () => {
    resetDecisionHealthForTesting();
    recordDecisionProviderFailure('clef', 'network', 0);
    recordDecisionProviderFailure('clef', 'network', 60_000);
    recordDecisionProviderFailure('clef', 'network', 60_000 + BREAKER_WINDOW_MS + 1);
    expect(isDecisionProviderBlocked('clef', 60_000 + BREAKER_WINDOW_MS + 1)).toBe(false);
    recordDecisionProviderFailure('clef', 'network', 60_000 + BREAKER_WINDOW_MS + 2);
    expect(isDecisionProviderBlocked('clef', 60_000 + BREAKER_WINDOW_MS + 2)).toBe(false);
    // No limite exato a sequência continua: a terceira abre.
    resetDecisionHealthForTesting();
    recordDecisionProviderFailure('clef', 'timeout', 0);
    recordDecisionProviderFailure('clef', 'timeout', BREAKER_WINDOW_MS);
    recordDecisionProviderFailure('clef', 'timeout', BREAKER_WINDOW_MS + BREAKER_WINDOW_MS);
    expect(isDecisionProviderBlocked('clef', BREAKER_WINDOW_MS * 2)).toBe(true);
  });

  it('sucesso zera; abort, orçamento e erro de cliente não abrem e quebram a sequência', () => {
    resetDecisionHealthForTesting();
    expect(decisionFailureTripsBreaker('timeout')).toBe(true);
    expect(decisionFailureTripsBreaker('client-error')).toBe(false);
    expect(decisionFailureTripsBreaker('aborted')).toBe(false);
    expect(decisionFailureTripsBreaker('budget')).toBe(false);
    recordDecisionProviderFailure('luna', 'timeout', 0);
    recordDecisionProviderFailure('luna', 'timeout', 1);
    recordDecisionProviderSuccess('luna', 2);
    recordDecisionProviderFailure('luna', 'timeout', 3);
    recordDecisionProviderFailure('luna', 'timeout', 4);
    expect(isDecisionProviderBlocked('luna', 4)).toBe(false);
    recordDecisionProviderFailure('luna', 'client-error', 5);
    recordDecisionProviderFailure('luna', 'aborted', 6);
    recordDecisionProviderFailure('luna', 'budget', 7);
    recordDecisionProviderFailure('luna', 'timeout', 8);
    recordDecisionProviderFailure('luna', 'timeout', 9);
    expect(isDecisionProviderBlocked('luna', 9)).toBe(false);
  });

  it('erro de cliente no aberto não fecha; na sonda não reabre e a próxima abertura dobra só se a sonda falhar de verdade', () => {
    resetDecisionHealthForTesting();
    recordDecisionProviderFailure('jev', 'timeout', 0);
    recordDecisionProviderFailure('jev', 'timeout', 1);
    recordDecisionProviderFailure('jev', 'timeout', 2);
    const openedAt = 2;
    recordDecisionProviderFailure('jev', 'client-error', openedAt + 1);
    expect(isDecisionProviderBlocked('jev', openedAt + 1)).toBe(true);
    const probeAt = openedAt + BREAKER_INITIAL_COOLDOWN_MS;
    recordDecisionProviderFailure('jev', 'client-error', probeAt);
    expect(isDecisionProviderBlocked('jev', probeAt)).toBe(false);
    recordDecisionProviderFailure('jev', 'timeout', probeAt + 1);
    recordDecisionProviderFailure('jev', 'timeout', probeAt + 2);
    recordDecisionProviderFailure('jev', 'timeout', probeAt + 3);
    expect(isDecisionProviderBlocked('jev', probeAt + 3)).toBe(true);
    expect(isDecisionProviderBlocked('jev', probeAt + 3 + BREAKER_INITIAL_COOLDOWN_MS)).toBe(false);
    // Sonda que estoura dobra: 15 → 30 → 60, com teto de 5 min.
    const secondOpen = probeAt + 3;
    const failedProbe = secondOpen + BREAKER_INITIAL_COOLDOWN_MS;
    recordDecisionProviderFailure('jev', 'timeout', failedProbe);
    expect(isDecisionProviderBlocked('jev', failedProbe)).toBe(true);
    expect(isDecisionProviderBlocked('jev', failedProbe + BREAKER_INITIAL_COOLDOWN_MS * 2 - 1)).toBe(true);
    expect(isDecisionProviderBlocked('jev', failedProbe + BREAKER_INITIAL_COOLDOWN_MS * 2)).toBe(false);
    let at = failedProbe;
    let cooldown = BREAKER_INITIAL_COOLDOWN_MS * 2;
    for (let step = 0; step < 8; step++) {
      at += cooldown;
      recordDecisionProviderFailure('jev', 'timeout', at);
      cooldown = Math.min(cooldown * 2, BREAKER_MAX_COOLDOWN_MS);
      expect(isDecisionProviderBlocked('jev', at)).toBe(true);
      expect(isDecisionProviderBlocked('jev', at + cooldown)).toBe(false);
    }
    expect(cooldown).toBe(BREAKER_MAX_COOLDOWN_MS);
    recordDecisionProviderSuccess('jev', at + 1);
    recordDecisionProviderFailure('jev', 'timeout', at + 2);
    recordDecisionProviderFailure('jev', 'timeout', at + 3);
    recordDecisionProviderFailure('jev', 'timeout', at + 4);
    expect(isDecisionProviderBlocked('jev', at + 4 + BREAKER_INITIAL_COOLDOWN_MS)).toBe(false);
    expect(isDecisionProviderBlocked('jev', at + 4 + BREAKER_INITIAL_COOLDOWN_MS - 1)).toBe(true);
  });

  it('um provedor aberto não bloqueia os outros', () => {
    resetDecisionHealthForTesting();
    recordDecisionProviderFailure('clef', 'timeout', 10);
    recordDecisionProviderFailure('clef', 'timeout', 11);
    recordDecisionProviderFailure('clef', 'timeout', 12);
    expect(isDecisionProviderBlocked('clef', 12)).toBe(true);
    expect(isDecisionProviderBlocked('jev', 12)).toBe(false);
    expect(isDecisionProviderBlocked('luna', 12)).toBe(false);
  });
});
