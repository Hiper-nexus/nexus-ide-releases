import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  classifyTask,
  routeTask,
  type AdapterAvailability,
  describePreferAdaptersOutcome,
} from './task-router';
import { countAdapterUses } from './route-pipeline';

function adapters(...installed: string[]): AdapterAvailability[] {
  const all = [
    'claude',
    'codex',
    'agy',
    'grok',
    'kimi',
    'glm',
    'glm-flash',
    'longcat',
  ];
  return all.map((id) => ({ id, installed: installed.includes(id) }));
}

describe('classifyTask', () => {
  it('flags security/payment/migration work as critical', () => {
    expect(classifyTask('implementar autenticação com refresh token').tier).toBe(
      'critical',
    );
    expect(classifyTask('fix the payment webhook retries').tier).toBe('critical');
    expect(classifyTask('rodar a migração do schema multi-tenant').tier).toBe(
      'critical',
    );
  });

  it('critical keywords keep their floor even in short asks', () => {
    expect(classifyTask('corrigir auth').tier).toBe('critical');
  });

  it('flags architecture/refactor/performance work as hard', () => {
    expect(
      classifyTask(
        'refatorar o motor de layout para melhorar a performance do canvas',
      ).tier,
    ).toBe('hard');
  });

  it('flags cosmetic work as easy', () => {
    expect(
      classifyTask('corrigir typo no README e ajustar o comentário da função').tier,
    ).toBe('easy');
  });

  it('flags read-only checks as trivial', () => {
    expect(classifyTask('listar os arquivos do diretório e verificar o status').tier).toBe(
      'trivial',
    );
  });

  it('defaults unmatched medium-size tasks to medium', () => {
    const { tier, signals } = classifyTask(
      'adicionar um endpoint que retorna o resumo diário dos usuários ativos',
    );
    expect(tier).toBe('medium');
    expect(signals).toEqual([]);
  });

  it('nudges a one-liner without signals down a tier', () => {
    expect(classifyTask('adicionar botão novo').tier).toBe('easy');
  });

  it('nudges a very long multi-part brief up a tier', () => {
    const long = Array.from(
      { length: 30 },
      (_, i) => `passo ${i} do fluxo com detalhes e requisitos`,
    ).join(' ');
    expect(classifyTask(long).tier).toBe('hard');
  });
});

