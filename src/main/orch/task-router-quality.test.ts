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
  resolveRoutableModel,
  routeTask,
  type AdapterAvailability,
} from './task-router';

function adapters(...installed: string[]): AdapterAvailability[] {
  const all = [
    'claude',
    'codex',
    'agy',
    'grok',
    'kimi',
    'glm',
    'longcat',
  ];
  return all.map((id) => ({ id, installed: installed.includes(id) }));
}

describe('diversidade com cobertura parcial de avaliação (regressão: só codex/grok)', () => {
  // Runtime real: tools-domain passa a lista de models descoberta por CLI e
  // kimi/agy não têm nota nexus-eval no catálogo default. A avaliação só pode
  // pré-emptar a tabela de diversidade quando TODO adapter instalado tem ≥1
  // modelo avaliado; com cobertura parcial, a tabela manda.
  const liveAdapters: AdapterAvailability[] = [
    {
      id: 'claude',
      installed: true,
      models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
    },
    { id: 'codex', installed: true, models: ['gpt-5.5', 'gpt-5.4'] },
    { id: 'grok', installed: true, models: ['grok-4.1', 'grok-4-fast'] },
    { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
    {
      id: 'agy',
      installed: true,
      models: ['gemini-3.1-pro-high', 'gemini-3.5-flash-low'],
    },
  ];

  it('worker medium segue a tabela (kimi lidera sem glm/longcat), não colapsa em codex/grok', () => {
    const decision = routeTask(
      'tarefa de complexidade média',
      liveAdapters,
      DEFAULT_ROUTING_TABLE,
      'medium',
      true,
    );
    expect(decision!.adapterId).toBe('kimi');
    expect(decision!.model).toBe('kimi-code/k3');
    expect(decision!.reason).not.toContain('avaliação Nexus por dimensão');
  });

  it('worker easy segue a tabela (kimi lidera o tier easy)', () => {
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      liveAdapters,
      DEFAULT_ROUTING_TABLE,
      'easy',
      true,
    );
    expect(decision!.adapterId).toBe('kimi');
  });
});

describe('quality de fixture nunca pre-empta diversidade (RC1)', () => {
  it('mantém a ordem da tabela mesmo quando todos os adapters têm score fixture', () => {
    const evaluatedAt = '2026-07-11T21:00:00.000Z';
    const fixtureCatalog = {
      version: 1,
      adapters: {
        codex: {
          models: [
            {
              id: 'gpt-5.4',
              availability: 'paid' as const,
              costTier: 'medium' as const,
              quality: {
                overall: 99,
                coding: 99,
                evaluatedAt,
                source: 'nexus-eval/v1/fixture',
              },
            },
          ],
        },
        kimi: {
          models: [
            {
              id: 'kimi-code/k3',
              availability: 'cheap' as const,
              costTier: 'low' as const,
              quality: {
                overall: 10,
                coding: 10,
                evaluatedAt,
                source: 'nexus-eval/v1/fixture',
              },
            },
          ],
        },
      },
    };

    const decision = routeTask(
      'tarefa de complexidade média',
      [
        { id: 'codex', installed: true, models: ['gpt-5.4'] },
        {
          id: 'kimi',
          installed: true,
          models: ['kimi-code/k3'],
        },
      ],
      DEFAULT_ROUTING_TABLE,
      'medium',
      true,
      fixtureCatalog,
    );

    // No tier medium, Kimi vem antes de Codex. Fixture é dado de teste, não
    // evidência publicada capaz de derrubar a política de diversidade.
    expect(decision).toMatchObject({
      adapterId: 'kimi',
      model: 'kimi-code/k3',
    });
    expect(decision!.reason).not.toContain('avaliação Nexus por dimensão');
  });
});

