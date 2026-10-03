import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  routeTask,
  taskNeedsWebSearch,
  type AdapterAvailability,
} from './task-router';

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

describe('taskNeedsWebSearch (F-771)', () => {
  it('reconhece os pedidos de busca/grounding em pt e en', () => {
    for (const task of [
      'faça uma busca na web sobre pnpm',
      'busque na internet a CVE mais recente',
      'pesquise na web o estado da arte em compactação',
      'pesquisa externa sobre preços atuais de GPU',
      'web search for the latest React release',
      'search the web for current pricing',
      'levante o estado da arte em embeddings',
      'confira as versões atuais das dependências',
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
});