describe('routeTask', () => {
  it('routes easy work to the cheapest installed candidate', () => {
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('grok', 'claude', 'codex'),
    );
    expect(decision).not.toBeNull();
    expect(decision!.tier).toBe('easy');
    expect(decision!.adapterId).toBe('grok');
    expect(decision!.model).toBe('grok-4-fast');
    expect(decision!.effort).toBe('low');
  });

  it('routes critical work to the strong tier with high effort', () => {
    const decision = routeTask(
      'auditar a segurança da autenticação e dos pagamentos',
      adapters('claude', 'grok'),
    );
    expect(decision!.tier).toBe('critical');
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5');
    expect(decision!.effort).toBe('xhigh');
    expect(decision!.reason).toContain('evitou');
  });

  it('falls through to the next candidate when the first is not installed', () => {
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('claude'),
    );
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-sonnet-4-6');
  });

  it('borrows from another tier when the target tier has nothing installed', () => {
    // Only glm installed: glm isn't a trivial/easy candidate, so an easy task
    // borrows it from the medium tier (where GLM 5.3 leads).
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('glm'),
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).toContain('melhor opção instalada');
  });

  it('routes trivial work to GLM Flash when it is the installed cheap lane', () => {
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('glm-flash', 'claude'),
      DEFAULT_ROUTING_TABLE,
      'trivial',
    );
    expect(decision!.adapterId).toBe('glm-flash');
    expect(decision!.model).toBe('glm-5.3-flash[1m]');
    expect(decision!.effort).toBe('low');
  });

  it('leads the medium tier with GLM 5.3 (cheap + strong)', () => {
    const decision = routeTask(
      'tarefa de complexidade média',
      adapters('claude', 'glm', 'codex'),
      DEFAULT_ROUTING_TABLE,
      'medium',
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.model).toBe('glm-5.3');
  });

  it('uses the configured Kimi model id that exists in kimi-code config.toml', () => {
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('kimi'),
      DEFAULT_ROUTING_TABLE,
      'easy',
    );
    expect(decision!.adapterId).toBe('kimi');
    expect(decision!.model).toBe('kimi-code/k3');
  });

  it('does not route to LongCat when the caller marks it unavailable', () => {
    const decision = routeTask(
      'tarefa de complexidade média',
      adapters('longcat', 'codex'),
      DEFAULT_ROUTING_TABLE,
      'medium',
    );
    expect(decision!.adapterId).toBe('longcat');

    const withoutLongCat = routeTask(
      'tarefa de complexidade média',
      adapters('codex'),
      DEFAULT_ROUTING_TABLE,
      'medium',
    );
    expect(withoutLongCat!.adapterId).toBe('codex');
  });

  it('reserva o claude OAuth para o orquestrador (reserveClaude)', () => {
    // Sem reserva: crítico pula fable API-only e vai para opus.
    const base = routeTask(
      'auditar a segurança da autenticação e dos pagamentos',
      adapters('claude', 'codex', 'grok'),
    );
    expect(base!.adapterId).toBe('claude');
    // Com reserva (contexto de worker): cai para a melhor alternativa não-claude.
    const reserved = routeTask(
      'auditar a segurança da autenticação e dos pagamentos',
      adapters('claude', 'codex', 'grok'),
      DEFAULT_ROUTING_TABLE,
      undefined,
      true,
    );
    expect(reserved!.adapterId).not.toBe('claude');
    expect(reserved!.tier).toBe('critical');
  });

  it('mantém claude quando é a ÚNICA CLI instalada, mesmo reservando', () => {
    const only = routeTask(
      'auditar a segurança da autenticação',
      adapters('claude'),
      DEFAULT_ROUTING_TABLE,
      undefined,
      true,
    );
    expect(only!.adapterId).toBe('claude');
  });

  it('respects an explicit tier override', () => {
    const decision = routeTask(
      'tarefa qualquer sem sinais',
      adapters('claude', 'grok', 'glm'),
      DEFAULT_ROUTING_TABLE,
      'critical',
    );
    expect(decision!.tier).toBe('critical');
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5');
  });

  it('keeps stronger critical candidates ahead of cheap fallback models', () => {
    const decision = routeTask(
      'auditar a segurança da autenticação e dos pagamentos',
      adapters('claude', 'codex', 'glm'),
    );

    expect(decision!.tier).toBe('critical');
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5');
    expect(decision!.reason).toContain('evitou');
  });

  it('returns null when no adapter is installed', () => {
    expect(routeTask('qualquer tarefa', adapters())).toBeNull();
  });

  it('lists the remaining tier candidates as alternatives', () => {
    const decision = routeTask(
      'auditar a segurança da autenticação',
      adapters('claude', 'codex'),
    );
    expect(decision!.alternatives.length).toBeGreaterThan(0);
    expect(decision!.alternatives.map((a) => a.adapterId)).toContain('codex');
  });

  it('promotes a newly discovered model only from task-specific evaluation evidence', () => {
    const decision = routeTask(
      'crie uma landing page responsiva com design excepcional',
      [{ id: 'future-cli', installed: true, models: ['future-model-1'] }],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      {
        adapters: {
          'future-cli': {
            models: [{
              id: 'future-model-1',
              availability: 'paid',
              costTier: 'medium',
              quality: {
                overall: 88,
                coding: 86,
                frontend: 97,
                reasoning: 90,
                evaluatedAt: '2026-07-01T00:00:00.000Z',
                source: 'nexus-eval/frontend-v1',
              },
            }],
          },
        },
      },
    );

    expect(decision).toMatchObject({
      adapterId: 'future-cli',
      model: 'future-model-1',
      effort: 'high',
    });
    expect(decision!.reason).toContain('avaliação Nexus por dimensão');
  });
});

describe('routeTask specialty + diversidade de onda', () => {
  it('não entrega UI no lead barato do tier medium (GLM)', () => {
    const decision = routeTask(
      'criar a nova tela de cobrança com estados vazios e acessibilidade',
      adapters('glm', 'agy', 'claude', 'codex'),
    );
    expect(decision!.specialty).toBe('visual');
    expect(decision!.policySource).toBe('heuristic');
    expect(decision!.adapterId).toBe('agy');
    expect(decision!.reason).toContain('specialty=visual');
  });

  it('honra benchmark da especialidade quando a tabela tem linhas', () => {
    const decision = routeTask(
      'criar a nova tela de onboarding com estados vazios e acessibilidade',
      adapters('glm', 'agy', 'claude', 'codex'),
      DEFAULT_ROUTING_TABLE,
      undefined,
      false,
      undefined,
      {
        specialtyBenchmark: {
          schemaVersion: 1,
          source: 'nexus-benchmark/v1',
          specialties: {
            visual: [
              { adapterId: 'codex', model: 'gpt-5.6-luna', score: 94, effort: 'high' },
            ],
          },
        },
      },
    );
    expect(decision!.policySource).toBe('benchmark');
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.effort).toBe('high');
  });

  it('não trata tabela de fixture como benchmark', () => {
    const decision = routeTask(
      'criar a nova tela de onboarding com estados vazios e acessibilidade',
      adapters('glm', 'agy', 'claude', 'codex'),
      DEFAULT_ROUTING_TABLE,
      undefined,
      false,
      undefined,
      {
        specialtyBenchmark: {
          schemaVersion: 1,
          source: 'nexus-eval/v1/fixture',
          specialties: {
            visual: [{ adapterId: 'codex', score: 99, effort: 'high' }],
          },
        },
      },
    );
    expect(decision!.policySource).toBe('heuristic');
    expect(decision!.adapterId).toBe('agy');
  });

  it('doc mecânico anota a faixa rápida sem trocar o CLI da prioridade heurística', () => {
    const decision = routeTask(
      'atualizar o README com o guia de instalação',
      adapters('glm', 'kimi', 'agy', 'grok'),
    );
    expect(decision!.specialty).toBe('doc');
    expect(decision!.policySource).toBe('heuristic');
    expect(decision!.adapterId).toBe('kimi');
    expect(decision!.reason).toContain('band=fast');
  });

  it('espalha CLIs no fan-out: o 2º e 3º worker não herdam o GLM do 1º', () => {
    const pool = adapters('glm', 'kimi', 'grok', 'codex', 'longcat', 'agy');
    const task =
      'implementar um endpoint que retorna o resumo diário dos usuários ativos';
    const first = routeTask(task, pool, DEFAULT_ROUTING_TABLE, 'medium');
    expect(first!.adapterId).toBe('glm');

    const second = routeTask(task, pool, DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
      missionUseCounts: new Map([[first!.adapterId, 1]]),
      multiScore: true,
    });
    expect(second!.adapterId).not.toBe(first!.adapterId);

    const third = routeTask(task, pool, DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
      missionUseCounts: countAdapterUses([first!.adapterId, second!.adapterId]),
      multiScore: true,
    });
    expect(
      new Set([first!.adapterId, second!.adapterId, third!.adapterId]).size,
    ).toBe(3);
  });
});

