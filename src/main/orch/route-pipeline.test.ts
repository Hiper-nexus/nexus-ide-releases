import { describe, expect, it } from 'vitest';
import { loadModelCatalog } from '../adapters/model-catalog';
import {
  countAdapterUses,
  multiScoreRerank,
  scoreRouteCandidate,
} from './route-pipeline';
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

  it('boosts omp under prefer participation', () => {
    const e = entry('omp', 'zai/glm-5');
    const prefer = scoreRouteCandidate(e, 2, {
      tier: 'medium',
      modelCatalog: catalog,
      context: { ompParticipation: 'prefer' },
    });
    const off = scoreRouteCandidate(e, 2, {
      tier: 'medium',
      modelCatalog: catalog,
      context: { ompParticipation: 'off' },
    });
    expect(prefer.omp).toBeGreaterThan(off.omp);
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
      entry('omp', 'zai/glm-5'),
    ];
    const { ranked: out } = multiScoreRerank({
      ranked,
      tier: 'medium',
      modelCatalog: catalog,
      context: { ompParticipation: 'diversity' },
      missionUseCounts: new Map([['codex', 3]]),
    });
    // codex heavily used → diversity attenuation drops it below omp.
    expect(out[0]?.c.adapterId).toBe('omp');
  });

  it('reports the same diversity multiplier used by the score', () => {
    const ranked = [
      entry('codex', 'gpt-5.4'),
      entry('omp', 'zai/glm-5'),
    ];
    const { note } = multiScoreRerank({
      ranked,
      tier: 'medium',
      modelCatalog: catalog,
      context: { ompParticipation: 'diversity' },
      missionUseCounts: new Map([
        ['codex', 1],
        ['omp', 2],
      ]),
    });

    expect(note).toContain('diversity×1');
  });

  it('keeps unused table lead ahead of unused omp under diversity', () => {
    const ranked = [entry('glm', 'glm-5.2'), entry('omp', 'zai/glm-5')];
    const { ranked: out } = multiScoreRerank({
      ranked,
      tier: 'medium',
      modelCatalog: catalog,
      context: {
        ompParticipation: 'diversity',
        missionUsedAdapters: new Set(['claude']),
      },
      missionUseCounts: new Map([['claude', 1]]),
    });
    expect(out[0]?.c.adapterId).toBe('glm');
  });
});

describe('countAdapterUses', () => {
  it('counts occurrences', () => {
    const m = countAdapterUses(['codex', 'omp', 'codex']);
    expect(m.get('codex')).toBe(2);
    expect(m.get('omp')).toBe(1);
  });
});
