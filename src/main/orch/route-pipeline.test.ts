import { describe, expect, it } from 'vitest';
import { loadModelCatalog } from '../adapters/model-catalog';
import {
  buildRouteSuccessIndex,
  countAdapterUses,
  mergeAdapterUseLists,
  multiScoreRerank,
  NEUTRAL_UNPUBLISHED_QUALITY,
  ROUTE_OUTCOME_MIN_SAMPLES,
  ROUTE_OUTCOME_WINDOW_MS,
  routeSuccessRate,
  scoreRouteCandidate,
  tieBreakByUse,
  TIE_MARGIN,
} from './route-pipeline';
import type { ModelCatalog } from '../adapters/model-catalog';
import type { RankedRouteEntry } from './task-router';

const catalog = loadModelCatalog();

function entry(
  adapterId: string,
  model?: string,
  fromTier: RankedRouteEntry['fromTier'] = 'medium',
): RankedRouteEntry {
  return { c: { adapterId, model, effort: 'medium' }, fromTier };
}

describe('scoreRouteCandidate', () => {
  it('não usa quality de fixture no multi-score', () => {
    const fixtureCatalog = {
      adapters: {
        codex: {
          models: [
            {
              id: 'gpt-fixture',
              quality: {
                overall: 100,
                coding: 100,
                evaluatedAt: '2026-07-01T00:00:00.000Z',
                source: 'nexus-eval/v1/fixture',
              },
            },
          ],
        },
      },
    };
    const scored = scoreRouteCandidate(entry('codex', 'gpt-fixture'), 0, {
      tier: 'medium',
      modelCatalog: fixtureCatalog,
    });

    // Fixture não é benchmark oficial nem nexus-eval: a nota é o ponto médio
    // neutro (2×15), não o mínimo antigo (6) nem o 100 mentiroso do fixture.
    expect(scored.quality).toBe(2 * NEUTRAL_UNPUBLISHED_QUALITY);
  });

  it('sem nexus-eval, usa o benchmark oficial publicado (F-675)', () => {
    const published = scoreRouteCandidate(entry('mimo-code', 'xiaomi/mimo-v2.6-pro'), 0, {
      tier: 'hard',
      modelCatalog: catalog,
    });
    const unpublished = scoreRouteCandidate(entry('mimo-code', 'xiaomi/mimo-v2.6-pro-ultraspeed'), 0, {
      tier: 'hard',
      modelCatalog: catalog,
    });
    expect(published.quality).toBeCloseTo(44.4);
    // Sem número publicado: nota neutra (midpoint), acima do piso antigo.
    expect(unpublished.quality).toBe(2 * NEUTRAL_UNPUBLISHED_QUALITY);
    const { note } = multiScoreRerank({
      ranked: [entry('mimo-code', 'xiaomi/mimo-v2.6-pro')],
      tier: 'hard',
      modelCatalog: catalog,
    });
    expect(note).toContain('quality=benchmark-oficial');
    const neutral = multiScoreRerank({
      ranked: [entry('mimo-code', 'xiaomi/mimo-v2.6-pro-ultraspeed')],
      tier: 'hard',
      modelCatalog: catalog,
    });
    expect(neutral.note).toContain('quality=neutra(sem benchmark)');
  });

  it('a distância de tier domina a posição na lista (−10/degrau, −0.5/posição)', () => {
    // Mesmo no fim da fila do tier certo vence o primeiro de um tier distante.
    const nearTail = scoreRouteCandidate(
      entry('minimax-code', 'minimax/MiniMax-M3', 'medium'), 9,
      { tier: 'medium', modelCatalog: catalog },
    );
    const wrongTierHead = scoreRouteCandidate(
      entry('grok', 'grok-sem-benchmark', 'trivial'), 0,
      { tier: 'medium', modelCatalog: catalog },
    );
    expect(nearTail.table).toBe(-4.5);
    // trivial → medium: 2 degraus errados dominam a liderança de posição.
    expect(wrongTierHead.table).toBe(-20);
    expect(nearTail.total).toBeGreaterThan(wrongTierHead.total);
  });

  it('quality: benchmark forte acima do neutro, benchmark fraco abaixo', () => {
    const strong = scoreRouteCandidate(
      entry('mimo-code', 'xiaomi/mimo-v2.6-pro', 'hard'), 0,
      { tier: 'hard', modelCatalog: catalog },
    );
    const weak = scoreRouteCandidate(
      entry('glm', 'glm-4.5-air', 'easy'), 0,
      { tier: 'easy', modelCatalog: catalog },
    );
    expect(strong.quality).toBeGreaterThan(2 * NEUTRAL_UNPUBLISHED_QUALITY);
    expect(weak.quality).toBeLessThan(2 * NEUTRAL_UNPUBLISHED_QUALITY);
  });

  it('tier hard pesa o custo (×1.5); critical mantém o peso leve (×0.5)', () => {
    // glm-5.3 (low → rank 1): custo leve no hard, pesado no trivial.
    const hard = scoreRouteCandidate(entry('glm', 'glm-5.3', 'hard'), 0, {
      tier: 'hard', modelCatalog: catalog,
    });
    const critical = scoreRouteCandidate(entry('glm', 'glm-5.3', 'critical'), 0, {
      tier: 'critical', modelCatalog: catalog,
    });
    const medium = scoreRouteCandidate(entry('glm', 'glm-5.3', 'medium'), 0, {
      tier: 'medium', modelCatalog: catalog,
    });
    expect(hard.cost).toBe(-1.5);
    expect(hard.cost).toBe(medium.cost);
    expect(critical.cost).toBe(-0.5);
  });

  it('hard: notas publicadas a ≤2 pontos → o mais barato vence', () => {
    // claude-opus-5 (q≈21.9, high) vale só 1.5 q acima de glm-5.3
    // (q≈20.4, low): 3 pontos de custo ×1.5 viram o jogo que o peso 0.5
    // antigo dava ao caro.
    const { ranked: out, scored } = multiScoreRerank({
      ranked: [
        entry('glm', 'glm-5.3', 'hard'),
        entry('claude', 'claude-opus-5', 'hard'),
      ],
      tier: 'hard',
      modelCatalog: catalog,
    });
    const glmScore = scored.find((s) => s.c.adapterId === 'glm')!.score;
    const opusScore = scored.find((s) => s.c.adapterId === 'claude')!.score;
    expect(Math.abs(glmScore.quality - opusScore.quality)).toBeLessThanOrEqual(4);
    expect(out[0]?.c.adapterId).toBe('glm');
  });

  it('hard: nota publicada ≥4 pontos acima → o mais forte vence mesmo caro', () => {
    // claude-opus-5-5 (q≈23, high) abre ~9 q sobre glm-4.7 (q≈13.8, low):
    // nem ×1.5 no custo derruba uma diferença real de capacidade.
    const { ranked: out } = multiScoreRerank({
      ranked: [
        entry('glm', 'glm-4.7', 'hard'),
        entry('claude', 'claude-opus-5-5', 'hard'),
      ],
      tier: 'hard',
      modelCatalog: catalog,
    });
    expect(out[0]?.c.adapterId).toBe('claude');
  });

  it('penalizes adapters already used in the mission (diversity)', () => {
    const e = entry('codex', 'gpt-5.4');
    const fresh = scoreRouteCandidate(e, 0, {
      tier: 'medium',
      modelCatalog: catalog,
      context: { missionUsedAdapters: new Set() },
    });
    const used = scoreRouteCandidate(e, 0, {
      tier: 'medium',
      modelCatalog: catalog,
      missionUseCounts: new Map([['codex', 2]]),
    });
    expect(used.diversity).toBeLessThan(fresh.diversity);
    expect(used.total).toBeLessThan(fresh.total);
  });

  it('applies hard penalty when circuit is open', () => {
    const e = entry('kimi');
    const open = scoreRouteCandidate(e, 0, {
      tier: 'medium',
      modelCatalog: catalog,
      circuitOpen: (id) => id === 'kimi',
    });
    expect(open.circuit).toBeLessThan(0);
    expect(open.total).toBeLessThan(-1000);
  });

  it('boosts an explicitly preferred adapter', () => {
    const e = entry('grok', 'grok-4.1');
    const prefer = scoreRouteCandidate(e, 2, {
      tier: 'medium',
      modelCatalog: catalog,
      context: { preferAdapters: ['grok'] },
    });
    const neutral = scoreRouteCandidate(e, 2, {
      tier: 'medium',
      modelCatalog: catalog,
    });
    expect(prefer.preference).toBeGreaterThan(neutral.preference);
  });
});

