import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  routeTask,
  taskContextRequirement,
  taskNeedsWebSearch,
  type AdapterAvailability,
} from './task-router';
import type { ModelCatalog } from '../adapters/model-catalog';

// F-771 (G3): eixo de capacidade. Tarefa que pede busca na web só roda em
// CLI que DECLARA `capabilities.webSearch` — antes, duas pesquisas reais
// foram para muse/mimo-code (rota free) e o MiMo respondeu "WebSearch
// indisponível neste pane". Sem nenhum adapter declarando a capacidade, o
// pool não é tocado: ausência de declaração nunca derruba a rota.
const glm: AdapterAvailability = {
  id: 'glm',
  installed: true,
  models: ['glm-5.3'],
};
const muse: AdapterAvailability = {
  id: 'muse',
  installed: true,
  models: ['muse-spark-1.3'],
};
const grokWithSearch: AdapterAvailability = {
  id: 'grok',
  installed: true,
  models: ['grok-4.7'],
  capabilities: { webSearch: true },
};
const kimiWithSearch: AdapterAvailability = {
  id: 'kimi',
  installed: true,
  models: ['kimi-code/k3'],
  capabilities: { webSearch: true },
};
const claudeWithSearch: AdapterAvailability = {
  id: 'claude',
  installed: true,
  models: ['claude-sonnet-5-5'],
  capabilities: { webSearch: true },
};
const codexWithoutSearch: AdapterAvailability = {
  id: 'codex',
  installed: true,
  models: ['gpt-6-luna', 'gpt-6-sol'],
  // O perfil governado do Codex roda com standalone_web_search=false
  // (cli-mcp-session-codex) — sem manifest, sem flag: não é declarado.
  capabilities: { webSearch: false, readOnlyEnforceable: true, handoffMcp: true },
};

const SEARCH_TASK = 'fazer busca na web sobre as versões atuais do TypeScript';

const route = (pool: AdapterAvailability[], task = SEARCH_TASK) =>
  routeTask(task, pool, DEFAULT_ROUTING_TABLE, 'medium', false, undefined, {
    multiScore: false,
  });

describe('taskNeedsWebSearch (F-771, F-819)', () => {
  it('reconhece os pedidos de busca/grounding em pt e en (sempre com verbo de busca)', () => {
    for (const task of [
      'faça uma busca na web sobre pnpm',
      'busque na internet a CVE mais recente',
      'pesquise na web o estado da arte em compactação',
      'pesquisa externa sobre preços atuais de GPU',
      'procure online a documentação oficial do vite',
      'consulte a internet sobre a CVE de ontem',
      'Pesquise na Web as novidades do Node',
      'web search for the latest React release',
      'search the web for current pricing',
      'perform a web search on the new API',
      'levante o estado da arte em embeddings',
      'pesquise as versões atuais das dependências',
      'pesquise sobre o estado da arte em hooks',
      'busque a documentação atualizada do Prisma',
      'search for the latest version of vite',
      'look up the current pricing of the API',
      'research the state of the art in retrieval',
      'fazer busca na web sobre as versões atuais do TypeScript',
    ]) {
      expect(taskNeedsWebSearch(task), task).toBe(true);
    }
  });

  it('não dispara em trabalho comum sem pedido de dado vivo', () => {
    for (const task of [
      'corrigir o bug do login',
      'tarefa média qualquer',
      'pesquise o código e ache onde o token é validado',
      'atualize a dependência para a versão do package.json',
    ]) {
      expect(taskNeedsWebSearch(task), task).toBe(false);
    }
  });

  // F-819: frases soltas de dado vivo, sem verbo de busca, são texto comum de
  // código — os 4 exemplos da revisão ec8524a8 e vizinhos.
  it('"versão atual" e "estado da arte" soltos NÃO pedem busca na web', () => {
    for (const task of [
      'a versão atual do app trava ao abrir o login',
      'compare a versão atual com a anterior e corrija a regressão',
      'confira se a versão atual do schema bate com a migração',
      'refatore usando o estado da arte em hooks do React',
      'confira as versões atuais das dependências',
      'the current version of the schema does not match the migration',
      'upgrade to the latest version of react in package.json',
      'fix the latest release build that fails on CI',
      'atualize a documentação atualizada no README',
      'implemente a web search do portal',
      'make a web search endpoint for the admin',
      'procure no código a versão atual da função',
      'consulte a versão atual do schema no banco',
      'the app shows recent news on the home screen',
    ]) {
      expect(taskNeedsWebSearch(task), task).toBe(false);
    }
  });

  it('F-819: varredura linear em texto grande e adversarial (16 KB, teto de 50 ms)', () => {
    const SIZE = 16_384;
    const inputs: Array<[string, string]> = [
      ['espaços sem fim', ' '.repeat(SIZE)],
      ['"pesquise" + espaços', `pesquise${' '.repeat(SIZE - 8)}`],
      ['"pesquise o" + espaços', `pesquise o${' '.repeat(SIZE - 10)}`],
      ['verbo repetido sem alvo', 'pesquise '.repeat(SIZE / 9)],
      ['verbo + ligações repetidas', 'busque sobre o as '.repeat(SIZE / 18)],
      ['"search" repetido', 'search the '.repeat(SIZE / 11)],
      ['"estado da" repetido', 'estado da '.repeat(SIZE / 10)],
      ['"web" + hífens', `web${'-'.repeat(SIZE - 3)}`],
      ['"versão" + espaços', `versão${' '.repeat(SIZE - 6)}`],
      ['tabs e espaços', '\t \t '.repeat(SIZE / 4)],
    ];
    for (const [label, text] of inputs) {
      taskNeedsWebSearch(text); // aquece
      const startedAt = performance.now();
      const hit = taskNeedsWebSearch(text);
      const elapsedMs = performance.now() - startedAt;
      expect(hit, label).toBe(false);
      expect(elapsedMs, label).toBeLessThan(50);
    }
  });
});

