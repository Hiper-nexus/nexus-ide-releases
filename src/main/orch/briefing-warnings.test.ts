import { describe, expect, it } from 'vitest';
import {
  briefingPointerWarning,
  extractBriefingRefs,
  formatBriefingWarning,
  BRIEFING_POINTER_MIN_CHARS,
} from './briefing-warnings';

describe('briefingPointerWarning', () => {
  it('is silent on short briefs even with a card ref', () => {
    expect(briefingPointerWarning('faz o OVKA-123')).toBeNull();
  });

  it('is silent on long briefs with no card/task ref', () => {
    const prose = 'x'.repeat(BRIEFING_POINTER_MIN_CHARS + 50);
    expect(briefingPointerWarning(prose)).toBeNull();
  });

  it('warns on long briefs that cite a card and suggests a one-line pointer', () => {
    const text =
      'Por favor execute a tarefa OVKA-273 com todo o contexto do card. ' +
      'Precisamos corrigir o login, depois o billing, e também atualizar ' +
      'a documentação do fluxo de onboarding para o time de produto inteiro, ' +
      'incluindo capturas de tela e a matriz de responsáveis por área. ' +
      'Inclui também o F-565 e TASK/items/qa-3 e o que mais faltar no dossiê.';
    expect(text.length).toBeGreaterThanOrEqual(BRIEFING_POINTER_MIN_CHARS);
    const warning = briefingPointerWarning(text);
    expect(warning).not.toBeNull();
    expect(warning?.kind).toBe('briefing_pointer');
    expect(warning?.refs).toContain('OVKA-273');
    expect(warning?.refs).toContain('F-565');
    expect(warning?.hint).toContain('OVKA-273');
    expect(formatBriefingWarning(warning!)).toContain('[briefing]');
  });

  it('handles null/undefined without throwing', () => {
    expect(briefingPointerWarning(null)).toBeNull();
    expect(briefingPointerWarning(undefined)).toBeNull();
  });

  it('extracts distinct refs across families', () => {
    const refs = extractBriefingRefs('ver C-194 e OVKA-1 e F-565 e TASK/items/x.md');
    expect(refs).toEqual(expect.arrayContaining(['C-194', 'OVKA-1', 'F-565', 'TASK/items/x.md']));
  });
});