describe('multiScoreRerank', () => {
  it('skips circuit-open when alternatives exist', () => {
    const ranked = [
      entry('kimi', 'kimi-code/k3'),
      entry('codex', 'gpt-5.4'),
    ];
    const { ranked: out, note } = multiScoreRerank({
      ranked,
      tier: 'medium',
      modelCatalog: catalog,
      circuitOpen: (id) => id === 'kimi',
    });
    expect(out[0]?.c.adapterId).toBe('codex');
    expect(note).toMatch(/circuit-open/);
  });

  it('prefers less-used adapter for diversity', () => {
    const ranked = [
      entry('codex', 'gpt-5.4'),
      entry('grok', 'grok-4.1'),
    ];
    const { ranked: out } = multiScoreRerank({
      ranked,
      tier: 'medium',
      modelCatalog: catalog,
      missionUseCounts: new Map([['codex', 3]]),
    });
    // codex heavily used → diversity attenuation drops it below grok.
    expect(out[0]?.c.adapterId).toBe('grok');
  });

  it('reports the same diversity multiplier used by the score', () => {
    const ranked = [
      entry('codex', 'gpt-5.4'),
      entry('grok', 'grok-4.1'),
    ];
    const { note } = multiScoreRerank({
      ranked,
      tier: 'medium',
      modelCatalog: catalog,
      missionUseCounts: new Map([
        ['codex', 1],
        ['grok', 2],
      ]),
    });

    expect(note).toContain('diversity×1');
  });

  it('a posição na lista é só desempate: benchmark fraco perde para o neutro', () => {
    // glm-5.2 tem benchmark oficial fraco (q≈12.8 → quality≈25.7); grok-4.1
    // não tem número publicado e recebe a neutra (30). O −0.5 de posição não
    // compensa a diferença de qualidade.
    const ranked = [entry('glm', 'glm-5.2'), entry('grok', 'grok-4.1')];
    const { ranked: out } = multiScoreRerank({
      ranked,
      tier: 'medium',
      modelCatalog: catalog,
      context: {
        missionUsedAdapters: new Set(['claude']),
      },
      missionUseCounts: new Map([['claude', 1]]),
    });
    expect(out[0]?.c.adapterId).toBe('grok');
  });

  it('mesma qualidade neutra: o −0.5 de posição decide a ordem', () => {
    const { ranked: out, scored } = multiScoreRerank({
      ranked: [
        entry('grok', 'grok-sem-benchmark'),
        entry('kimi', 'kimi-sem-benchmark'),
      ],
      tier: 'medium',
      modelCatalog: catalog,
    });
    expect(scored[0]!.score.quality).toBe(scored[1]!.score.quality);
    expect(scored[1]!.score.table).toBe(-0.5);
    expect(out[0]?.c.adapterId).toBe('grok');
  });
});

