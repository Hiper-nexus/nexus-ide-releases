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

  it('suggests consult for analysis/audit wording (vibe-coder autopilot)', () => {
    expect(
      suggestMissionLaneFromGoal(
        'analise no nexus. do disparo de panes de como ele esta se ' +
          'comprtando do que precisamos melhorar no sistema',
      ),
    ).toBe('consult');
    expect(
      suggestMissionLaneFromGoal('Fazer uma análise da arquitetura de billing'),
    ).toBe('consult');
    expect(
      suggestMissionLaneFromGoal('Audite a segurança das rotas da API'),
    ).toBe('consult');
    expect(
      suggestMissionLaneFromGoal('Explique como funciona o fluxo de login'),
    ).toBe('consult');
    expect(
      suggestMissionLaneFromGoal('Mapeie os pontos de acoplamento do módulo'),
    ).toBe('consult');
  });

  it('keeps implement precedence over analysis wording', () => {
    expect(
      suggestMissionLaneFromGoal('Analise o bug e corrigir o fluxo de login'),
    ).toBeNull();
  });

  it('does not suggest plan when implement signals dominate', () => {
    expect(
      suggestMissionLaneFromGoal(
        'Planejar e implementar a feature de billing completa',
      ),
    ).toBeNull();
  });

  it('suggests ops for infra/operation wording', () => {
    expect(
      suggestMissionLaneFromGoal('Fazer backup na VPS e subir a landing page'),
    ).toBe('ops');
    expect(
      suggestMissionLaneFromGoal('Configurar o DNS e publicar a landing page'),
    ).toBe('ops');
    expect(
      suggestMissionLaneFromGoal('Restartar o servidor e pausar o app'),
    ).toBe('ops');
    expect(
      suggestMissionLaneFromGoal('Migrar o app para outra VPS via SSH'),
    ).toBe('ops');
  });

  it('does not suggest ops when implement signals dominate', () => {
    expect(
      suggestMissionLaneFromGoal('Corrigir bug e fazer deploy'),
    ).toBeNull();
  });

  it('keeps consult/plan precedence over ops wording', () => {
    expect(
      suggestMissionLaneFromGoal('Investigar o que está acontecendo no deploy'),
    ).toBe('consult');
  });

  it('returns null for neutral goals', () => {
    expect(
      suggestMissionLaneFromGoal('Organizar a semana do time de produto'),
    ).toBeNull();
  });
});
