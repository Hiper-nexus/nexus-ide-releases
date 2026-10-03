import { describe, expect, it } from 'vitest';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { adapterCircuitBreakers } from './circuit-breaker';
import {
  BUILTIN_MODEL_CATALOG,
  mergeModelCatalogs,
  PUBLISHED_MODEL_CATALOG,
} from '../adapters/model-catalog';
import {
  classifyTask,
  DEFAULT_ROUTING_TABLE,
  mentionedRoute,
  routeTask,
  type AdapterAvailability,
} from './task-router';

// Texto REAL do spawn de 27/09: o Jev classificou como trivial e o router
// mandou para grok low — com a política de modelos de topo desligada.
const ASTRA_REVIEW =
  'Revisão de código SÊNIOR (staff), SOMENTE LEITURA, com o modelo GPT-6 Astra ' +
  '(Codex, esforço xhigh), da rodada final G do release 0.76.110 do Nexus IDE antes de publicar.';

/** Inventário builtin COMPLETO (Devin lista gpt-6-astra-*, claude-fable-5-1-*…), só 3 CLIs instaladas. */
function inventory(installed: readonly string[]): AdapterAvailability[] {
  const builtins = BUILTIN_ADAPTERS as ReadonlyArray<{ id: string; models?: { list?: readonly string[] } }>;
  return builtins.map((adapter) => ({
    id: adapter.id,
    installed: installed.includes(adapter.id),
    models: [...(adapter.models?.list ?? [])],
  }));
}
const installed = inventory(['claude', 'codex', 'grok']);

describe('revisão de código: piso hard (bug 27/09; Astra 28/09)', () => {
  it('revisão de código/diff/branch sobe ao piso hard, mesmo somente leitura ou citando CSS/README', () => {
    expect(classifyTask(ASTRA_REVIEW).tier).toBe('hard');
    expect(classifyTask('Code review sênior da branch de release, só leitura').tier).toBe('hard');
    expect(classifyTask('Revisão sênior do diff de código, incluindo CSS e logs; somente leitura').tier).toBe('hard');
    expect(classifyTask('Code review sênior da branch; não altere README nem comentários').tier).toBe('hard');
  });

  it('revisar texto ou coisa que não é código segue no tier normal', () => {
    expect(classifyTask('revisar o texto do README').tier).not.toBe('hard');
    expect(classifyTask('Revisar a lista de compras').tier).not.toBe('hard');
  });

  it('sem modelo citado, a revisão recebe a política de topo (cross-review)', () => {
    const decision = routeTask(
      'Code review sênior da branch de release, só leitura',
      inventory(['claude', 'codex']),
      DEFAULT_ROUTING_TABLE,
    );
    expect(decision!.model).toBe('claude-fable-5-1');
    expect(decision!.reason).toContain('topo=cross-review');
  });
});