describe('tier critical com diversidade instalada', () => {
  it('kimi/agy são candidatos do próprio tier critical (sem empréstimo)', () => {
    // Ambos estão no próprio tier critical. A especialidade security empurra
    // kimi (prior heurístico) à frente de agy; o que este teste trava é a
    // ausência de empréstimo de tier mais barato.
    const decision = routeTask(
      'auditar a segurança da autenticação',
      adapters('kimi', 'agy'),
    );
    expect(decision!.tier).toBe('critical');
    // Security prior lists kimi ahead of agy; both remain native critical
    // candidates (no cheaper-tier borrow).
    expect(decision!.adapterId).toBe('kimi');
    expect(decision!.specialty).toBe('security');
    expect(decision!.reason).not.toContain('melhor opção instalada');
  });

  it('kimi sozinho também é candidato do próprio tier critical', () => {
    const decision = routeTask(
      'auditar a segurança da autenticação',
      adapters('kimi'),
    );
    expect(decision!.adapterId).toBe('kimi');
    expect(decision!.reason).not.toContain('melhor opção instalada');
  });

  it('agy também é candidato do próprio tier critical', () => {
    const decision = routeTask(
      'auditar a segurança da autenticação',
      adapters('agy'),
    );
    expect(decision!.tier).toBe('critical');
    expect(decision!.adapterId).toBe('agy');
    expect(decision!.model).toBe('gemini-3.1-pro-high');
    expect(decision!.reason).not.toContain('melhor opção instalada');
  });
});

