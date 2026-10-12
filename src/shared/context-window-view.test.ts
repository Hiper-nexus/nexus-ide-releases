import { describe, expect, it } from 'vitest';
import {
  EMPTY_CONTEXT_WINDOW,
  contextWindowFillRatio,
  contextWindowUrgency,
  deriveContextWindowSnapshot,
  formatContextWindowLabel,
} from './context-window-view';

describe('deriveContextWindowSnapshot', () => {
  it('sem leitura devolve o snapshot vazio (nunca 0 confiante)', () => {
    expect(deriveContextWindowSnapshot({})).toEqual(EMPTY_CONTEXT_WINDOW);
    expect(
      deriveContextWindowSnapshot({ usedTokens: null, maxTokens: null }),
    ).toEqual(EMPTY_CONTEXT_WINDOW);
  });

  it('calcula restante e porcentagem quando os dois lados existem', () => {
    const snap = deriveContextWindowSnapshot({
      usedTokens: 50_000,
      maxTokens: 200_000,
      updatedAt: '2026-10-12T00:00:00Z',
    });
    expect(snap.usedPercentage).toBe(25);
    expect(snap.remainingPercentage).toBe(75);
    expect(snap.remainingTokens).toBe(150_000);
    expect(snap.updatedAt).toBe('2026-10-12T00:00:00Z');
  });

  it('clamp porcentagem em 0..100 e nunca restante negativo', () => {
    const over = deriveContextWindowSnapshot({
      usedTokens: 250_000,
      maxTokens: 200_000,
    });
    expect(over.usedPercentage).toBe(100);
    expect(over.remainingTokens).toBe(0);
    expect(over.remainingPercentage).toBe(0);
  });

  it('só max (capacidade do modelo) sem used: sem porcentagem inventada', () => {
    const snap = deriveContextWindowSnapshot({ maxTokens: 200_000 });
    expect(snap.usedTokens).toBeNull();
    expect(snap.usedPercentage).toBeNull();
    expect(snap.remainingTokens).toBeNull();
    expect(formatContextWindowLabel(snap)).toBe('—/200k');
  });
});

describe('formatContextWindowLabel', () => {
  it('compacta com a fronteira do milhão', () => {
    expect(
      formatContextWindowLabel(
        deriveContextWindowSnapshot({
          usedTokens: 999_500,
          maxTokens: 1_000_000,
        }),
      ),
    ).toBe('1m/1m');
  });

  it('vazio sem leitura', () => {
    expect(formatContextWindowLabel(EMPTY_CONTEXT_WINDOW)).toBe('—');
    expect(formatContextWindowLabel(EMPTY_CONTEXT_WINDOW, '?')).toBe('?');
  });
});

describe('urgency and fill', () => {
  it('limiares 85/95 e fill 0..1', () => {
    expect(
      contextWindowUrgency(deriveContextWindowSnapshot({ usedTokens: 10, maxTokens: 100 })),
    ).toBe('none');
    expect(
      contextWindowUrgency(deriveContextWindowSnapshot({ usedTokens: 86, maxTokens: 100 })),
    ).toBe('warn');
    expect(
      contextWindowUrgency(deriveContextWindowSnapshot({ usedTokens: 96, maxTokens: 100 })),
    ).toBe('critical');
    expect(contextWindowUrgency(EMPTY_CONTEXT_WINDOW)).toBe('none');
    expect(
      contextWindowFillRatio(deriveContextWindowSnapshot({ usedTokens: 50, maxTokens: 100 })),
    ).toBe(0.5);
    expect(contextWindowFillRatio(EMPTY_CONTEXT_WINDOW)).toBeNull();
  });
});