describe('filtro de capacidade webSearch (F-771)', () => {
  it('com um capaz instalado, quem não declara a flag sai do pool', () => {
    const decision = route([glm, grokWithSearch, muse]);
    // glm lidera o medium na tabela; sem a flag ele nem é alternativa.
    expect(decision!.adapterId).toBe('grok');
    expect(decision!.reason).toContain('busca na web');
    expect(
      decision!.alternatives.every((alt) => alt.adapterId !== 'glm'),
    ).toBe(true);
  });

  it('tarefa de busca nunca vai para o Codex governado quando há CLI com a flag', () => {
    const decision = route([codexWithoutSearch, kimiWithSearch]);
    expect(decision!.adapterId).toBe('kimi');
    expect(
      decision!.alternatives.every((alt) => alt.adapterId !== 'codex'),
    ).toBe(true);
  });

  it('fail-open: ninguém declara a capacidade → pool e ordem intactos', () => {
    const decision = route([glm, muse]);
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).toContain('nenhum adapter declara');
  });

  it('sem pedido de busca a flag não promove ninguém', () => {
    const decision = route([glm, grokWithSearch], 'tarefa média qualquer');
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).not.toContain('busca na web');
  });

  // F-819: "versão atual" solta num bug comum tirava Codex e GLM do pool e
  // mandava o trabalho para o Kimi (rota de ponta e cara).
  it('bug com "versão atual" solta NÃO limita o pool às CLIs de busca', () => {
    const pool: AdapterAvailability[] = [codexWithoutSearch, glm, claudeWithSearch, kimiWithSearch];
    const common = route(pool, 'a versão atual do app trava ao abrir o login; corrija');
    expect(common!.adapterId).toBe('glm');
    expect(common!.reason).not.toContain('busca na web');
    expect(common!.alternatives.some((alt) => alt.adapterId === 'codex')).toBe(true);
    // Mesmo texto com pedido explícito de busca continua filtrando.
    const searching = route(
      pool,
      'pesquise na web a versão atual do app e corrija o login',
    );
    expect(searching!.reason).toContain('busca na web');
    expect(['claude', 'kimi']).toContain(searching!.adapterId);
  });
});

// F-912 (02/G3): eixo de janela de contexto. `maxContext` só é filtrado quando
// DOCUMENTADO (catálogo do modelo ou manifest do adapter) e a tarefa DECLARA
// um mínimo explícito — ausência de dado em qualquer lado não exclui nada.
const CONTEXT_TASK = 'analise o monorepo inteiro com contexto de 200k tokens e corrija o drift do schema';
const grokPlain: AdapterAvailability = { id: 'grok', installed: true, models: ['grok-4.7'] };
// Janela documentada só para o glm — grok fica sem fonte (fail-open por modelo).
const CONTEXT_CATALOG: ModelCatalog = {
  version: 1,
  adapters: {
    glm: {
      models: [
        { id: 'glm-5.3', availability: 'paid', costTier: 'low', source: 'fixture', maxContext: 131_072 },
      ],
    },
    grok: {
      models: [
        { id: 'grok-4.7', availability: 'paid', costTier: 'high', source: 'fixture', maxContext: 400_000 },
      ],
    },
  },
};

