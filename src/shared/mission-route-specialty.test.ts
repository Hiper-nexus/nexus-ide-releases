import { describe, expect, it } from 'vitest';
import {
  EMPTY_SPECIALTY_BENCHMARK,
  applyEffortFloor,
  classifyRouteSpecialty,
  preferAdapterOrder,
  resolveSpecialtyPolicy,
} from './mission-route-specialty';

describe('classifyRouteSpecialty', () => {
  it('marca UI como visual mesmo quando a tela é de cobrança', () => {
    const verdict = classifyRouteSpecialty(
      'criar a nova tela de cobrança com estados vazios e acessibilidade',
    );
    expect(verdict.specialty).toBe('visual');
    expect(verdict.workKind).toBe('visual');
  });

  it('sobrepõe segurança em feature de auth/pagamento', () => {
    const verdict = classifyRouteSpecialty(
      'implementar autenticação com refresh token e cobrança',
    );
    expect(verdict.specialty).toBe('security');
    expect(verdict.workKind).toBe('feature');
  });

  it('não rouba documentação sobre auth para a especialidade security', () => {
    const verdict = classifyRouteSpecialty(
      'documentar a política de autenticação OAuth no README',
    );
    expect(verdict.specialty).toBe('doc');
  });

  it('admite general quando não há vocabulário', () => {
    const verdict = classifyRouteSpecialty(
      'me ajuda com aquilo que a gente conversou ontem',
    );
    expect(verdict.specialty).toBe('general');
    expect(verdict.workKind).toBe('unknown');
  });
});

describe('resolveSpecialtyPolicy', () => {
  it('cai na heurística quando o benchmark da especialidade está vazio', () => {
    const policy = resolveSpecialtyPolicy('visual', EMPTY_SPECIALTY_BENCHMARK);
    expect(policy.source).toBe('heuristic');
    expect(policy.preferAdapterIds[0]).toBe('agy');
    expect(policy.effortFloor).toBe('medium');
  });

  it('feature/general não inventam um vencedor', () => {
    expect(
      resolveSpecialtyPolicy('feature', EMPTY_SPECIALTY_BENCHMARK).preferAdapterIds,
    ).toEqual([]);
    expect(
      resolveSpecialtyPolicy('general', EMPTY_SPECIALTY_BENCHMARK).preferAdapterIds,
    ).toEqual([]);
  });

  it('usa o benchmark da especialidade quando há linhas', () => {
    const policy = resolveSpecialtyPolicy('visual', {
      schemaVersion: 1,
      source: 'nexus-benchmark/v1',
      specialties: {
        visual: [
          { adapterId: 'codex', model: 'gpt-5.6-sol', score: 91, effort: 'high' },
          { adapterId: 'agy', score: 80 },
        ],
      },
    });
    expect(policy.source).toBe('benchmark');
    expect(policy.preferAdapterIds).toEqual(['codex', 'agy']);
    expect(policy.effortFloor).toBe('high');
  });
});

describe('preferAdapterOrder', () => {
  it('traz os preferidos para a frente na ordem da política', () => {
    const ranked = ['glm', 'kimi', 'agy', 'claude'].map((id) => ({ id }));
    expect(
      preferAdapterOrder(ranked, (item) => item.id, ['agy', 'claude']).map(
        (item) => item.id,
      ),
    ).toEqual(['agy', 'claude', 'glm', 'kimi']);
  });

  it('é no-op com lista vazia', () => {
    const ranked = ['glm', 'kimi'].map((id) => ({ id }));
    expect(preferAdapterOrder(ranked, (item) => item.id, [])).toEqual(ranked);
  });
});

describe('applyEffortFloor', () => {
  it('sobe low/medium para o piso, nunca desce xhigh', () => {
    expect(applyEffortFloor('medium', 'high')).toBe('high');
    expect(applyEffortFloor('xhigh', 'high')).toBe('xhigh');
    expect(applyEffortFloor(undefined, 'high')).toBe('high');
  });
});
