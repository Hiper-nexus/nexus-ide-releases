import { describe, expect, it } from 'vitest';
import { suggestMissionLaneFromGoal } from './mission-intent';

describe('suggestMissionLaneFromGoal', () => {
  it('returns null for short or implement-heavy goals', () => {
    expect(suggestMissionLaneFromGoal('fix')).toBeNull();
    expect(
      suggestMissionLaneFromGoal('Implementar login OAuth com testes'),
    ).toBeNull();
    expect(
      suggestMissionLaneFromGoal('Corrigir bug no painel de missões'),
    ).toBeNull();
  });

  it('suggests plan for design-only wording', () => {
    expect(
      suggestMissionLaneFromGoal('Planejar a arquitetura de auth sem código'),
    ).toBe('plan');
    expect(
      suggestMissionLaneFromGoal('Escrever o PRD e documentar arquitetura'),
    ).toBe('plan');
  });

  it('suggests consult for investigation-only wording', () => {
    expect(
      suggestMissionLaneFromGoal('Consultar logs da Vercel e resumir erros'),
    ).toBe('consult');
    expect(
      suggestMissionLaneFromGoal('Investigar o que está acontecendo no deploy'),
    ).toBe('consult');
  });

  it('does not suggest plan when implement signals dominate', () => {
    expect(
      suggestMissionLaneFromGoal(
        'Planejar e implementar a feature de billing completa',
      ),
    ).toBeNull();
  });
});