describe('countAdapterUses', () => {
  it('counts occurrences', () => {
    const m = countAdapterUses(['codex', 'grok', 'codex']);
    expect(m.get('codex')).toBe(2);
    expect(m.get('grok')).toBe(1);
  });
});

describe('mergeAdapterUseLists', () => {
  it('soma panes e reservas abertas', () => {
    const merged = mergeAdapterUseLists(['glm'], ['glm', 'kimi']);
    expect(merged?.get('glm')).toBe(2);
    expect(merged?.get('kimi')).toBe(1);
  });

  it('retorna undefined quando não há histórico', () => {
    expect(mergeAdapterUseLists([], undefined)).toBeUndefined();
  });
});

describe('tieBreakByUse', () => {
  // Catálogo vazio: qualidade neutra e custo iguais para todos, então o total
  // só difere pela distância de tier (a posição é index 0 para todos aqui).
  const flat = { adapters: {} } as ModelCatalog;
  const ranked = [entry('grok'), entry('agy'), entry('kimi'), entry('codex')];
  const run = (counts: Record<string, number>) =>
    tieBreakByUse({
      ranked,
      useCounts: new Map(Object.entries(counts)),
      tier: 'medium',
      modelCatalog: flat,
    });

  it('dentro da margem vence a CLI menos usada', () => {
    const out = run({ grok: 1 });
    expect(out.ranked[0]!.c.adapterId).toBe('agy');
    expect(out.note).toContain('desempate');
  });

  it('pula para o terceiro quando o segundo também já está aberto', () => {
    expect(run({ grok: 1, agy: 1 }).ranked[0]!.c.adapterId).toBe('kimi');
  });

  it('posição heurística não exclui uma quarta CLI do mesmo tier', () => {
    expect(TIE_MARGIN).toBe(8);
    const out = run({ grok: 1, agy: 1, kimi: 1 });
    expect(out.ranked[0]!.c.adapterId).toBe('codex');
    expect(out.note).toContain('desempate');
  });

  it('não empresta um tier menor só para variar a CLI', () => {
    const out = tieBreakByUse({
      ranked: [entry('codex', 'strong', 'hard'), entry('grok', 'fast', 'trivial')],
      useCounts: new Map([['codex', 3]]), tier: 'hard', modelCatalog: flat,
    });
    expect(out.ranked[0]!.c.adapterId).toBe('codex');
  });

  it('não escolhe circuito aberto nem gasto muito maior por variedade', () => {
    const out = tieBreakByUse({
      ranked: [entry('grok', 'free'), entry('agy'), entry('claude', 'expensive')],
      useCounts: new Map([['grok', 2]]), tier: 'trivial',
      circuitOpen: (id) => id === 'agy',
      modelCatalog: { adapters: {
        grok: { models: [{ id: 'free', availability: 'free', costTier: 'free' }] },
        claude: { models: [{ id: 'expensive', availability: 'paid', costTier: 'high' }] },
      } },
    });
    expect(out.ranked[0]!.c.adapterId).toBe('grok');
  });

  it('sem contagem ou topo ainda não usado: ordem intacta, mesmo array', () => {
    expect(run({}).ranked).toBe(ranked);
    expect(run({ agy: 2 }).ranked).toBe(ranked);
  });
});

