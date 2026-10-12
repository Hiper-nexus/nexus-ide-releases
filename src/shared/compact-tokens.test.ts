import { describe, expect, it } from 'vitest';
import {
  COMPACT_TOKENS_K_TO_M,
  formatCompactTokens,
  formatCompactTokensPrecise,
  formatCompactTokensUpperM,
} from './compact-tokens';

describe('formatCompactTokens', () => {
  it('métrica ausente é vazia, nunca 0', () => {
    expect(formatCompactTokens(null)).toBe('—');
    expect(formatCompactTokens(undefined)).toBe('—');
    expect(formatCompactTokens(Number.NaN)).toBe('—');
    expect(formatCompactTokens(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('valores pequenos inteiros', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(403)).toBe('403');
    expect(formatCompactTokens(999)).toBe('999');
  });

  it('milhares curtos com 1 casa', () => {
    expect(formatCompactTokens(1_500)).toBe('1.5k');
    expect(formatCompactTokens(1_000)).toBe('1k');
    expect(formatCompactTokens(9_999)).toBe('10k');
  });

  it('milhares longos arredondados', () => {
    expect(formatCompactTokens(10_000)).toBe('10k');
    expect(formatCompactTokens(12_400)).toBe('12k');
    expect(formatCompactTokens(999_499)).toBe('999k');
  });

  it('fronteira do milhão: 999500+ vira m, nunca 1000k', () => {
    expect(COMPACT_TOKENS_K_TO_M).toBe(999_500);
    expect(formatCompactTokens(999_499)).toBe('999k');
    expect(formatCompactTokens(999_500)).toBe('1m');
    expect(formatCompactTokens(999_999)).toBe('1m');
    expect(formatCompactTokens(1_000_000)).toBe('1m');
    expect(formatCompactTokens(1_100_000)).toBe('1.1m');
    expect(formatCompactTokens(1_234_567)).toBe('1.2m');
    expect(formatCompactTokens(12_300_000)).toBe('12.3m');
  });

  it('negativos nunca imprimem sinal', () => {
    expect(formatCompactTokens(-5)).toBe('0');
    expect(formatCompactTokens(-1_500)).toBe('0');
  });
});

describe('formatCompactTokensUpperM', () => {
  it('mantém a mesma regra com M maiúsculo', () => {
    expect(formatCompactTokensUpperM(1_234_567)).toBe('1.2M');
    expect(formatCompactTokensUpperM(12_400)).toBe('12k');
    expect(formatCompactTokensUpperM(null)).toBe('—');
  });
});

describe('formatCompactTokensPrecise', () => {
  it('1 casa decimal em k e M, mesma fronteira do milhão', () => {
    expect(formatCompactTokensPrecise(42_100)).toBe('42.1k');
    expect(formatCompactTokensPrecise(1_234_567)).toBe('1.2M');
    expect(formatCompactTokensPrecise(999_499)).toBe('999.5k');
    expect(formatCompactTokensPrecise(999_500)).toBe('1M');
    expect(formatCompactTokensPrecise(1_100_000)).toBe('1.1M');
    expect(formatCompactTokensPrecise(null)).toBe('—');
  });
});