describe('modelo e esforço citados no texto (inventário builtin completo)', () => {
  it('honra "com o modelo GPT-6 Astra (Codex, esforço xhigh)" com o Devin não instalado listando astra', () => {
    const decision = routeTask(ASTRA_REVIEW, installed, DEFAULT_ROUTING_TABLE);
    expect(decision).toMatchObject({ tier: 'hard', adapterId: 'codex', model: 'gpt-6-astra', effort: 'xhigh' });
    expect(decision!.reason).toContain('modelo pedido no texto: codex:gpt-6-astra');
    expect(decision!.reason).toContain('source=texto');
  });

  it('grafia humana e id completo: "Claude Fable 5.1" é o 5.1 (não o Fable 5 nem as variantes do Devin)', () => {
    expect(mentionedRoute('Revisão de código com o Claude Fable 5.1 do diff', installed).model)
      .toEqual({ adapterId: 'claude', model: 'claude-fable-5-1' });
    expect(mentionedRoute('rode com claude-sonnet-5', installed).model)
      .toEqual({ adapterId: 'claude', model: 'claude-sonnet-5' });
    expect(mentionedRoute('não quero o Sol; use o Astra', installed).model)
      .toEqual({ adapterId: 'codex', model: 'gpt-6-astra' });
  });

  it('negação, comparação, referência ao autor e nome sem palavra de escolha não pinam nada', () => {
    for (const text of [
      'revisão do diff, mas não use o Astra desta vez',
      'revisão do diff, não use o GPT-6 Astra desta vez',
      'review the diff without gpt-6-astra',
      'Compare gpt-6-astra com Fable',
      'compare o Astra com o Fable',
      'revisão com o Astra e com o Fable',
      'Revise o diff produzido pelo GPT-6 Astra',
      'ajuste rápido no build',
    ]) {
      expect(mentionedRoute(text, installed).model, text).toBeUndefined();
    }
    expect(mentionedRoute('não use esforço low na revisão', installed).effort).toBeUndefined();
    expect(mentionedRoute('revise com esforço high', installed).effort).toBe('high');
  });

  it('F-767: "auto-update" e "descoberta de modelos" não pedem codex-auto-review', () => {
    const phrase = 'preferir a mais nova, alinhar auto-update e descoberta de modelos';
    const withUtility: AdapterAvailability[] = [
      {
        id: 'codex',
        installed: true,
        models: ['codex-auto-review', 'gpt-6-sol', 'gpt-6-luna'],
      },
      { id: 'grok', installed: true, models: ['grok-4'] },
    ];
    expect(mentionedRoute(phrase, withUtility).model).toBeUndefined();
    const decision = routeTask(phrase, withUtility, DEFAULT_ROUTING_TABLE);
    expect(decision?.model).not.toBe('codex-auto-review');
    expect(decision?.reason ?? '').not.toContain('codex-auto-review');
    expect(mentionedRoute('use o codex-auto-review neste diff', withUtility).model)
      .toEqual({ adapterId: 'codex', model: 'codex-auto-review' });
  });

  it('modelo só de CLI ausente vira "indisponível" e não pina', () => {
    const semCodex = inventory(['claude', 'grok']);
    expect(mentionedRoute(ASTRA_REVIEW, semCodex)).toEqual({ unavailable: 'codex:gpt-6-astra', effort: 'xhigh' });
    const decision = routeTask(ASTRA_REVIEW, semCodex, DEFAULT_ROUTING_TABLE);
    expect(decision!.adapterId).not.toBe('codex');
    expect(decision!.reason).toContain('modelo pedido no texto indisponível: codex:gpt-6-astra');
  });
});