const routeWithContext = (pool: AdapterAvailability[], task: string, catalog: ModelCatalog) =>
  routeTask(task, pool, DEFAULT_ROUTING_TABLE, 'medium', false, catalog, {
    multiScore: false,
  });

describe('taskContextRequirement (F-912)', () => {
  it('extrai pedidos explícitos de janela em pt e en', () => {
    expect(taskContextRequirement('analise o dump com contexto de 1M tokens')).toBe(1_000_000);
    expect(taskContextRequirement('janela de 500k para o refactor')).toBe(500_000);
    expect(taskContextRequirement('needs a 2M-token context')).toBe(2_000_000);
    expect(taskContextRequirement('process the log with window of 250k tokens')).toBe(250_000);
    expect(taskContextRequirement('carregue os 200000 tokens de entrada')).toBe(200_000);
    expect(taskContextRequirement('contexto de 1,5M tokens')).toBe(1_500_000);
  });

  it('sem declaração explícita não exige nada (null)', () => {
    for (const task of [
      'corrigir o bug do login',
      'refactor de 5k linhas',
      'arquivos grandes do monorepo',
      'a versão atual trava com 3 threads',
    ]) {
      expect(taskContextRequirement(task), task).toBeNull();
    }
  });

  it('fica com o maior pedido quando a tarefa declara mais de um', () => {
    expect(
      taskContextRequirement('comece com contexto de 100k e suba para 1M tokens'),
    ).toBe(1_000_000);
  });
});

describe('filtro de janela de contexto maxContext (F-912)', () => {
  it('exclui do ranking o candidato com janela documentada menor que a exigida', () => {
    const decision = routeWithContext([glm, grokPlain], CONTEXT_TASK, CONTEXT_CATALOG);
    // glm lidera o medium, mas 131072 < 200000: sai da rota E das alternativas.
    expect(decision!.adapterId).toBe('grok');
    expect(decision!.model).toBe('grok-4.7');
    expect(decision!.reason).toContain('exige contexto');
    expect(decision!.reason).toContain('glm:glm-5.3');
    expect(
      decision!.alternatives.every((alt) => alt.adapterId !== 'glm'),
    ).toBe(true);
  });

  it('fail-open: sem maxContext documentado no catálogo ninguém é excluído', () => {
    const noWindowCatalog: ModelCatalog = {
      version: 1,
      adapters: {
        glm: { models: [{ id: 'glm-5.3', availability: 'paid', costTier: 'low', source: 'fixture' }] },
        grok: { models: [{ id: 'grok-4.7', availability: 'paid', costTier: 'high', source: 'fixture' }] },
      },
    };
    const decision = routeWithContext([glm, grokPlain], CONTEXT_TASK, noWindowCatalog);
    expect(decision!.adapterId).toBe('glm');
  });

  it('tarefa sem declaração de contexto não mexe no ranking', () => {
    const decision = routeWithContext([glm, grokPlain], 'corrija o drift do schema', CONTEXT_CATALOG);
    expect(decision!.adapterId).toBe('glm');
    expect(decision!.reason).not.toContain('exige contexto');
  });

  it('usa o maxContext do manifest do adapter quando o modelo não declara', () => {
    const glmSmallWindow: AdapterAvailability = {
      ...glm,
      capabilities: { maxContext: 131_072 },
    };
    const decision = routeWithContext(
      [glmSmallWindow, grokPlain],
      'contexto de 200k tokens para a análise do drift',
      { version: 1, adapters: {} },
    );
    expect(decision!.adapterId).toBe('grok');
  });

  it('pedido além de toda janela documentada não deixa a rota sem destino', () => {
    const decision = routeWithContext(
      [glm, grokPlain],
      'analise tudo com contexto de 5M tokens',
      CONTEXT_CATALOG,
    );
    expect(decision).not.toBeNull();
    expect(decision!.reason).toContain('exige contexto');
    expect(decision!.reason).toContain('nenhum candidato da tabela instalado');
  });
});
