import { describe, expect, it, vi } from 'vitest';
import { formatDecisionPercent, formatDecisionTime, formatDecisionUsd, parseMissionBudgetInput } from './decision-format';

describe('F-1167: formatos do motor de decisão', () => {
  it('US$ em pt-BR sem esconder gasto real', () => {
    expect(formatDecisionUsd(0)).toBe('US$ 0,00');
    expect(formatDecisionUsd(0.00004)).toBe('< US$ 0,0001');
    expect(formatDecisionUsd(0.0021)).toBe('US$ 0,0021');
    expect(formatDecisionUsd(2.5)).toBe('US$ 2,50');
  });

  it('porcentagem', () => {
    expect(formatDecisionPercent(0)).toBe('0%');
    expect(formatDecisionPercent(0.004)).toBe('< 1%');
    expect(formatDecisionPercent(0.835)).toBe('84%');
  });

  it('orçamento: vírgula, ponto e prefixo; 0–20; resto é inválido', () => {
    expect(parseMissionBudgetInput('0,50')).toBe(0.5);
    expect(parseMissionBudgetInput(' US$ 1.25 ')).toBe(1.25);
    expect(parseMissionBudgetInput('0')).toBe(0);
    expect(parseMissionBudgetInput('20')).toBe(20);
    for (const text of ['20,01', '-1', '1e1', 'abc', '', '1,2,3', '100']) expect(parseMissionBudgetInput(text)).toBeNull();
  });
});

describe('F-1377: horários de decisões em missões longas', () => {
  it('inclui a data para dias anteriores e preserva hora compacta hoje', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 12, 10, 30));
      expect(formatDecisionTime(new Date(2026, 9, 11, 23, 47).getTime())).toBe('11/10 · 23:47');
      expect(formatDecisionTime(new Date(2025, 9, 12, 23, 47).getTime())).toBe('12/10 · 23:47');
      expect(formatDecisionTime(new Date(2026, 9, 12, 8, 15).getTime())).toBe('08:15');
      expect(formatDecisionTime(Number.NaN)).toBe('—');
    } finally {
      vi.useRealTimers();
    }
  });
});