describe('topo entre CLIs (F-214 — revisão e critical, 29/09)', () => {
  // Campo: duas revisões sênior foram para mimo-code:xiaomi/mimo-v2.6-pro com
  // o Astra em 2º — benchmarks oficiais saturados + custo decidiram no
  // multi-score, ignorando a política de topo cross-review.
  const FIELD_TEXT =
    'Revisão sênior só-leitura do diff da branch feat/pote-receita-ajuste (migration, tenant)';
  // Catálogo real (BUILTIN+PUBLISHED, sem o overlay de ~/.nexus): é ele que
  // dá o custo que faz o MiMo Pro ganhar na qualidade saturada — um catalogo
  // vazio esconderia o bug.
  const catalog = mergeModelCatalogs(BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG);
  // claude fora do campo; multi-score ligado pelo histórico da missão.
  const fieldAdapters = inventory(['mimo-code', 'codex', 'glm', 'kimi', 'grok']);
  const missionHistory = {
    multiScore: true,
    missionUseCounts: new Map([
      ['glm', 1],
      ['kimi', 1],
    ]),
  };

  it('F-700: revisão sênior em hard sem o claude não sobe ao Astra', () => {
    // Com o Claude reservado ao Maestro, a ordem de topo punha o Astra em toda
    // revisão (20 de 76 workers em 30/09). Sem topo roteável, decide o multi-score.
    const decision = routeTask(
      FIELD_TEXT,
      fieldAdapters,
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      catalog,
      missionHistory,
    );
    expect(decision!.model).not.toMatch(/astra/);
    expect(decision!.reason).not.toContain('topo entre CLIs');
  });

  it('critical sem revisão vai ao topo high-risk (Opus 5.5 quando o claude está instalado)', () => {
    // F-233: 'auditar' virou sinal de revisão (cross-review → lane de
    // julgamento); o texto agora é falha crítica SEM verbo de julgamento.
    const decision = routeTask(
      'corrigir a falha de segurança na autenticação e na migração multi-tenant',
      inventory(['claude', 'mimo-code', 'codex', 'glm', 'kimi']),
      DEFAULT_ROUTING_TABLE,
      'critical',
      false,
      catalog,
      // claude já usado na missão: a diversidade do multi-score derruba o
      // Opus hoje (−18 por uso); o topo entre CLIs o traz de volta.
      { multiScore: true, missionUseCounts: new Map([['claude', 1]]) },
    );
    expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5' });
    expect(decision!.reason).toContain('topo entre CLIs (high-risk)');
  });

  it('hard de alto risco sem revisão NÃO atravessa CLIs — pin do pick de hoje', () => {
    const decision = routeTask(
      'corrigir a race condition na integração entre main e renderer',
      fieldAdapters,
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      catalog,
      missionHistory,
    );
    // Era mimo-pro até o GPT-6.1 Sol: DeepSWE 75,2 (vs 71,9 do MiMo) faz a
    // qualidade saturada vencer o custo no multi-score — o pick mudou pelo
    // modelo novo, NÃO pelo passo entre CLIs (hard high-risk não o dispara).
    expect(decision).toMatchObject({
      adapterId: 'codex',
      model: 'gpt-6.1-sol',
    });
    expect(decision!.reason).not.toContain('topo entre CLIs');
  });

  it('sem modelo de topo roteável, o ranking não muda', () => {
    const decision = routeTask(
      FIELD_TEXT,
      inventory(['mimo-code', 'glm', 'kimi', 'grok']),
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      catalog,
      missionHistory,
    );
    expect(decision).toMatchObject({
      adapterId: 'mimo-code',
      model: 'xiaomi/mimo-v2.6-pro',
    });
    expect(decision!.reason).not.toContain('topo entre CLIs');
  });

  it('modelo citado no texto continua vencendo a política de topo', () => {
    const decision = routeTask(
      `${FIELD_TEXT} — use o gpt-6-luna`,
      fieldAdapters,
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      catalog,
      missionHistory,
    );
    expect(decision).toMatchObject({ adapterId: 'codex', model: 'gpt-6-luna' });
    expect(decision!.reason).toContain('modelo pedido no texto: codex:gpt-6-luna');
  });

  it('F-217: CLI anunciou claude-opus-5-6 — a versão promovida continua no topo high-risk', () => {
    // Mesmo formato do teste critical acima: sem o casamento por linha, o
    // upgrade do F-217 tirava o modelo da FRONTIER_ORDER e a revisão/
    // critical perdia o float (a CLI ainda não tem o id da tabela).
    const withNewer = inventory(['claude', 'mimo-code', 'codex', 'glm', 'kimi']).map(
      (a) =>
        a.id === 'claude'
          ? { ...a, models: ['claude-opus-5-6', ...(a.models ?? [])] }
          : a,
    );
    const decision = routeTask(
      'corrigir a falha de segurança na autenticação e na migração multi-tenant',
      withNewer,
      DEFAULT_ROUTING_TABLE,
      'critical',
      false,
      catalog,
      { multiScore: true, missionUseCounts: new Map([['claude', 1]]) },
    );
    expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-6' });
    expect(decision!.reason).toContain('topo entre CLIs (high-risk)');
  });

  it('F-700: nem o gpt-6.1-astra anunciado pela CLI entra sozinho na rota', () => {
    const withNewer = fieldAdapters.map(
      (a) =>
        a.id === 'codex'
          ? { ...a, models: ['gpt-6.1-astra', ...(a.models ?? [])] }
          : a,
    );
    const decision = routeTask(
      FIELD_TEXT,
      withNewer,
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      catalog,
      {
        multiScore: true,
        missionUseCounts: new Map([
          ['codex', 1],
          ['glm', 1],
          ['kimi', 1],
        ]),
      },
    );
    expect(decision!.model).not.toMatch(/astra/);
  });
});

describe('modelo citado não fura o circuit breaker da CLI', () => {
  it('codex em quarentena: a revisão vai para outro topo e a decisão diz por quê', () => {
    adapterCircuitBreakers.reset('codex');
    for (let i = 0; i < 20 && !adapterCircuitBreakers.isOpen('codex'); i += 1) {
      adapterCircuitBreakers.recordFailure('codex');
    }
    try {
      expect(adapterCircuitBreakers.isOpen('codex')).toBe(true);
      const decision = routeTask(ASTRA_REVIEW, installed, DEFAULT_ROUTING_TABLE);
      expect(decision!.adapterId).not.toBe('codex');
      expect(decision!.reason).toContain('em quarentena (circuit breaker): codex:gpt-6-astra');
    } finally {
      adapterCircuitBreakers.reset('codex');
    }
  });
});
