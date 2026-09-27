import { describe, expect, it } from 'vitest';
import { loadModelCatalog } from '../adapters/model-catalog';
import {
  countAdapterUses,
  mergeAdapterUseLists,
  multiScoreRerank,
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

    expect(scored.quality).toBe(6);
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

  it('keeps an unused table lead ahead of another unused adapter', () => {
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
    expect(out[0]?.c.adapterId).toBe('glm');
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
  // Catálogo vazio: qualidade e custo iguais para todos, então o total só
  // difere pela posição na tabela (60, 56, 52, 48…).
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
