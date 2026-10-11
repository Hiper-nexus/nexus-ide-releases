import { describe, expect, it } from 'vitest';
import { formatDecisionPercent, formatDecisionUsd, parseMissionBudgetInput } from './decision-format';

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
