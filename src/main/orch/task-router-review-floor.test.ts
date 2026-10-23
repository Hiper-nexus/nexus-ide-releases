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

  it('F-1342: julgar a ENTREGA de um worker/handoff é revisão de código (regra F-233)', () => {
    for (const text of [
      'audite a entrega da tarefa',
      'audite a entrega do código',
      'avalie a entrega do worker',
      'aprove ou rejeite a entrega do handoff',
      'dar segunda opinião sobre a entrega do worker',
    ]) {
      expect(classifyTask(text).tier, text).toBe('hard');
    }
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

  it('F-767: "qwen3.8-max" casa a família; ids que já casavam continuam', () => {
    // Vários Qwen compartilham o token "qwen3" — sozinho ele não é distintivo,
    // e max/flash/plus/preview são genéricos. Sem partir letra+dígito, nada casa.
    const adapters: AdapterAvailability[] = [
      {
        id: 'qwen',
        installed: true,
        models: ['qwen3.8-max', 'qwen3.8-max-preview', 'qwen3.6-flash', 'qwen3.6-plus'],
      },
      { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
      { id: 'codex', installed: true, models: ['gpt-6.1-sol', 'gpt-6-sol'] },
      { id: 'devin', installed: true, models: ['swe-2-high'] },
      { id: 'mimo-code', installed: true, models: ['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash'] },
      { id: 'muse', installed: true, models: ['muse-spark-1.3'] },
      { id: 'claude', installed: true, models: ['claude-opus-5-5', 'claude-opus-5'] },
    ];
    expect(mentionedRoute('com o qwen3.8-max', adapters).model)
      .toEqual({ adapterId: 'qwen', model: 'qwen3.8-max' });
    expect(mentionedRoute('com o qwen3.6-flash', adapters).model)
      .toEqual({ adapterId: 'qwen', model: 'qwen3.6-flash' });
    expect(mentionedRoute('com o kimi-code/k3', adapters).model)
      .toEqual({ adapterId: 'kimi', model: 'kimi-code/k3' });
    expect(mentionedRoute('com o gpt-6.1-sol', adapters).model)
      .toEqual({ adapterId: 'codex', model: 'gpt-6.1-sol' });
    expect(mentionedRoute('com o swe-2-high', adapters).model)
      .toEqual({ adapterId: 'devin', model: 'swe-2-high' });
    expect(mentionedRoute('com o xiaomi/mimo-v2.6-pro', adapters).model)
      .toEqual({ adapterId: 'mimo-code', model: 'xiaomi/mimo-v2.6-pro' });
    expect(mentionedRoute('com o muse-spark-1.3', adapters).model)
      .toEqual({ adapterId: 'muse', model: 'muse-spark-1.3' });
    expect(mentionedRoute('com o claude-opus-5-5', adapters).model)
      .toEqual({ adapterId: 'claude', model: 'claude-opus-5-5' });
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

  it('correção crítica com achado provado pelo Main vai ao topo high-risk', () => {
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
      { multiScore: true, missionUseCounts: new Map([['claude', 1]]), reviewedFindingFix: true },
    );
    expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5' });
    expect(decision!.reason).toContain('topo entre CLIs (high-risk)');
  });

  it('implementação hard sem achado provado prefere escritor econômico elegível', () => {
    const decision = routeTask(
      'corrigir a race condition na integração entre main e renderer',
      fieldAdapters,
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
    expect(decision!.reason).toContain('purpose=writer');
    expect(decision!.reason).not.toContain('topo entre CLIs');
  });

  it('sem modelo de topo roteável, o ranking não muda', () => {
    // O que o invariante protege (F-214/F-233): sem NENHUM assento de topo
    // roteável o passo de topo não inventa vencedor — vale o ranking do
    // multi-score e o Maestro julga. O fixture original tinha o grok, e o
    // F-779 pôs o grok-4.7 na lane de julgamento DE PROPÓSITO (DeepSWE medido
    // 71,0 = Sonnet 5.5): com ele no pool a premissa "sem topo roteável"
    // deixou de ser verdade. O fixture agora tem só CLIs fora da lane, o que
    // mantém a premissa — e a asserção fica a mesma. O caso do grok é o teste
    // seguinte (política que mudou por decisão, F-817).
    // O K3.1 Pro entrou na lane em 23/10 (teste abaixo do Grok): o Kimi do
    // fixture fica só com o K3, fora dela, para manter a premissa.
    const decision = routeTask(
      FIELD_TEXT,
      inventory(['mimo-code', 'glm', 'kimi']).map((a) =>
        (a.id === 'kimi' ? { ...a, models: ['kimi-code/k3'] } : a)),
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
    expect(decision!.reason).not.toContain('lane de julgamento');
    expect(decision!.judgeUnavailable).toBe(true);
  });

  it('F-779/F-817: com o Grok 4.7 no pool (assento da lane), a revisão vai a ele — decisão de política, não regressão', () => {
    // Antes do F-779 este pool caía no MiMo Pro (ver o teste acima). Mudou de
    // propósito: o operador pediu "usar todas as LLMs" e o Grok 4.7 tem
    // DeepSWE publicado igual ao do Sonnet 5.5, o piso da lane. O Grok é o
    // default da própria CLI (sem prova de acesso extra, ao contrário do
    // Argon). GLM/MiMo seguem fora por experiência do operador (F-233).
    const decision = routeTask(
      FIELD_TEXT,
      inventory(['mimo-code', 'glm', 'kimi', 'grok']).map((a) =>
        (a.id === 'kimi' ? { ...a, models: ['kimi-code/k3'] } : a)),
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      catalog,
      missionHistory,
    );
    expect(decision).toMatchObject({ adapterId: 'grok', model: 'grok-4.7' });
    expect(decision!.reason).toContain('lane de julgamento');
    expect(decision!.judgeUnavailable).toBeUndefined();
  });

  it('23/10: com o Kimi K3.1 Pro no pool (assento da lane), a revisão vai a ele — decisão de política, não regressão', () => {
    // Mesma regra do Grok (F-779): DeepSWE oficial 75,5 ≥ 71,0 do Sonnet 5.5.
    // O K3 (67,5) continua fora — o teste "sem modelo de topo" acima.
    const decision = routeTask(
      FIELD_TEXT,
      inventory(['mimo-code', 'glm', 'kimi']),
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      catalog,
      missionHistory,
    );
    expect(decision).toMatchObject({ adapterId: 'kimi', model: 'kimi-code/k3.1-pro' });
    expect(decision!.reason).toContain('lane de julgamento');
    expect(decision!.judgeUnavailable).toBeUndefined();
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
      { multiScore: true, missionUseCounts: new Map([['claude', 1]]), reviewedFindingFix: true },
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