describe('classifyTask com fronteira de palavra (regressão: TypeScript ≠ cript)', () => {
  it('não infla tarefas TypeScript para critical por substring', () => {
    const c = classifyTask(
      'Corrigir dois bugs concretos na assistente de voz Jarvis em TypeScript no Electron',
    );
    expect(c.signals).not.toContain('cript');
    expect(c.tier).not.toBe('critical');
  });

  it('criptografia continua critical (prefixo legítimo)', () => {
    expect(
      classifyTask('implementar criptografia de ponta a ponta dos dados').tier,
    ).toBe('critical');
  });

  it('OAuth continua critical após a fronteira de palavra', () => {
    expect(
      classifyTask('revisar o fluxo de login OAuth do aplicativo').tier,
    ).toBe('critical');
  });

  it('compostos genuínos de segurança mantêm o floor critical', () => {
    expect(classifyTask('encrypt the exported backup files').tier).toBe('critical');
    expect(classifyTask('handle unauthorized access in the admin panel').tier).toBe(
      'critical',
    );
    expect(classifyTask('improve our cybersecurity posture review').tier).toBe(
      'critical',
    );
    expect(classifyTask('reautenticar o usuário depois do refresh').tier).toBe(
      'critical',
    );
  });

  it('compostos PT glued de segurança mantêm o floor critical', () => {
    expect(classifyTask('melhorar a cibersegurança do produto').tier).toBe('critical');
    expect(classifyTask('mitigar um ciberataque em andamento').tier).toBe('critical');
    expect(classifyTask('refatorar o schema multitenant com isolamento').tier).toBe(
      'critical',
    );
    expect(classifyTask('reencriptar os segredos rotacionados').tier).toBe('critical');
  });

  it('variantes PT de criptografia e autorização mantêm o floor critical', () => {
    expect(classifyTask('encriptar os dados do usuário em repouso').tier).toBe(
      'critical',
    );
    expect(classifyTask('descriptografar o payload recebido do parceiro').tier).toBe(
      'critical',
    );
    expect(
      classifyTask('tratar acesso não autorizado no painel de administração').tier,
    ).toBe('critical');
  });
});

describe('describePreferAdaptersOutcome (bug F — prefer não é silêncio)', () => {
  const availability = [
    { id: 'codex', installed: true },
    { id: 'claude', installed: false },
    { id: 'kimi', installed: true },
  ];

  it('preferido escolhido é dito com todas as letras', () => {
    expect(
      describePreferAdaptersOutcome(['codex'], 'codex', availability, ['codex', 'kimi']),
    ).toContain('codex=preferido escolhido');
  });

  it('preferido não instalado/reservado aparece no motivo', () => {
    expect(
      describePreferAdaptersOutcome(['claude'], 'codex', availability, ['codex']),
    ).toContain('claude=não instalado/reservado');
  });

  it('preferido fora do ranking do tier aparece', () => {
    expect(
      describePreferAdaptersOutcome(['kimi'], 'codex', availability, ['codex']),
    ).toContain('kimi=fora do ranking do tier');
  });

  it('sem preferAdapters a nota é vazia (não polui o reason)', () => {
    expect(
      describePreferAdaptersOutcome(undefined, 'codex', availability, ['codex']),
    ).toBe('');
  });
});
