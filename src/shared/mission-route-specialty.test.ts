import { describe, expect, it } from 'vitest';
import {
  EMPTY_SPECIALTY_BENCHMARK,
  applyEffortFloor,
  classifyRouteSpecialty,
  preferAdapterOrder,
  resolveSpecialtyPolicy,
  specialtyBenchmarkIsMeasured,
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

  it('F-1402: credencial/conta gerenciada sobrepõe security', () => {
    const verdict = classifyRouteSpecialty(
      'remover o limite de um pane por conta: panes da mesma conta ' +
      'gerenciada compartilham uma única linhagem de credencial, sem ' +
      'cópia de refresh token',
    );
    expect(verdict.specialty).toBe('security');
  });

  it('F-1402 (Grok): flexões de/do/dos da linhagem de token viram security', () => {
    expect(classifyRouteSpecialty('linhagem de token da conta').specialty).toBe('security');
    expect(classifyRouteSpecialty('linhagem dos tokens de sessão').specialty).toBe('security');
  });

  it('F-1402 (Fable M9): credenciamento de fornecedores e linhagem de dados do pipeline não viram security', () => {
    expect(classifyRouteSpecialty('Revisar o fluxo de credenciamento de fornecedores').specialty).not.toBe('security');
    expect(classifyRouteSpecialty('Corrigir a linhagem de dados do pipeline e adicionar testes').specialty).not.toBe('security');
  });

  it('F-1402 C8: linhagem de dados e credenciamento não viram security', () => {
    expect(classifyRouteSpecialty('implementar linhagem de dados no ETL').specialty).not.toBe('security');
    expect(classifyRouteSpecialty('página de credenciamento de parceiros').specialty).not.toBe('security');
    expect(classifyRouteSpecialty('refresh token da conta').specialty).toBe('security');
    expect(classifyRouteSpecialty('compartilhar a linhagem do token entre panes').specialty).toBe('security');
  });

  it('F-1402: botão de login é UI — "login" sozinho não vira security', () => {
    const verdict = classifyRouteSpecialty('ajustar o texto do botão de login');
    expect(verdict.specialty).not.toBe('security');
  });

  it('F-1400 B1: teoria dos jogos não é jogo; jogo segue visual', () => {
    expect(classifyRouteSpecialty('aplicar teoria dos jogos ao leilão de preços').specialty).not.toBe('visual');
    expect(classifyRouteSpecialty('game theory for the pricing engine').specialty).not.toBe('visual');
    expect(classifyRouteSpecialty('criar um jogo da velha').specialty).toBe('visual');
    // Revisão Grok: o lookbehind só cobria "teoria dos".
    expect(classifyRouteSpecialty('aplicar teoria de jogos ao leilão').specialty).not.toBe('visual');
    expect(classifyRouteSpecialty('the name of the game is the 2d array').specialty).not.toBe('visual');
    expect(classifyRouteSpecialty('corrigir XSS no app Next.js').specialty).toBe('security');
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
  it('heurística não prefere CLI nenhuma — só mede o piso de esforço', () => {
    // Uso geral: a qualidade vem dos benchmarks oficiais publicados
    // (published-benchmarks.ts), nunca de uma lista de providers por
    // especialidade. Sem benchmark medido, preferAdapterIds é vazio.
    const policy = resolveSpecialtyPolicy('visual', EMPTY_SPECIALTY_BENCHMARK);
    expect(policy.source).toBe('heuristic');
    expect(policy.preferAdapterIds).toEqual([]);
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

  it('ignora linhas de fixture/estimativa — não vira benchmark mentiroso', () => {
    expect(specialtyBenchmarkIsMeasured('nexus-benchmark/unpublished')).toBe(
      false,
    );
    expect(specialtyBenchmarkIsMeasured('nexus-eval/v1/fixture')).toBe(false);
    expect(specialtyBenchmarkIsMeasured('nexus-benchmark/estimate')).toBe(false);
    expect(specialtyBenchmarkIsMeasured('nexus-benchmark/v1')).toBe(true);

    const policy = resolveSpecialtyPolicy('visual', {
      schemaVersion: 1,
      source: 'nexus-eval/v1/fixture',
      specialties: {
        visual: [{ adapterId: 'codex', score: 99 }],
      },
    });
    expect(policy.source).toBe('heuristic');
    expect(policy.preferAdapterIds).toEqual([]);
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

describe('F-1289 (revisão de ponta): overlay de segurança com flexão inglesa', () => {
  it('authenticated/authorized/payments voltam a sobrepor security', () => {
    expect(classifyRouteSpecialty('protect the routes for authenticated users').specialty).toBe('security');
    expect(classifyRouteSpecialty('only authorized admins can export the report').specialty).toBe('security');
    expect(classifyRouteSpecialty('refactoring the payments and webhooks flow').specialty).toBe('security');
    expect(classifyRouteSpecialty('corrigir os pagamentos duplicados no fluxo').specialty).toBe('security');
    expect(classifyRouteSpecialty('fix the pre-auth hook of the gateway').specialty).toBe('security');
  });

  it('guardas: author não é auth, flag de CLI não é palavra, cobrança sozinha não é security', () => {
    expect(classifyRouteSpecialty('fix the author bio and the authored by field').specialty).not.toBe('security');
    expect(classifyRouteSpecialty('run the worker with --auth-token disabled').specialty).not.toBe('security');
    expect(classifyRouteSpecialty('corrigir a cobrança do worker que não entrega').specialty).not.toBe('security');
  });
});