describe('gate de cobertura da avaliação — bordas', () => {
  it('adapter sem lista de models conta como NÃO coberto (tabela manda)', () => {
    // claude sem models descobertos + grok/codex avaliados: cobertura parcial,
    // então worker easy segue a tabela (kimi lidera) em vez do rank avaliado.
    const decision = routeTask(
      'corrigir typo no README do projeto agora',
      [
        { id: 'claude', installed: true },
        { id: 'grok', installed: true, models: ['grok-4.1', 'grok-4-fast'] },
        { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
      ],
      DEFAULT_ROUTING_TABLE,
      'easy',
      true,
    );
    expect(decision!.adapterId).toBe('kimi');
    expect(decision!.reason).not.toContain('avaliação Nexus por dimensão');
  });

  it('adapter cujo único modelo avaliado está bloqueado para auto-rota conta como NÃO coberto', () => {
    const evaluatedAt = '2026-07-11T21:00:00.000Z';
    const catalog = {
      version: 1,
      adapters: {
        grok: {
          models: [
            {
              id: 'grok-4.1',
              availability: 'paid' as const,
              costTier: 'medium' as const,
              quality: {
                overall: 90,
                coding: 90,
                evaluatedAt,
                source: 'nexus-eval/v1/test',
              },
            },
          ],
        },
        kimi: {
          models: [
            {
              // Avaliado, porém api-only: bloqueado para auto-rota — não pode
              // contar como cobertura, senão o gate liga sem candidato real.
              id: 'kimi-code/k3',
              availability: 'api-only' as const,
              costTier: 'low' as const,
              quality: {
                overall: 80,
                coding: 80,
                evaluatedAt,
                source: 'nexus-eval/v1/test',
              },
            },
          ],
        },
      },
    };
    const decision = routeTask(
      'tarefa de complexidade média',
      [
        { id: 'grok', installed: true, models: ['grok-4.1'] },
        { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
      ],
      DEFAULT_ROUTING_TABLE,
      'medium',
      true,
      catalog,
    );
    expect(decision!.reason).not.toContain('avaliação Nexus por dimensão');
  });
});

describe('routeTask quality-driven motor (shipped router + real catalog quality)', () => {
  const evaluatedAt = '2026-07-11T21:00:00.000Z';
  const source = 'nexus-eval/v1/router-quality-test';

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

describe('routeTask default catalog path (no published eval quality)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    invalidateModelCatalogCache();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('falls back to the diversity table when the shipped catalog carries no quality', () => {
    // Fixture scores foram removidos de resources/model-catalog.json: até uma
    // avaliação real ser publicada, o catálogo default (BUILTIN + PUBLISHED +
    // overlay legado do usuário) não tem quality, o coverage gate fica off e
    // a TABELA de diversidade decide — exatamente o comportamento do gate.
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

    // Pré-requisito do teste: sem quality publicada (volta a ter quando uma
    // avaliação real for publicada — aí este teste deve ser revisto).
    expect(
      modelCatalogInfo(catalog, 'claude', 'claude-opus-4-8')?.quality,
    ).toBeUndefined();

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
    // Tabela hard com só claude instalado: claude-opus-4-8 é o 1º candidato.
    expect(decision!.model).toBe('claude-opus-4-8');
    expect(decision!.reason).not.toContain('avaliação Nexus por dimensão');
  });
});



describe('resolveRoutableModel — modelo real, sem fantasma', () => {
  it('usa o modelo exato quando o adapter o lista', () => {
    expect(
      resolveRoutableModel('gpt-5.6-sol', ['gpt-5.6-sol', 'gpt-5.5']),
    ).toEqual({ ok: true, model: 'gpt-5.6-sol' });
  });

  it('mapeia geração renomeada para a 1ª variante de família (gpt-5.6 → gpt-5.6-sol)', () => {
    // Caso de campo: a tabela pede gpt-5.6, mas o CLI só tem as variantes.
    expect(
      resolveRoutableModel('gpt-5.6', ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5']),
    ).toEqual({ ok: true, model: 'gpt-5.6-sol' });
  });

  it('descarta o candidato quando nenhuma variante da família existe', () => {
    expect(resolveRoutableModel('gpt-5.6', ['gpt-5.5', 'gpt-5.4'])).toEqual({
      ok: false,
    });
    expect(resolveRoutableModel('gpt-5.6', ['gpt-5.6-malicious'])).toEqual({
      ok: false,
    });
  });

  it('sem lista de modelos confia na tabela (não há como validar)', () => {
    expect(resolveRoutableModel('gpt-5.6', undefined)).toEqual({
      ok: true,
      model: 'gpt-5.6',
    });
    expect(resolveRoutableModel('gpt-5.6', [])).toEqual({
      ok: true,
      model: 'gpt-5.6',
    });
  });

  it('sem modelo pedido não impõe modelo (default do adapter)', () => {
    expect(resolveRoutableModel(undefined, ['gpt-5.5'])).toEqual({
      ok: true,
      model: undefined,
    });
  });
});

describe('routeTask nunca emite modelo que o codex instalado não roda', () => {
  it('roteia hard para a variante real gpt-5.6-sol, não o fantasma gpt-5.6', () => {
    // Catálogo sem quality: força o caminho da TABELA (a avaliação por
    // dimensão fica vazia), que é o que este teste exercita.
    const tableOnlyCatalog = {
      version: 1,
      adapters: {
        codex: {
          models: [
            {
              id: 'gpt-5.6-sol',
              availability: 'paid' as const,
              costTier: 'high' as const,
            },
          ],
        },
      },
    };
    const decision = routeTask(
      'refatorar o motor de orquestração para performance',
      [
        {
          id: 'codex',
          installed: true,
          // Espelha o cache real do CLI: sem bare gpt-5.6.
          models: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],
        },
      ],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      tableOnlyCatalog,
    );
    expect(decision).not.toBeNull();
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.model).toBe('gpt-5.6-sol');
  });

  it('mapeia o fantasma gpt-5.6 da tabela para a variante real quando a tabela ainda usa o id antigo', () => {
    // Robustez: mesmo que a tabela volte a apontar gpt-5.6 (rename futuro),
    // o roteador resolve para a variante que o CLI realmente lista.
    const legacyTable = {
      ...DEFAULT_ROUTING_TABLE,
      hard: [{ adapterId: 'codex', model: 'gpt-5.6', effort: 'high' }],
    };
    const decision = routeTask(
      'refatorar o motor de orquestração para performance',
      [
        {
          id: 'codex',
          installed: true,
          models: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5'],
        },
      ],
      legacyTable,
      'hard',
      false,
      {
        version: 1,
        adapters: {
          codex: {
            models: [
              { id: 'gpt-5.6-sol', availability: 'paid' as const, costTier: 'high' as const },
            ],
          },
        },
      },
    );
    expect(decision!.adapterId).toBe('codex');
    expect(decision!.model).toBe('gpt-5.6-sol');
  });
})