// F-773 (G4): laço de resultado — a nota aprende com o que cada (CLI, modelo)
// entregou de verdade, sem dominar tier, diversidade nem menção.
describe('termo de sucesso 14d (F-773)', () => {
  // Catálogo vazio: qualidade neutra e custo iguais; só posição e sucesso variam.
  const flat = { adapters: {} } as ModelCatalog;
  const outcomes = (rows: Array<[string, string | undefined, number, number]>) =>
    buildRouteSuccessIndex(
      rows.map(([adapterId, model, successes, total]) => ({ adapterId, model, successes, total })),
    );

  it('janela de 14 dias e amostra mínima de 5', () => {
    expect(ROUTE_OUTCOME_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(ROUTE_OUTCOME_MIN_SAMPLES).toBe(5);
  });

  it('CLI com taxa 0,3 (≥5 amostras) perde para uma neutra na mesma posição de tabela', () => {
    const ranked = [entry('grok', 'grok-4.7'), entry('kimi', 'kimi-code/k3')];
    // Sem o laço: a posição (−0,5) mantém o grok na frente.
    expect(multiScoreRerank({ ranked, tier: 'medium', modelCatalog: flat }).ranked[0]?.c.adapterId)
      .toBe('grok');

    const { ranked: out, scored, note } = multiScoreRerank({
      ranked,
      tier: 'medium',
      modelCatalog: flat,
      context: { routeOutcomes: outcomes([['grok', 'grok-4.7', 3, 10]]) },
    });
    expect(out[0]?.c.adapterId).toBe('kimi');
    expect(scored.find((s) => s.c.adapterId === 'grok')!.score.success).toBeCloseTo(-2);
    expect(scored.find((s) => s.c.adapterId === 'kimi')!.score.success).toBe(0);
    expect(note).toContain('sucesso 14d: grok:grok-4.7 0,30 (10)');
  });

  it('abaixo de 5 amostras não há termo (a CLI não é penalizada)', () => {
    const index = outcomes([['grok', 'grok-4.7', 0, ROUTE_OUTCOME_MIN_SAMPLES - 1]]);
    expect(routeSuccessRate(index, 'grok', 'grok-4.7')).toBeNull();
    const { ranked: out, scored, note } = multiScoreRerank({
      ranked: [entry('grok', 'grok-4.7'), entry('kimi', 'kimi-code/k3')],
      tier: 'medium',
      modelCatalog: flat,
      context: { routeOutcomes: index },
    });
    expect(out[0]?.c.adapterId).toBe('grok');
    expect(scored[0]!.score.success).toBe(0);
    expect(note).not.toContain('sucesso 14d');
  });

  it('modelo sem amostra própria usa a taxa da CLI inteira, e o recibo diz isso', () => {
    const index = outcomes([
      ['agy', 'gemini-4-argon', 0, 3],
      ['agy', 'gemini-3.8-flash-high', 1, 4],
    ]);
    // 3 e 4 não bastam por modelo; somados, 7 amostras da CLI (1/7).
    expect(routeSuccessRate(index, 'agy', 'gemini-4-argon')).toEqual({
      rate: 1 / 7,
      samples: 7,
      scope: 'cli',
    });
    const { note } = multiScoreRerank({
      ranked: [entry('agy', 'gemini-4-argon'), entry('kimi', 'kimi-code/k3')],
      tier: 'medium',
      modelCatalog: flat,
      context: { routeOutcomes: index },
    });
    expect(note).toContain('agy:gemini-4-argon 0,14 (7, CLI)');
  });

  it('taxa alta soma; o termo fica entre −35 e +5 (rota falha: −30 de penalidade)', () => {
    const best = scoreRouteCandidate(entry('kimi', 'kimi-code/k3'), 0, {
      tier: 'medium',
      modelCatalog: flat,
      context: { routeOutcomes: outcomes([['kimi', 'kimi-code/k3', 10, 10]]) },
    });
    const worst = scoreRouteCandidate(entry('kimi', 'kimi-code/k3'), 0, {
      tier: 'medium',
      modelCatalog: flat,
      context: { routeOutcomes: outcomes([['kimi', 'kimi-code/k3', 0, 10]]) },
    });
    expect(best.success).toBe(5);
    expect(worst.success).toBe(-35);
  });

  it('rota comprovadamente falha perde o degrau de tier: 0% no tier certo não vence 100% a um degrau', () => {
    const { ranked: out } = multiScoreRerank({
      ranked: [entry('grok', 'grok-4.7', 'medium'), entry('kimi', 'kimi-code/k3', 'hard')],
      tier: 'medium',
      modelCatalog: flat,
      context: {
        routeOutcomes: outcomes([
          ['grok', 'grok-4.7', 0, 10],
          ['kimi', 'kimi-code/k3', 10, 10],
        ]),
      },
    });
    expect(out[0]?.c.adapterId).toBe('kimi');
  });

  it('taxa ruim acima do piso (0,3) não é rota falha: ainda vence a um degrau de distância', () => {
    const { ranked: out } = multiScoreRerank({
      ranked: [entry('grok', 'grok-4.7', 'medium'), entry('kimi', 'kimi-code/k3', 'hard')],
      tier: 'medium',
      modelCatalog: flat,
      context: {
        routeOutcomes: outcomes([
          ['grok', 'grok-4.7', 3, 10],
          ['kimi', 'kimi-code/k3', 10, 10],
        ]),
      },
    });
    expect(out[0]?.c.adapterId).toBe('grok');
  });

  it('não domina: 100% de sucesso não vence a diversidade de quem já tem assento', () => {
    const { ranked: out } = multiScoreRerank({
      ranked: [entry('grok', 'grok-4.7'), entry('kimi', 'kimi-code/k3')],
      tier: 'medium',
      modelCatalog: flat,
      missionUseCounts: new Map([['grok', 1]]),
      context: { routeOutcomes: outcomes([['grok', 'grok-4.7', 10, 10]]) },
    });
    expect(out[0]?.c.adapterId).toBe('kimi');
  });

  it('linha inválida (total 0, sucesso > total) é ignorada', () => {
    const index = buildRouteSuccessIndex([
      { adapterId: 'grok', model: 'grok-4.7', successes: 0, total: 0 },
      { adapterId: 'grok', model: 'grok-4.7', successes: 9, total: 5 },
    ]);
    expect(routeSuccessRate(index, 'grok', 'grok-4.7')).toBeNull();
  });
});
