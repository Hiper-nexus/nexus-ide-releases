import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  classifyTask,
  routeTask,
  type AdapterAvailability,
  describePreferAdaptersOutcome,
  type RoutingTable,
  type TaskTier,
} from './task-router';
import { countAdapterUses } from './route-pipeline';
import { classifyRouteSpecialty } from '../../shared/mission-route-specialty';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { adapterSchema } from '../../shared/adapter-types';
import { adapterCircuitBreakers } from './circuit-breaker';
import type { ModelCatalog } from '../adapters/model-catalog';
import { quarantineRejectedModel, resetModelAccessQuarantineForTests, setModelQuarantineScopeResolver } from './model-access-quarantine';

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
    'deepseek',
    'qwen',
  ];
  return all.map((id) => ({ id, installed: installed.includes(id) }));
}

describe('classifyTask', () => {
  it.each([
    'Read-only: implement a new endpoint returning the daily activity summary',
    'Somente leitura: mapear o fluxo entre catálogo, seleção e abertura dos panes',
  ])('permissão de leitura não determina complexidade: %s', (task) => {
    expect(classifyTask(task).tier).toBe('medium');
  });

  it('causa raiz continua substancial mesmo em leitura (F-1264)', () => {
    expect(classifyTask('Read-only root cause diagnosis of CLI orchestration diversity across available providers').tier).toBe('hard');
    expect(classifyTask('Investigação somente leitura da causa raiz de concentração dos panes no roteador').tier).toBe('hard');
    expect(classifyTask('read README').tier).toBe('trivial');
  });

  it('investigação e mapeamento somente leitura sem causa raiz é medium (F-1264 / F-194)', () => {
    expect(
      classifyTask('Investigar (somente leitura) o índice do code map e reportar onde ele é construído').tier,
    ).toBe('medium');
  });
  it('flags security/payment/migration work as critical', () => {
    expect(classifyTask('implementar autenticação com refresh token').tier).toBe(
      'critical',
    );
    expect(classifyTask('fix the payment webhook retries').tier).toBe('critical');
    expect(classifyTask('rodar a migração do schema multi-tenant').tier).toBe(
      'critical',
    );
  });

  it('F-1402: credencial/conta de login é superfície de segurança (critical)', () => {
    // Frase real do nexus_route_log (mission-94d90f5b) que saía medium/bug.
    expect(
      classifyTask(
        'Writer crítico de contas: remover o limite de um pane Claude por ' +
        'conta corrigindo a causa (panes da mesma conta gerenciada ' +
        'compartilham uma única linhagem de credencial, sem cópia de ' +
        'refresh token), com testes RED',
      ).tier,
    ).toBe('critical');
    expect(classifyTask('rotacionar as credenciais do keychain').tier).toBe('critical');
    expect(classifyTask('share the managed account login session').tier).toBe('critical');
    // 'login' sozinho não basta: texto de botão de login é UI, não credencial.
    expect(classifyTask('ajustar o texto do botão de login').tier).not.toBe('critical');
    // Domínio só citado continua barato (listagem/documento de uma ação só).
    expect(classifyTask('listar as credenciais escopadas').tier).toBe('trivial');
  });

  it('F-1402 (Grok): flexões de/do/dos da linhagem de token são superfície de credencial', () => {
    expect(classifyTask('linhagem de token da conta').tier).toBe('critical');
    expect(classifyTask('linhagem dos tokens de sessão').tier).toBe('critical');
  });

  it('F-1402 C8: linhagem de dados e credenciamento não são superfície de credencial', () => {
    expect(classifyTask('implementar linhagem de dados no ETL').tier).not.toBe('critical');
    expect(classifyTask('página de credenciamento de parceiros').tier).not.toBe('critical');
    expect(classifyTask('implementar a renovação do refresh token da conta').tier).toBe('critical');
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
  it('F-765: a rota exclui o acesso recusado só para a conta atual do Main', () => {
    resetModelAccessQuarantineForTests();
    let accountId = 'account-a';
    setModelQuarantineScopeResolver(() => ({ accountId }));
    try {
      quarantineRejectedModel('grok', 'grok-4.7', 'Model access is disabled');
      const pool = adapters('grok', 'claude', 'codex');
      const task = 'corrigir typo no README do projeto agora';
      expect(routeTask(task, pool)).not.toMatchObject({ adapterId: 'grok', model: 'grok-4.7' });
      accountId = 'account-b';
      const restored = routeTask(task, pool)!;
      expect([restored, ...restored.alternatives]).toContainEqual(expect.objectContaining({ adapterId: 'grok', model: 'grok-4.7' }));
    } finally {
      resetModelAccessQuarantineForTests();
    }
  });

  it('F-683: modelo recusado pelo provider sai do roteamento até a quarentena vencer', () => {
    resetModelAccessQuarantineForTests();
    const before = routeTask('corrigir typo no README do projeto agora', adapters('grok', 'claude', 'codex'));
    expect([before, ...before!.alternatives]).toContainEqual(expect.objectContaining({ adapterId: 'grok', model: 'grok-4.7' }));
    quarantineRejectedModel('grok', 'grok-4.7', 'Model access is disabled');
    const after = routeTask('corrigir typo no README do projeto agora', adapters('grok', 'claude', 'codex'));
    expect(after).not.toBeNull();
    expect([after, ...after!.alternatives]).not.toContainEqual(expect.objectContaining({ adapterId: 'grok', model: 'grok-4.7' }));
    resetModelAccessQuarantineForTests();
  });

  it('routes easy work to the cheapest installed candidate', () => {
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('grok', 'claude', 'codex'),
    );
    expect(decision).not.toBeNull();
    expect(decision!.tier).toBe('easy');
    // Implementation cost policy uses the known economic same-tier seat.
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.model).toBe('gpt-6-luna');
    expect(decision!.effort).toBe('low');
  });

  it('routes critical work to the strong tier with high effort', () => {
    const decision = routeTask(
      // F-233: 'auditar' virou sinal de revisão → lane de julgamento (Fable).
      'corrigir falha de segurança na autenticação e dos pagamentos',
      adapters('claude', 'grok'),
    );
    expect(decision!.tier).toBe('critical');
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5-5');
    expect(decision!.effort).toBe('xhigh');
  });

  it('falls through to the next candidate when the first is not installed', () => {
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('claude'),
    );
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-sonnet-5-5');
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

  it('routes easy/trivial work to qwen3.8-max when only qwen is installed (F-722)', () => {
    for (const tier of ['trivial', 'easy'] as const) {
      const decision = routeTask(
        'tarefa barata',
        adapters('qwen'),
        DEFAULT_ROUTING_TABLE,
        tier,
      );
      expect(decision!.adapterId).toBe('qwen');
      expect(decision!.model).toBe('qwen3.8-max');
    }
  });

  it('routes medium/hard to qwen3.8-max too: Qwen is always the 3.8 Max (F-722)', () => {
    const medium = routeTask(
      'tarefa média',
      adapters('qwen'),
      DEFAULT_ROUTING_TABLE,
      'medium',
    );
    expect(medium!.adapterId).toBe('qwen');
    expect(medium!.model).toBe('qwen3.8-max');
    const hard = routeTask(
      'tarefa difícil',
      adapters('qwen'),
      DEFAULT_ROUTING_TABLE,
      'hard',
    );
    expect(hard!.adapterId).toBe('qwen');
    expect(hard!.model).toBe('qwen3.8-max');
  });

  it('routes medium work to DeepSeek when installed (cli-pty no host Claude)', () => {
    const decision = routeTask(
      'tarefa de complexidade média',
      adapters('deepseek', 'mimo-code'),
      DEFAULT_ROUTING_TABLE,
      'medium',
    );
    expect(decision!.adapterId).toBe('deepseek');
    expect(decision!.model).toBe('deepseek-v4-pro');
    expect(decision!.effort).toBe('medium');
  });

  it('F-724: DeepSeek no Token Plan — tarefa trivial roteada no flash sobe no v4-pro', () => {
    const planDeepseek: AdapterAvailability = {
      id: 'deepseek',
      installed: true,
      // O catálogo do provedor Token Plan só tem o v4-pro (flash dá 403).
      models: ['deepseek-v4-pro'],
      modelAliases: {
        'deepseek-flash': 'deepseek-v4-pro',
        'deepseek-v4-flash': 'deepseek-v4-pro',
      },
    };
    for (const tier of ['trivial', 'easy'] as const) {
      const decision = routeTask('tarefa barata', [planDeepseek], DEFAULT_ROUTING_TABLE, tier);
      expect(decision!.adapterId).toBe('deepseek');
      expect(decision!.model).toBe('deepseek-v4-pro');
      // Mantém o esforço da linha barata e diz no motivo que o provedor trocou.
      expect(decision!.effort).toBe('low');
      expect(decision!.reason).toContain('deepseek:deepseek-flash→deepseek-v4-pro');
      expect(decision!.alternatives.map((c) => c.model)).not.toContain('deepseek-flash');
    }
    // API direta (sem alias): o trivial continua no flash.
    const direct = routeTask(
      'tarefa barata',
      [{ id: 'deepseek', installed: true, models: ['deepseek-v4-pro', 'deepseek-flash'] }],
      DEFAULT_ROUTING_TABLE,
      'trivial',
    );
    expect(direct!.model).toBe('deepseek-flash');
  });

  it('F-724: Qwen 3.8 continua só no Qwen Code — o DeepSeek do Claude nunca roteia modelo qwen', () => {
    for (const tier of ['trivial', 'easy', 'medium', 'hard', 'critical'] as const) {
      for (const row of DEFAULT_ROUTING_TABLE[tier]) {
        if (row.adapterId === 'deepseek') expect(row.model).toMatch(/^deepseek-/);
        if (row.model?.startsWith('qwen')) expect(row.adapterId).toBe('qwen');
      }
    }
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
    expect(decision!.model).toBe('claude-opus-5-5');
  });

  it('keeps stronger critical candidates ahead of cheap fallback models', () => {
    // A tabela padrão não carrega mais o api-only claude-fable-5 (estudo
    // 2026-09); a linha injetada mantém a cobertura do "evitou".
    const table = {
      ...DEFAULT_ROUTING_TABLE,
      critical: [
        { adapterId: 'claude', model: 'claude-fable-5', effort: 'xhigh' },
        ...DEFAULT_ROUTING_TABLE.critical,
      ],
    };
    const decision = routeTask(
      'corrigir falha de segurança na autenticação e dos pagamentos',
      adapters('claude', 'codex', 'glm'),
      table,
    );

    expect(decision!.tier).toBe('critical');
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5-5');
    expect(decision!.reason).toContain('evitou');
  });

  describe('modelos de topo (estudo 2026-09 §6)', () => {
    const top = (task: string, installed: string[], tier?: 'medium' | 'hard' | 'critical') =>
      routeTask(task, adapters(...installed), DEFAULT_ROUTING_TABLE, tier);

    it('revisão cruzada em hard/critical: Fable 5.1 no claude; o codex fica no Sol 6.1 (F-700)', () => {
      for (const tier of ['hard', 'critical'] as const) {
        const claude = top('Independent code review for the release', ['claude'], tier);
        expect(claude!.model).toBe('claude-fable-5-1');
        expect(claude!.reason).toContain('topo=cross-review');
        const codex = top('Independent code review for the release', ['codex'], tier);
        expect(codex!.model).toBe('gpt-6.1-sol');
      }
    });

    it('F-700: o Astra sai da rota automática e só vem pelo nome', () => {
      expect(top('corrigir a race condition na integração entre main e renderer', ['codex'], 'hard')!.model)
        .toBe('gpt-6.1-sol');
      expect(top('auditar a segurança da autenticação multi-tenant', ['codex'], 'critical')!.model)
        .toBe('gpt-6.1-sol');
      for (const tier of ['hard', 'critical'] as const) {
        expect(DEFAULT_ROUTING_TABLE[tier].map((c) => c.model)).not.toContain('gpt-6-astra');
      }
      // Pedido pelo nome continua valendo: task-router-review-floor.test.ts.
      expect(top('refatorar o parser de configuração', ['codex'], 'hard')!.model).toBe('gpt-6.1-sol');
      // No claude, o Opus 5.5 segue na frente do Fable fora de revisão.
      expect(top('definir a arquitetura da fila distribuída de eventos', ['claude'], 'hard')!.model).toBe('claude-opus-5-5');
    });

    it('GPT-6.1 Sol é o workhorse do codex; CLI sem ele cai no GPT-6 Sol, não no Astra', () => {
      const task = 'refatorar o parser de configuração';
      const codexWith = (models: string[]): AdapterAvailability => ({
        id: 'codex',
        installed: true,
        models,
        efforts: ['low', 'medium', 'high', 'xhigh'],
      });
      // CLI 0.159.0 já lista o 6.1 como "latest workhorse".
      expect(
        routeTask(task, [codexWith([
          'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra',
          'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
        ])], DEFAULT_ROUTING_TABLE, 'hard'),
      ).toMatchObject({ adapterId: 'codex', model: 'gpt-6.1-sol' });
      // CLI antiga sem o 6.1: a linha explícita de fallback entrega o Sol.
      expect(
        routeTask(task, [codexWith([
          'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra',
          'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
        ])], DEFAULT_ROUTING_TABLE, 'hard'),
      ).toMatchObject({ adapterId: 'codex', model: 'gpt-6-sol' });
    });

    it('tarefas rotineiras não recebem modelo de topo', () => {
      for (const task of ['revisar o texto do README', 'ajuste simples de label']) {
        const decision = top(task, ['claude', 'codex']);
        expect(['claude-opus-5-5', 'claude-fable-5-1', 'gpt-6-astra']).not.toContain(decision!.model);
      }
    });

    it('easy no claude oferece Sonnet 5.5 e preserva Sonnet 5 como fallback', () => {
      expect(DEFAULT_ROUTING_TABLE.easy.filter((c) => c.adapterId === 'claude').map((c) => c.model))
        .toEqual(['claude-sonnet-5-5', 'claude-sonnet-5']);
    });

    it('Fable 5.1 é rota automática (assinatura), Fable 5 não', () => {
      const decision = top('Independent code review for the release', ['claude'], 'critical');
      expect(decision!.reason).not.toContain('claude-fable-5-1 (');
      expect(DEFAULT_ROUTING_TABLE.critical.some((c) => c.model === 'claude-fable-5')).toBe(false);
    });
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
      [{ id: 'future-cli', installed: true, models: ['future-model-1'], efforts: ['low', 'medium', 'high'] }],
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
  it('especialidade visual sem benchmark medido vai para a lane de modelos de topo', () => {
    // Regra do operador (30/09): UI/design sempre usa Sol 6.1, Opus 5.5,
    // Sonnet 5.5 ou Astra — a lane promove o primeiro disponível da ordem.
    const decision = routeTask(
      'criar a nova tela de cobrança com estados vazios e acessibilidade',
      adapters('glm', 'agy', 'claude', 'codex'),
    );
    expect(decision!.specialty).toBe('visual');
    expect(decision!.policySource).toBe('heuristic');
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5-5');
    expect(decision!.reason).toContain('specialty=visual');
    expect(decision!.reason).toContain('lane visual');
  });

  it('honra a escolha de CLI do benchmark sem impor seu esforço à tarefa', () => {
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
    expect(decision!.effort).toBe('medium');
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
    // Fixture não vira prioridade de CLI: sem benchmark medido, a lane
    // visual do operador decide — Opus 5.5 encabeça os modelos de topo.
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-5-5');
  });

  it('doc mecânico não tem prioridade heurística — vale o líder natural do tier', () => {
    const decision = routeTask(
      'atualizar o README com o guia de instalação',
      adapters('glm', 'kimi', 'agy', 'grok'),
    );
    expect(decision!.specialty).toBe('doc');
    expect(decision!.policySource).toBe('heuristic');
    // kimi lidera a tabela easy — pela ordem do tier, não por prior de doc.
    expect(decision!.adapterId).toBe('kimi');
    expect(decision!.reason).not.toContain('band=');
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

  it('preferido não instalado aparece no motivo', () => {
    expect(
      describePreferAdaptersOutcome(['claude'], 'codex', availability, ['codex']),
    ).toContain('claude=não instalado');
  });

  it('F-985: preferido fora por política diz o motivo, não "não instalado"', () => {
    const reserved = [
      { id: 'codex', installed: true },
      {
        id: 'claude',
        installed: false,
        unavailableReason: 'reservado: 2 pane(s) Claude vivo(s) nesta missão para 2 conta(s) Claude utilizável(is) (um pane por conta)',
      },
    ];
    const note = describePreferAdaptersOutcome(['claude'], 'codex', reserved, ['codex']);
    expect(note).toContain('claude=reservado: 2 pane(s) Claude vivo(s)');
    expect(note).not.toContain('claude=não instalado');
  });

  it('preferido ausente do pool (reservado/indisponível) não vira "não instalado"', () => {
    // F-249: claude reservado ao Maestro sai do pool antes da lista — o motivo
    // não pode dizer "não instalado/sem login" para uma CLI logada.
    expect(
      describePreferAdaptersOutcome(['glm'], 'codex', availability, ['codex']),
    ).toContain('glm=fora do pool (reservado/indisponível)');
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

describe('routeTask — desempate por uso (tieBreakUseCounts)', () => {
  const flat = { adapters: {} } as ModelCatalog;
  const installed = adapters('grok', 'agy', 'kimi', 'codex', 'claude');

  it('rota sem missão evita a CLI com falhas mesmo com multi-score desativado', () => {
    for (let i = 0; i < 3; i += 1) adapterCircuitBreakers.recordFailure('grok');
    try {
      const route = routeTask('listar arquivos', installed, DEFAULT_ROUTING_TABLE,
        'trivial', false, flat, { multiScore: false, tieBreakUseCounts: new Map([['claude', 1]]) })!;
      expect(route.adapterId).not.toBe('grok');
      expect(route.alternatives.some((c) => c.adapterId === 'grok')).toBe(false);
    } finally {
      adapterCircuitBreakers.reset('grok');
    }
  });

  it.each(['claude', 'codex', 'glm', 'grok', 'agy', 'kimi', 'mimo-code'])(
    'distribui entre CLIs aptas com %s como orquestrador', (parent) => {
      const peers = ['claude', 'codex', 'glm', 'grok', 'agy', 'kimi', 'mimo-code'];
      const counts = new Map([[parent, 1]]);
      const picked: string[] = [];
      for (let i = 0; i < peers.length - 1; i += 1) {
        const route = routeTask('implementar a tarefa descrita', peers.map((id) => ({ id, installed: true })),
          DEFAULT_ROUTING_TABLE, 'medium', false, flat, { tieBreakUseCounts: counts })!;
        picked.push(route.adapterId);
        counts.set(route.adapterId, (counts.get(route.adapterId) ?? 0) + 1);
      }
      expect(new Set(picked)).toEqual(new Set(peers.filter((id) => id !== parent)));
    },
  );

  it('catalogo builtin completo tem candidatos com modelos reais na tabela', () => {
    const candidates = Object.values(DEFAULT_ROUTING_TABLE).flat();
    for (const input of BUILTIN_ADAPTERS) {
      const raw = adapterSchema.parse(input);
      if (raw.kind !== 'cli-pty') continue;
      const adapterCandidates = candidates.filter((c) => c.adapterId === raw.id);
      expect(adapterCandidates.length, raw.id).toBeGreaterThan(0);
      // Entradas antigas podem migrar; as CLIs antes ausentes usam ids do catálogo.
      if (['devin', 'muse', 'muse-claude', 'openclaude', 'aider', 'opencode'].includes(raw.id)) {
        for (const c of adapterCandidates) expect(raw.models.list, raw.id).toContain(c.model);
      }
    }
  });

  it('benchmark explícito não perde seu vencedor só porque ele já está aberto', () => {
    const route = routeTask('implementar a tarefa descrita', installed, DEFAULT_ROUTING_TABLE,
      'medium', false, flat, { tieBreakUseCounts: new Map([['claude', 4]]),
        specialtyBenchmark: { schemaVersion: 1, source: 'nexus-benchmark/v1',
          specialties: { feature: [{ adapterId: 'claude', score: 99 }, { adapterId: 'grok', score: 30 }] } },
        specialtyOverride: 'feature',
      })!;
    expect(route.adapterId).toBe('claude');
  });

  it('sem contagens a decisão é idêntica à de hoje', () => {
    const base = routeTask('listar arquivos', installed, DEFAULT_ROUTING_TABLE, 'trivial', false, flat, {});
    const same = routeTask('listar arquivos', installed, DEFAULT_ROUTING_TABLE, 'trivial', false, flat, {
      tieBreakUseCounts: new Map(),
    });
    expect(same).toEqual(base);
  });

  it('com o topo já aberto, a alternativa dentro da margem vence e o motivo diz', () => {
    const base = routeTask('listar arquivos', installed, DEFAULT_ROUTING_TABLE, 'trivial', false, flat, {})!;
    const runnerUp = base.alternatives.find((alt) => alt.adapterId !== base.adapterId)!;
    const tie = routeTask('listar arquivos', installed, DEFAULT_ROUTING_TABLE, 'trivial', false, flat, {
      tieBreakUseCounts: new Map([[base.adapterId, 1]]),
    })!;
    expect(tie.adapterId).toBe(runnerUp.adapterId);
    expect(tie.reason).toContain('desempate');
  });
});

describe('catálogo grok na tabela de roteamento', () => {
  it('nunca oferece modelo grok aposentado pelo provedor (confirmado via `grok models`: só 4.7/4.7-build-fast/4.6/4.5 existem)', () => {
    const retiredGrokModels = new Set([
      'grok-4.1',
      'grok-4',
      'grok-4-fast',
      'grok-code-fast-1',
      'grok-3',
    ]);
    for (const candidates of Object.values(DEFAULT_ROUTING_TABLE)) {
      for (const candidate of candidates) {
        if (candidate.adapterId !== 'grok') continue;
        expect(retiredGrokModels.has(candidate.model ?? '')).toBe(false);
      }
    }
  });

  it('opencode/easy usa o id real do DeepSeek V4 Flash (`opencode models`: sem sufixo -free)', () => {
    const easyOpencode = DEFAULT_ROUTING_TABLE.easy.find(
      (candidate) => candidate.adapterId === 'opencode',
    );
    expect(easyOpencode?.model).toBe('opencode/deepseek-v4-flash');
  });
});

describe('uso geral — multi-score espalha por todos os providers saudáveis', () => {
  const flat = { adapters: {} } as ModelCatalog;
  const readyIds = [
    'claude',
    'codex',
    'mimo-code',
    'minimax-code',
    'kimi',
    'glm',
    'grok',
    'agy',
  ];
  // Cada CLI pronta com os modelos que a tabela pede (como o cache real do
  // CLI reportaria), para que resolveRoutableModel valide cada candidato.
  const tableModels = (id: string) => [
    ...new Set(
      Object.values(DEFAULT_ROUTING_TABLE)
        .flat()
        .filter((c) => c.adapterId === id && c.model)
        .map((c) => c.model as string),
    ),
  ];
  const ready = readyIds.map((id) => ({
    id,
    installed: true,
    models: tableModels(id),
  }));

  it('8 rotas hard/medium consecutivas cobrem ≥5 CLIs e chegam em mimo-code e minimax-code', () => {
    const usedAdapters = new Set<string>();
    const useCounts = new Map<string, number>();
    const picked: string[] = [];
    let reserveClaude = false;
    // Mistura hard/medium como um plano real: com −18 de diversidade por uso,
    // o multi-score atravessa todo o roster saudável — inclusive MiMo e
    // MiniMax, que jamais apareciam quando só Claude/Astra/GPT eram pedidos.
    const tiers: TaskTier[] = [
      'hard',
      'medium',
      'hard',
      'medium',
      'hard',
      'medium',
      'medium',
      'medium',
    ];
    for (const tier of tiers) {
      const decision = routeTask(
        'implementar a tarefa descrita no briefing do worker',
        ready,
        DEFAULT_ROUTING_TABLE,
        tier,
        reserveClaude,
        flat,
        {
          missionUsedAdapters: new Set(usedAdapters),
          missionUseCounts: new Map(useCounts),
          multiScore: true,
        },
      )!;
      picked.push(decision.adapterId);
      usedAdapters.add(decision.adapterId);
      useCounts.set(decision.adapterId, (useCounts.get(decision.adapterId) ?? 0) + 1);
      if (decision.adapterId === 'claude') reserveClaude = true;
    }
    expect(new Set(picked).size).toBeGreaterThanOrEqual(5);
    expect(picked).toContain('mimo-code');
    expect(picked).toContain('minimax-code');
  });
});

describe('preferAdapters prioriza pares prontos e preserva rotas protegidas', () => {
  const flat = { adapters: {} } as ModelCatalog;

  it('preferência no mesmo tier também vale sem multi-score', () => {
    const decision = routeTask(
      'corrigir typo no README',
      adapters('grok', 'claude'),
      DEFAULT_ROUTING_TABLE,
      'easy',
      false,
      flat,
      { preferAdapters: ['claude'] },
    );
    expect(decision!.adapterId).toBe('claude');
  });

  it('prefer não derruba um candidato claramente melhor', () => {
    // gemini-3.8-flash-high (agy) tem benchmark oficial forte no tier
    // critical; o +4 de preferência do longcat não chega perto. Antes do fix,
    // preferAdapters virava prepend duro e o longcat ganhava.
    const decision = routeTask(
      'auditar a segurança da autenticação',
      adapters('agy', 'longcat'),
      DEFAULT_ROUTING_TABLE,
      'critical',
      false,
      undefined,
      { preferAdapters: ['longcat'], multiScore: true },
    );
    expect(decision!.adapterId).toBe('agy');
    expect(decision!.reason).toContain('longcat=preterido no multi-score');
  });

  it('prefer vence o empate entre candidatos equivalentes', () => {
    // Duas CLIs sem benchmark nem entrada de catálogo: qualidade neutra e
    // custo iguais — a posição desempataria, o prefer (+4) vira o jogo.
    const tieTable = {
      ...DEFAULT_ROUTING_TABLE,
      hard: [
        { adapterId: 'cli-a', effort: 'high' },
        { adapterId: 'cli-b', effort: 'high' },
      ],
    };
    const installed = [
      { id: 'cli-a', installed: true },
      { id: 'cli-b', installed: true },
    ];
    const plain = routeTask('implementar a tarefa', installed, tieTable, 'hard',
      false, flat, { multiScore: true });
    expect(plain!.adapterId).toBe('cli-a');
    const prefer = routeTask('implementar a tarefa', installed, tieTable, 'hard',
      false, flat, { preferAdapters: ['cli-b'], multiScore: true });
    expect(prefer!.adapterId).toBe('cli-b');
    expect(prefer!.reason).toContain('cli-b=preferido escolhido');
  });
});

describe('F-217 — o mais novo da linha vence mesmo sem catálogo', () => {
  const flat = { adapters: {} } as ModelCatalog;
  const codex = (models: string[]): AdapterAvailability[] => [
    { id: 'codex', installed: true, models },
  ];

  it('CLI anunciou gpt-6.2-sol (sem catálogo): hard roteia para ele e o motivo diz', () => {
    const decision = routeTask(
      'refatorar o motor de layout para melhorar a performance do canvas',
      codex(['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol']),
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      flat,
    );
    expect(decision?.adapterId).toBe('codex');
    expect(decision?.model).toBe('gpt-6.2-sol');
    expect(decision?.reason).toContain(
      'mais novo da linha: codex:gpt-6.1-sol→gpt-6.2-sol',
    );
  });

  it('modelo da tabela ausente da CLI mas com linha mais nova instalada → usa ela', () => {
    const table: RoutingTable = {
      trivial: [],
      easy: [],
      medium: [],
      critical: [],
      hard: [{ adapterId: 'codex', model: 'gpt-7-sol', effort: 'high' }],
    };
    const decision = routeTask(
      'tarefa',
      codex(['gpt-7.1-sol']),
      table,
      'hard',
      false,
      flat,
    );
    expect(decision?.adapterId).toBe('codex');
    expect(decision?.model).toBe('gpt-7.1-sol');
    expect(decision?.reason).toContain(
      'mais novo da linha: codex:gpt-7-sol→gpt-7.1-sol',
    );
    expect(decision?.reason).not.toContain('CLI sem o modelo roteado');
  });

  it('sem linha mais nova instalada, o descarte antigo continua ("CLI sem o modelo roteado")', () => {
    const table: RoutingTable = {
      trivial: [],
      easy: [],
      medium: [],
      critical: [],
      hard: [{ adapterId: 'codex', model: 'gpt-7-sol', effort: 'high' }],
    };
    // gpt-6-sol é mais VELHO que o pedido — não há upgrade; o fallback assume sem modelo.
    const decision = routeTask(
      'tarefa',
      codex(['gpt-6-sol']),
      table,
      'hard',
      false,
      flat,
    );
    expect(decision?.adapterId).toBe('codex');
    // Bind the actual safe fallback; never leave a potentially Astra default implicit.
    expect(decision?.model).toBe('gpt-6-sol');
    expect(decision?.reason).toContain('CLI sem o modelo roteado: codex:gpt-7-sol');
  });

  it('o mais novo api-only/deprecated NÃO é promovido', () => {
    const catalog: ModelCatalog = {
      adapters: {
        codex: {
          models: [
            { id: 'gpt-6.2-sol', availability: 'api-only', source: 'bundled' },
          ],
        },
      },
    };
    const decision = routeTask(
      'tarefa',
      codex(['gpt-6.2-sol', 'gpt-6.1-sol']),
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      catalog,
    );
    expect(decision?.model).toBe('gpt-6.1-sol');
    // Outras linhas da tabela sobem para o 6.1 — o bloqueado 6.2 nunca aparece.
    expect(decision?.reason).not.toContain('→gpt-6.2-sol');
  });

  it('o mais novo recusado pelo provider (quarentena) NÃO é promovido', () => {
    resetModelAccessQuarantineForTests();
    try {
      quarantineRejectedModel('codex', 'gpt-6.2-sol', 'Model access is disabled');
      const decision = routeTask(
        'tarefa',
        codex(['gpt-6.2-sol', 'gpt-6.1-sol']),
        DEFAULT_ROUTING_TABLE,
        'hard',
        false,
        flat,
      );
      expect(decision?.model).toBe('gpt-6.1-sol');
      expect(decision?.reason).not.toContain('→gpt-6.2-sol');
    } finally {
      resetModelAccessQuarantineForTests();
    }
  });

  it('Haiku 5.5 é o padrão do trivial; recusado pelo provider, o 4.5 segue como fallback Claude', () => {
    const claude = (models: string[]): AdapterAvailability[] => [
      { id: 'claude', installed: true, models },
    ];
    resetModelAccessQuarantineForTests();
    try {
      const open = routeTask(
        'renomear uma variável',
        claude(['claude-haiku-5-5', 'claude-haiku-4-5']),
        DEFAULT_ROUTING_TABLE,
        'trivial',
        false,
        flat,
      );
      expect(open?.model).toBe('claude-haiku-5-5');

      quarantineRejectedModel('claude', 'claude-haiku-5-5', 'Model access is disabled');
      const refused = routeTask(
        'renomear uma variável',
        claude(['claude-haiku-5-5', 'claude-haiku-4-5']),
        DEFAULT_ROUTING_TABLE,
        'trivial',
        false,
        flat,
      );
      expect(refused?.model).toBe('claude-haiku-4-5');
      expect(refused?.reason).not.toContain('→claude-haiku-5-5');
    } finally {
      resetModelAccessQuarantineForTests();
    }
  });

  describe('F-957 — Argon no hard só com a prova da sonda viva (`agy models`)', () => {
    // Missão real de 07/10: a rota do hard abriu o AGY com `--model
    // gemini-4-argon` e a CLI instalada saiu no boot ("model gemini-4-argon
    // is not recognized as a known model"). A lista mesclada do adapter
    // (manifest + catálogo + descoberta) sempre traz o Argon; só o que a
    // própria CLI anunciou prova que ela o aceita.
    const agyManifest = adapterSchema.parse(
      BUILTIN_ADAPTERS.find((raw) => (raw as { id?: string }).id === 'agy'),
    );
    // Desde o F-990 o manifest bundled é só o que o `agy models` imprime; o
    // Argon vem do catálogo (model-catalog.ts), parte da mesma união.
    const mergedModels = [...agyManifest.models.list, 'gemini-4-argon'];
    // Ids do "Available models" que a CLI instalada imprimiu (sem o Argon).
    const announced = [
      'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
      'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
      'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
      'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    ];
    const TASK =
      'Análise profunda somente leitura: motor de orquestração v2 do T3 Code ' +
      '(event log, effect worker, checkpoints, settlement)';
    const route = (agy: Partial<AdapterAvailability>) =>
      routeTask(
        TASK,
        [{ id: 'agy', installed: true, models: mergedModels, ...agy }],
        DEFAULT_ROUTING_TABLE,
        'hard',
        false,
        flat,
        { multiScore: false },
      );

    it('CLI que não anuncia o Argon: o hard cai no gemini-3.8-flash-high e o motivo diz', () => {
      expect(mergedModels).toContain('gemini-4-argon');
      const decision = route({ liveModels: announced });
      expect(decision?.adapterId).toBe('agy');
      expect(decision?.model).toBe('gemini-3.8-flash-high');
      expect(decision?.effort).toBe('high');
      // F-1267: o Argon sem prova de acesso nesta conta tem nota própria,
      // nunca a nota genérica "CLI sem o modelo roteado" que sugere tabela velha.
      expect(decision?.reason).toMatch(/sem acesso ao Argon nesta conta: agy:gemini-4-argon/);
      expect(decision?.reason).not.toMatch(/CLI sem o modelo roteado: agy:gemini-4-argon/);
      expect(decision?.alternatives.map((alt) => alt.model)).not.toContain('gemini-4-argon');
    });

    it('sem descoberta viva (liveModels ausente) o Argon também não entra', () => {
      expect(route({})?.model).toBe('gemini-3.8-flash-high');
    });

    it('com a CLI anunciando o Argon, o hard continua indo para ele', () => {
      const decision = route({ liveModels: ['gemini-4-argon', ...announced] });
      expect(decision?.model).toBe('gemini-4-argon');
    });
  });

  it('modelo pedido no texto sobe para o mais novo da linha e continua vencendo (F-218)', () => {
    // Regra do operador 29/09 repetida hoje: "Sol 6.1 saiu; nunca use o Sol
    // normal". A menção ainda decide CLI e linha — mas o id exato pedido é
    // substituído pelo mais novo que a CLI oferece naquela linha.
    const decision = routeTask(
      'refatorar o parser inteiro com o GPT-6 Sol',
      codex(['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol']),
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      flat,
    );
    expect(decision?.adapterId).toBe('codex');
    expect(decision?.model).toBe('gpt-6.2-sol');
    expect(decision?.reason).toContain('modelo pedido no texto: codex:gpt-6-sol');
    // A nota da linha registra o par pedido→usado (a tabela já tinha gerado o
    // mesmo upgrade para a linha gpt-6-sol — o dedup mantém um só).
    expect(decision?.reason).toContain('codex:gpt-6-sol→gpt-6.2-sol');
  });

  it('menção sem irmão mais novo passa intacta, sem nota de upgrade', () => {
    const decision = routeTask(
      'refatorar o parser inteiro — use o gpt-6-luna',
      codex(['gpt-6.2-sol', 'gpt-6-luna', 'gpt-5.6-luna']),
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      flat,
    );
    expect(decision?.adapterId).toBe('codex');
    expect(decision?.model).toBe('gpt-6-luna');
    expect(decision?.reason).toContain('modelo pedido no texto: codex:gpt-6-luna');
    expect(decision?.reason).not.toContain('gpt-6-luna→');
  });

  it('o mais novo em quarentena não assume a menção — pega o elegível da linha', () => {
    resetModelAccessQuarantineForTests();
    try {
      quarantineRejectedModel('codex', 'gpt-6.2-sol', 'Model access is disabled');
      const decision = routeTask(
        'refatorar o parser inteiro com o GPT-6 Sol',
        codex(['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol']),
        DEFAULT_ROUTING_TABLE,
        'hard',
        false,
        flat,
      );
      expect(decision?.model).toBe('gpt-6.1-sol');
      expect(decision?.reason).toContain('codex:gpt-6-sol→gpt-6.1-sol');
    } finally {
      resetModelAccessQuarantineForTests();
    }
  });
});

/**
 * F-1289: a heurística decidia tier e especialidade por UMA palavra solta e
 * ambígua, e por prefixo dentro de identificador. Os três textos abaixo são os
 * recibos reais de `nexus_pane_spawn` (11/10/2026) que expuseram o defeito:
 * trabalho grande caindo em modelo fraco e trabalho pequeno caindo em critical.
 */
describe('F-1289: palavra ambígua sozinha não decide tier nem especialidade', () => {
  // "cobrança" aqui é cobrar ENTREGA do worker, não cobrança de dinheiro.
  const ONE_SHOT_PANE =
    'Corrigir pane one-shot do Nexus (agy --print, opencode run) vivo tratado como ocioso: cobrança e re-rota, reuso que perde a tarefa';
  // 4 bugs de update; "checkedAt" é um campo do JSON, "checagem" é substantivo.
  const UPDATER =
    'Corrigir o atualizador do Nexus: erro de checagem sem checkedAt vira rajada, rate limit, ZIP de update esquecido e URL de download de qualquer host';
  // Heurística de shell em bash/zsh; "texto cru" é domínio, não copy.
  const OSC_MARKERS =
    'Corrigir no Nexus: classificação de comando pesado por texto cru e marcadores OSC 133 errados no bash e no zsh';

  it('pane one-shot não vira critical/security por "cobrança" nem por --print', () => {
    const classification = classifyTask(ONE_SHOT_PANE);
    expect(classification.tier).not.toBe('critical');
    expect(classification.tier).toBe('medium');
    expect(classifyRouteSpecialty(ONE_SHOT_PANE).specialty).not.toBe('security');
  });

  it('atualizador com 4 bugs não vira trivial por "checkedAt"', () => {
    const classification = classifyTask(UPDATER);
    expect(classification.tier).not.toBe('trivial');
    expect(classification.tier).toBe('medium');
  });

  it('marcadores OSC em bash/zsh não vira easy por "texto"', () => {
    const classification = classifyTask(OSC_MARKERS);
    expect(classification.tier).not.toBe('easy');
    expect(classification.tier).toBe('medium');
  });

  it('fronteira de palavra: identificador e palavra maior não casam o sinal', () => {
    // author ≠ auth, dockerfile ≠ doc, login ≠ log, textual ≠ text
    expect(classifyTask('Corrigir o author do formulário de cadastro').tier).toBe('medium');
    expect(classifyTask('Ajustar o Dockerfile do serviço de build').tier).toBe('medium');
    // 'login' não é 'log': o tier fácil aqui é só o nudge de tamanho (6 palavras).
    expect(classifyTask('Corrigir o login social com Google').signals).not.toContain('log');
    expect(classifyTask('Corrigir a contagem regressiva da tela inicial').tier).toBe('medium');
  });

  it('palavra ambígua com um segundo sinal continua decidindo', () => {
    // "cobrança" + "produção" = dinheiro de verdade (matriz 23/08).
    expect(classifyTask('implemente cobrança com cartão no checkout de produção').tier).toBe(
      'critical',
    );
    expect(
      classifyRouteSpecialty('implementar autenticação com refresh token e cobrança').specialty,
    ).toBe('security');
  });
});

/**
 * F-1289, revisão de ponta (12/10): a troca de prefixo por palavra inteira
 * apagou as flexões em INGLÊS dos sinais de risco ('authenticated',
 * 'payments', 'migrations', 'debugging') e o hífen/barra deixaram de ser
 * fronteira ('multi-tenant', 'pre-auth', 'api/auth'). Os squads promptam em
 * inglês: sem isso a política high-risk e o piso de esforço somem quando o Jev
 * fica abaixo do limiar. As guardas do F-1289 continuam valendo.
 */
describe('F-1289 (revisão de ponta): flexão inglesa e hífen voltam a casar os sinais de risco', () => {
  it('flexões em inglês de segurança, pagamento e migração voltam a critical', () => {
    const auth = classifyTask('fix the authorization check for authenticated users');
    expect(auth.tier).toBe('critical');
    expect(auth.signals).toEqual(expect.arrayContaining(['authentica', 'authoriz']));

    const payments = classifyTask('refactoring the payments and webhooks flow');
    expect(payments.tier).toBe('critical');
    expect(payments.signals).toEqual(expect.arrayContaining(['payment', 'webhook']));

    expect(classifyTask('run the pending migrations')).toEqual({
      tier: 'critical',
      signals: ['migration'],
    });
    expect(classifyTask('isolate tenants and fix the deadlocks in the race conditions').signals)
      .toEqual(expect.arrayContaining(['tenant', 'deadlock', 'race condition']));
    expect(classifyTask('require authorized users').tier).toBe('critical');
    expect(classifyTask('fix the authz check on the admin routes').signals).toContain('authz');
  });

  it('flexões em inglês dos sinais hard voltam a casar (frase curta segue o nudge de tamanho)', () => {
    // Regra da casa: até 6 palavras desce um nível — 'debugging the backend api'
    // era medium com sinal 'debug' antes do F-1289 e volta a ser exatamente isso.
    expect(classifyTask('debugging the backend api')).toEqual({ tier: 'medium', signals: ['debug'] });
    expect(classifyTask('debugging the backend api for the mobile app this week').tier).toBe('hard');

    const hard = classifyTask(
      'refactoring the parsers and compilers, redesigned algorithms and new integrations for the backend',
    );
    expect(hard.tier).toBe('hard');
    expect(hard.signals).toEqual(
      expect.arrayContaining(['refactor', 'redesign', 'algorithm', 'parser', 'compiler', 'integration']),
    );
    expect(classifyTask('find the memory leaks and root causes in the worker pool').signals)
      .toEqual(expect.arrayContaining(['memory leak', 'root cause']));
  });

  it('espelho pt-BR: plural e radical dos mesmos sinais', () => {
    expect(classifyTask('rode as migrações pendentes do banco').tier).toBe('critical');
    expect(classifyTask('depurando a api do backend do app mobile').tier).toBe('hard');
    expect(classifyTask('reescrever os algoritmos de ordenação do backend do app').tier).toBe('hard');
    expect(classifyTask('mudança arquitetural no gateway de sessões do backend').tier).toBe('hard');
    expect(classifyTask('ligar as integrações do backend com o app mobile').tier).toBe('hard');
    expect(classifyTask('ajustar os sistemas distribuídos do backend do app').tier).toBe('hard');
  });

  it('hífen e barra voltam a ser fronteira de palavra', () => {
    expect(classifyTask('multi-tenant isolation')).toEqual({ tier: 'critical', signals: ['tenant'] });
    expect(classifyTask('pre-auth hook')).toEqual({ tier: 'critical', signals: ['auth'] });
    expect(classifyTask('api/auth login')).toEqual({ tier: 'critical', signals: ['auth'] });
  });

  it('guardas do F-1289 seguem de pé', () => {
    // flag de CLI não é palavra: '--print' ≠ print, '--debug' ≠ debug, '-auth' ≠ auth
    expect(classifyTask('run agy --print on the repo').signals).not.toContain('print');
    expect(classifyTask('run the build with --debug enabled for the worker').signals).not.toContain('debug');
    expect(classifyTask('call the cli with -auth disabled for the worker').signals).not.toContain('auth');
    expect(classifyTask('`--print` e `--debug` no opencode run do worker').signals).toEqual([]);
    // identificador e palavra maior não casam o sinal
    expect(classifyTask('fix checkedAt in the checkout page').signals).not.toContain('check');
    expect(classifyTask('update the authored by field and the author bio').tier).not.toBe('critical');
    expect(classifyTask('fix the co-author and the authority of the post').signals).toEqual([]);
    expect(classifyTask('Corrigir o login social com Google').signals).not.toContain('log');
    expect(classifyTask('Ajustar o Dockerfile do serviço de build').signals).not.toContain('doc');
    expect(classifyTask('ajustar o pre-login do app').signals).not.toContain('log');
    // palavra ambígua sozinha não decide tier extremo
    expect(classifyTask('ajustar a cobrança do worker no painel de entregas').tier).not.toBe('critical');
    expect(classifyTask('trocar o texto do aviso de cota').tier).toBe('medium');
    expect(classifyTask('check the updater output').tier).not.toBe('trivial');
    expect(classifyTask('reduce the token usage of the context window').tier).not.toBe('critical');
    expect(classifyTask('gerar a produção de vídeo do relatório semanal').tier).not.toBe('critical');
  });
});

/**
 * F-1340/F-1341 (sonda C, s240): substantivo de domínio diz ONDE a tarefa mexe,
 * não quão difícil ela é. Documento ou ação mecânica de uma ação só não sobe a
 * critical por "segurança/webhook/billing".
 */
describe('F-1340/F-1341: domínio sozinho não sobe documento nem ação mecânica a critical', () => {
  it('traduzir o documento de segurança é doc, não security/critical (F-1340)', () => {
    const text = 'traduzir o documento de segurança para inglês';
    expect(classifyRouteSpecialty(text)).toMatchObject({ specialty: 'doc', workKind: 'doc' });
    expect(classifyTask(text).tier).not.toBe('critical');
  });

  it.each([
    ['corrigir typo no README da integração de webhook', 'easy'],
    ['escrever documentação do endpoint de billing', 'easy'],
    ['listar os webhooks cadastrados', 'trivial'],
  ])('%j → %s (F-1341)', (text, tier) => {
    expect(classifyTask(text).tier).toBe(tier);
  });

  it('guardas: trabalho real, pedido composto e modo de falha seguem critical', () => {
    for (const text of [
      'corrigir auth',
      'implementar OAuth e atualizar o README',
      'renomear a variável e ajustar o fluxo OAuth',
      'Analise o módulo de pagamentos e liste os riscos',
      'corrigir typo no README do deadlock do webhook',
      'listar as migrações pendentes do banco',
    ]) {
      expect(classifyTask(text).tier, text).toBe('critical');
    }
  });

  it('revisão Fable: typo/rename/tradução em código de auth/segredo/produção não rebaixa o domínio', () => {
    // Só documento (work-kind doc) ou listagem rebaixam o domínio sozinho;
    // a ação mecânica no CÓDIGO daquele domínio continua no tier do domínio.
    for (const text of [
      'corrigir typo na validação do token JWT',
      'renomear o secret do webhook de produção',
      'fix typo in the OAuth callback handler',
    ]) {
      expect(classifyTask(text).tier, text).toBe('critical');
    }
    // O artefato de doc continua rebaixando.
    expect(classifyTask('fix typo in the OAuth docs').tier).toBe('easy');
    expect(classifyTask('corrigir typo na documentação do token JWT').tier).toBe('easy');
  });

  it('documento como produto ("upload de documentos") não vira doc', () => {
    expect(classifyRouteSpecialty('implementar upload de documentos no cadastro').workKind).toBe('feature');
  });
});

describe('F-1344: verbo de migração e corrupção de dados são critical', () => {
  it.each([
    'migrar o banco de dados de produção sem downtime',
    'migre o schema do postgres para a v2',
    'migrate the production database to the new cluster',
    'corrigir corrupção de dados que afeta todos os clientes',
    'fix the corrupted rows in the orders table',
  ])('%j → critical', (text) => {
    expect(classifyTask(text).tier).toBe('critical');
  });
});

describe('F-1313 — preferência explícita e espalhamento', () => {
  it('recibo não atribui custo econômico ao writer caro escolhido por preferência', () => {
    const decision = routeTask('implementar o resumo diário', adapters('glm', 'codex'),
      DEFAULT_ROUTING_TABLE, 'medium', false, { adapters: {
        glm: { models: [{ id: 'glm-5.3', costTier: 'low' }] },
        codex: { models: [{ id: 'gpt-6-luna', costTier: 'high' }] },
      } }, { multiScore: false, preferAdapters: ['codex'] });
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.reason).toContain('codex=preferido escolhido');
    expect(decision!.reason).not.toContain('escritor econômico elegível');
  });

  it('recibo não atribui a escolha final ao fair-share quando a preferência venceu', () => {
    // Revisão Fable: preferência é boost — vence o fair-share só quando o
    // preferido também está dentro da folga de uso global (FAIR_SHARE_GAP).
    const decision = routeTask('mapear o resumo diário', adapters('glm', 'deepseek', 'longcat'),
      DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
        multiScore: false, preferAdapters: ['longcat'],
        globalUseCounts: new Map([['glm', 100], ['deepseek', 0], ['longcat', 1]]),
      });
    expect(decision!.adapterId).toBe('longcat');
    expect(decision!.reason).toContain('longcat=preferido escolhido');
    expect(decision!.reason).not.toContain('fair-share:');
    // O preferido muito acima no uso global cede ao fair-share.
    const yielded = routeTask('mapear o resumo diário', adapters('glm', 'deepseek'),
      DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
        multiScore: false, preferAdapters: ['glm'],
        globalUseCounts: new Map([['glm', 100], ['deepseek', 0]]),
      });
    expect(yielded!.adapterId).toBe('deepseek');
    expect(yielded!.reason).toContain('fair-share:');
    expect(yielded!.reason).toContain('preferência cedeu ao espalhamento');
  });

  it.each(['mission', 'global'])('writer preserva o assento sem uso antes do custo: %s', (history) => {
    const decision = routeTask('implementar o resumo diário', [
      { id: 'glm', installed: true, models: ['glm-5.3'] },
      { id: 'codex', installed: true, models: ['gpt-6-luna'] },
    ], DEFAULT_ROUTING_TABLE, 'medium', false, { adapters: {
      glm: { models: [{ id: 'glm-5.3', costTier: 'low' }] },
      codex: { models: [{ id: 'gpt-6-luna', costTier: 'high' }] },
    } }, {
      multiScore: false,
      ...(history === 'mission'
        ? { missionUseCounts: new Map([['glm', 3], ['codex', 0]]) }
        : { globalUseCounts: new Map([['glm', 3], ['codex', 0]]) }),
    });
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.reason).toContain(history === 'mission' ? 'rotação garantida' : 'fair-share');
    expect(decision!.reason).not.toContain('escritor econômico elegível');
  });

  it('preferência não empresta candidato de outro tier', () => {
    const table = { ...DEFAULT_ROUTING_TABLE,
      medium: [{ adapterId: 'codex', model: 'gpt-6-luna' }],
      hard: [{ adapterId: 'deepseek', model: 'deepseek-v4-pro' }],
    };
    const decision = routeTask('mapear o resumo diário', adapters('codex', 'deepseek'),
      table, 'medium', false, { adapters: {} }, { preferAdapters: ['deepseek'] });
    expect(decision!.adapterId).toBe('codex');
  });

  it('preferência não sobrepõe segurança mesmo com tier medium', () => {
    const table = { ...DEFAULT_ROUTING_TABLE, medium: [
      { adapterId: 'codex', model: 'gpt-6-luna' },
      { adapterId: 'deepseek', model: 'deepseek-v4-pro' },
    ] };
    const decision = routeTask('mapear o resumo diário', adapters('codex', 'deepseek'),
      table, 'medium', false, { adapters: {} }, {
        preferAdapters: ['deepseek'], specialtyOverride: 'security', multiScore: false,
      });
    expect(decision!.adapterId).toBe('codex');
  });

  it('Kimi pronto sem assentos recebe a tarefa visual medium em vez do Codex com três', () => {
    const decision = routeTask('implementar a tela responsiva e seus componentes visuais',
      adapters('codex', 'kimi'), DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
        multiScore: true, missionUseCounts: new Map([['codex', 3], ['kimi', 0]]),
      });
    expect(decision!.specialty).toBe('visual');
    expect(decision!.adapterId).toBe('kimi');
    expect(decision!.model).toBe('kimi-code/k3');
  });

  it('F-1400 ADD2: Kimi é topo e recebe front quando é o único assento pronto', () => {
    const ready = [
      { id: 'codex', installed: true, models: ['gpt-6-luna'] },
      { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
    ];
    for (const counts of [[['codex', 1]], [['kimi', 1]], [['kimi', 1], ['codex', 1]]] as Array<Array<[string, number]>>) {
      const decision = routeTask('implementar a tela responsiva e seus componentes visuais', ready,
        DEFAULT_ROUTING_TABLE, 'medium', false, undefined, { multiScore: true, missionUseCounts: new Map(counts) })!;
      expect(decision.adapterId).toBe('kimi');
      expect(decision.reason).toContain('lane visual (modelos de topo)');
    }
  });

  it.each(['mapear o resumo diário', 'implementar o resumo diário'])('DeepSeek pronto preferido vence no mesmo tier: %s', (task) => {
    const decision = routeTask(task,
      adapters('codex', 'deepseek', 'glm'), DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
        multiScore: true, preferAdapters: ['deepseek'],
      });
    expect(decision!.adapterId).toBe('deepseek');
    expect(decision!.reason).toContain('deepseek=preferido escolhido');
    expect(decision!.reason).not.toContain('rotação garantida');
    expect(decision!.reason).not.toContain('fair-share:');
    // Revisão Fable: boost, não pin — com três assentos e uso global alto, o
    // preferido cede a um par pronto do mesmo tier sem assento.
    const spread = routeTask(task,
      adapters('codex', 'deepseek', 'glm'), DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
        multiScore: true, preferAdapters: ['deepseek'],
        missionUseCounts: new Map([['deepseek', 3]]),
        globalUseCounts: new Map([['deepseek', 100]]),
      });
    expect(spread!.adapterId).not.toBe('deepseek');
    expect(spread!.reason).toContain('preferência cedeu ao espalhamento');
  });

  it('revisão Fable (a): preferência não tira a tarefa visual da lane de topo', () => {
    // O pin redistribuído vira preferAdapters; a override rodava depois da
    // lane visual e o glm-5.3 levava a tela com o recibo dizendo "lane visual".
    const decision = routeTask('implementar a tela responsiva e seus componentes visuais',
      adapters('claude', 'codex', 'glm'), DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
        multiScore: true, preferAdapters: ['glm'],
      });
    expect(decision!.specialty).toBe('visual');
    expect(decision!.adapterId).not.toBe('glm');
    expect(decision!.reason).toContain('lane visual (modelos de topo)');
    expect(decision!.reason).not.toContain('glm=preferido escolhido');
    // Dentro da lane, a preferência continua escolhendo entre os assentos dela.
    const inLane = routeTask('implementar a tela responsiva e seus componentes visuais',
      adapters('claude', 'codex', 'glm'), DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
        multiScore: true, preferAdapters: ['codex'],
      });
    expect(inLane!.adapterId).toBe('codex');
    expect(inLane!.reason).toContain('lane visual (modelos de topo)');
  });

  it('revisão Fable (b): preferência é boost, não pin — três spawns não vão todos para o preferido', () => {
    const spawn = (counts: Array<[string, number]>) => routeTask('implementar o resumo diário',
      adapters('codex', 'glm'), DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
        multiScore: true, preferAdapters: ['codex'],
        missionUseCounts: new Map(counts), tieBreakUseCounts: new Map(counts),
      })!;
    expect(spawn([]).adapterId).toBe('codex');
    const second = spawn([['codex', 1]]);
    expect(second.adapterId).toBe('glm');
    expect(second.reason).toContain('preferência cedeu ao espalhamento');
    expect(spawn([['codex', 1], ['glm', 1]]).adapterId).toBe('codex');
  });

  it('zero explícito no mapa de uso continua sem assento no tier medium', () => {
    const decision = routeTask('mapear o resumo diário',
      adapters('glm', 'deepseek'), DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
        multiScore: false, missionUseCounts: new Map([['glm', 3], ['deepseek', 0]]),
      });
    expect(decision!.adapterId).toBe('deepseek');
    expect(decision!.reason).toContain('rotação garantida');
  });
});
