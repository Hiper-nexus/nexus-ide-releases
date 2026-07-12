import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  invalidateModelCatalogCache,
  loadModelCatalog,
  modelCatalogInfo,
} from '../adapters/model-catalog';
import {
  DEFAULT_ROUTING_TABLE,
  classifyTask,
  routeTask,
  type AdapterAvailability,
} from './task-router';

function adapters(...installed: string[]): AdapterAvailability[] {
  const all = ['claude', 'codex', 'agy', 'grok', 'kimi', 'glm', 'longcat'];
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
    expect(decision!.model).toBe('claude-opus-4-8');
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
    // borrows it from the medium tier (where GLM 5.2 leads).
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('glm'),
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).toContain('melhor opção instalada');
  });

  it('leads the medium tier with GLM 5.2 (cheap + strong)', () => {
    const decision = routeTask(
      'tarefa de complexidade média',
      adapters('claude', 'glm', 'codex'),
      DEFAULT_ROUTING_TABLE,
      'medium',
    );
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.model).toBe('glm-5.2');
  });

  it('uses the configured Kimi model id that exists in kimi-code config.toml', () => {
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      adapters('kimi'),
      DEFAULT_ROUTING_TABLE,
      'easy',
    );
    expect(decision!.adapterId).toBe('kimi');
    expect(decision!.model).toBe('kimi-code/kimi-for-coding');
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
    expect(decision!.model).toBe('claude-opus-4-8');
  });

  it('keeps stronger critical candidates ahead of cheap fallback models', () => {
    const decision = routeTask(
      'auditar a segurança da autenticação e dos pagamentos',
      adapters('claude', 'codex', 'glm'),
    );

    expect(decision!.tier).toBe('critical');
    expect(decision!.adapterId).toBe('claude');
    expect(decision!.model).toBe('claude-opus-4-8');
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

describe('routeTask quality-driven motor (shipped router + real catalog quality)', () => {
  const evaluatedAt = '2026-07-11T21:00:00.000Z';
  const source = 'nexus-eval/v1/fixture';

  /** Catalog with two models whose dimension strengths differ clearly. */
  const qualityCatalog = {
    version: 1,
    adapters: {
      grok: {
        models: [
          {
            id: 'grok-ui-champ',
            availability: 'paid' as const,
            costTier: 'medium' as const,
            quality: {
              overall: 70,
              coding: 60,
              reasoning: 55,
              frontend: 95,
              security: 40,
              evaluatedAt,
              source,
            },
          },
          {
            id: 'grok-sec-champ',
            availability: 'paid' as const,
            costTier: 'medium' as const,
            quality: {
              overall: 72,
              coding: 65,
              reasoning: 70,
              frontend: 40,
              security: 96,
              evaluatedAt,
              source,
            },
          },
          {
            id: 'grok-cheap-ok',
            availability: 'cheap' as const,
            costTier: 'low' as const,
            quality: {
              overall: 68,
              coding: 70,
              reasoning: 50,
              frontend: 50,
              security: 45,
              evaluatedAt,
              source,
            },
          },
          {
            id: 'grok-pricey-slightly-better',
            availability: 'paid' as const,
            costTier: 'high' as const,
            quality: {
              overall: 72,
              coding: 74,
              reasoning: 55,
              frontend: 52,
              security: 48,
              evaluatedAt,
              source,
            },
          },
        ],
      },
    },
  };

  const installedGrok = [
    {
      id: 'grok',
      installed: true,
      models: [
        'grok-ui-champ',
        'grok-sec-champ',
        'grok-cheap-ok',
        'grok-pricey-slightly-better',
      ],
    },
  ];

  it('frontend-tagged task prefers higher frontend quality', () => {
    const decision = routeTask(
      'corrigir o layout da landing page e a interface responsiva do website',
      installedGrok,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      qualityCatalog,
    );
    expect(decision).not.toBeNull();
    expect(decision!.adapterId).toBe('grok');
    expect(decision!.model).toBe('grok-ui-champ');
    expect(decision!.reason).toContain('avaliação Nexus por dimensão');
  });

  it('security-tagged task prefers higher security quality', () => {
    const decision = routeTask(
      'auditar a segurança da autenticação OAuth e tokens de pagamento',
      installedGrok,
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      qualityCatalog,
    );
    expect(decision).not.toBeNull();
    expect(decision!.model).toBe('grok-sec-champ');
    expect(decision!.reason).toContain('avaliação Nexus por dimensão');
  });

  it('easy tier applies cost pressure so slightly better expensive model loses', () => {
    const pair = [
      {
        id: 'grok',
        installed: true,
        models: ['grok-cheap-ok', 'grok-pricey-slightly-better'],
      },
    ];
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      pair,
      DEFAULT_ROUTING_TABLE,
      'easy',
      false,
      qualityCatalog,
    );
    expect(decision).not.toBeNull();
    expect(decision!.model).toBe('grok-cheap-ok');
    expect(decision!.reason).toContain('avaliação Nexus por dimensão');
  });
});

describe('routeTask default catalog path (published eval quality)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    invalidateModelCatalogCache();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('uses loadModelCatalog quality so security work picks higher-security published model', () => {
    // Drive the same merge the shipped default argument uses (BUILTIN+PUBLISHED+user).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-catalog-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'model-catalog.json');
    // Cost-only user overlay — no quality keys (legacy install).
    fs.writeFileSync(
      file,
      JSON.stringify({
        adapters: {
          claude: {
            models: [
              { id: 'claude-opus-4-8', availability: 'paid', costTier: 'high' },
              { id: 'claude-haiku-4-5', availability: 'cheap', costTier: 'low' },
            ],
          },
        },
      }),
    );
    invalidateModelCatalogCache();
    const catalog = loadModelCatalog(file);

    const opusQ = modelCatalogInfo(catalog, 'claude', 'claude-opus-4-8')?.quality;
    const haikuQ = modelCatalogInfo(catalog, 'claude', 'claude-haiku-4-5')?.quality;
    expect(opusQ?.source).toMatch(/^nexus-eval\//);
    expect(haikuQ?.source).toMatch(/^nexus-eval\//);
    expect(opusQ?.security ?? 0).toBeGreaterThan(haikuQ?.security ?? 0);

    const decision = routeTask(
      'auditar a segurança da autenticação OAuth e tokens de pagamento',
      [
        {
          id: 'claude',
          installed: true,
          models: ['claude-opus-4-8', 'claude-haiku-4-5'],
        },
      ],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      catalog,
    );

    expect(decision).not.toBeNull();
    expect(decision!.model).toBe('claude-opus-4-8');
    expect(decision!.reason).toContain('avaliação Nexus por dimensão');
  });
});


