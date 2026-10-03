import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRouteLog,
  recentRouteLog,
  recordRouteLog,
  type RouteLogEntry,
  type RouteLogSink,
} from './route-log';

function input(overrides: Partial<Parameters<typeof recordRouteLog>[0]> = {}) {
  return {
    task: 'tarefa de teste',
    tier: 'medium',
    adapterId: 'kimi',
    model: 'kimi-code/kimi-for-coding',
    effort: 'medium',
    reason: 'medium; sinais: teste',
    ...overrides,
  };
}

describe('route log', () => {
  beforeEach(() => clearRouteLog());

  it('starts empty', () => {
    expect(recentRouteLog()).toEqual([]);
  });

  it('records a decision with its reason and a monotonic seq', () => {
    const e1 = recordRouteLog(input());
    const e2 = recordRouteLog(input({ adapterId: 'agy' }));
    expect(e2.seq).toBeGreaterThan(e1.seq);
    const recent = recentRouteLog();
    expect(recent[0].adapterId).toBe('agy'); // most-recent-first
    expect(recent[1].adapterId).toBe('kimi');
    expect(recent[0].reason).toContain('sinais');
  });

  it('truncates the task preview but keeps the reason', () => {
    const long = 'x'.repeat(500);
    const e = recordRouteLog(input({ task: long, reason: 'r'.repeat(500) }));
    expect(e.taskPreview.length).toBe(120);
    expect(e.reason.length).toBe(500);
  });

  it('caps the retained history at 50 (drops oldest)', () => {
    for (let i = 0; i < 60; i += 1) {
      recordRouteLog(input({ task: `t${i}` }));
    }
    const recent = recentRouteLog(1000);
    expect(recent.length).toBe(50);
    expect(recent[0].taskPreview).toBe('t59');
    expect(recent[recent.length - 1].taskPreview).toBe('t10');
  });

  it('limit clamps the returned slice', () => {
    for (let i = 0; i < 5; i += 1) recordRouteLog(input({ task: `t${i}` }));
    expect(recentRouteLog(3).length).toBe(3);
    expect(recentRouteLog(0)).toEqual([]);
  });

  it('preserva model e effort opcionais', () => {
    recordRouteLog(input({ model: 'glm-5.2', effort: 'high' }));
    expect(recentRouteLog()[0]).toMatchObject({ model: 'glm-5.2', effort: 'high' });
  });

  it('model/effort ausentes ficam undefined', () => {
    recordRouteLog({ task: 't', tier: 'easy', adapterId: 'kimi', reason: 'r' });
    const e = recentRouteLog()[0];
    expect(e.model).toBeUndefined();
    expect(e.effort).toBeUndefined();
  });

  it('guarda confiança e ruleChoice só como ids e números, sem carregar o que não é recibo', () => {
    recordRouteLog({
      task: 'segredo do cliente',
      tier: 'medium',
      adapterId: 'claude',
      reason: 'r',
      classifierSource: 'jev',
      confidence: { tier: 0.82, specialty: 0.71, task: 'segredo do cliente' } as never,
      ruleChoice: { adapterId: 'glm', model: 'glm-5.3', reason: 'sinais: segredo' } as never,
    });
    const entry = recentRouteLog()[0];
    expect(entry.confidence).toEqual({ tier: 0.82, specialty: 0.71 });
    expect(entry.ruleChoice).toEqual({ adapterId: 'glm', model: 'glm-5.3' });
    expect(JSON.stringify([entry.confidence, entry.ruleChoice])).not.toContain('segredo');
  });

  it('"same" fica como está e as chaves ausentes não aparecem', () => {
    recordRouteLog(input({ ruleChoice: 'same' }));
    expect(recentRouteLog()[0].ruleChoice).toBe('same');
    recordRouteLog(input());
    const plain = recentRouteLog()[0];
    expect(plain).not.toHaveProperty('confidence');
    expect(plain).not.toHaveProperty('ruleChoice');
  });

  it('guarda classifierSource e jevUnavailable quando informados', () => {
    clearRouteLog();
    recordRouteLog({
      task: 't',
      tier: 'medium',
      adapterId: 'codex',
      reason: 'r',
      classifierSource: 'heuristic',
      jevUnavailable: 'no-key',
    });
    expect(recentRouteLog()[0]).toMatchObject({
      classifierSource: 'heuristic',
      jevUnavailable: 'no-key',
    });
  });
});

// F-773 (G6): a linha também vai para um coletor durável; a memória fica
// como fallback quando ele falha ou não existe.
describe('route log com coletor persistente (F-773)', () => {
  beforeEach(() => clearRouteLog());

  const memorySink = () => {
    const rows: RouteLogEntry[] = [];
    const sink: RouteLogSink = {
      append: (entry) => {
        rows.push({ ...entry, seq: rows.length + 1000, at: 42 });
      },
      recent: (limit) => [...rows].reverse().slice(0, limit),
    };
    return { rows, sink };
  };

  it('grava no coletor e lê dele (sobrevive ao clear da memória, como num restart)', () => {
    const { rows, sink } = memorySink();
    recordRouteLog(input({ adapterId: 'grok', missionId: 'mission-1' }), sink);
    expect(rows).toHaveLength(1);
    clearRouteLog();
    expect(recentRouteLog()).toEqual([]);
    expect(recentRouteLog(10, sink)).toMatchObject([
      { adapterId: 'grok', missionId: 'mission-1', at: 42, seq: 1000 },
    ]);
  });

  it('coletor que falha na escrita não derruba a rota e a memória guarda a linha', () => {
    const broken: RouteLogSink = {
      append: () => {
        throw new Error('disco cheio');
      },
      recent: () => {
        throw new Error('banco fechado');
      },
    };
    const entry = recordRouteLog(input({ adapterId: 'kimi' }), broken);
    expect(entry.adapterId).toBe('kimi');
    expect(recentRouteLog(10, broken)).toMatchObject([{ adapterId: 'kimi' }]);
  });

  it('alternativas: só ids de CLI/modelo, na ordem, com teto de 12', () => {
    const alternatives = [
      { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'high', reason: 'texto livre' },
      { adapterId: '', model: 'sem-cli' },
      { model: 'sem-adapter' },
      ...Array.from({ length: 20 }, (_, i) => ({ adapterId: `cli-${i}` })),
    ];
    const entry = recordRouteLog(input({ alternatives }));
    expect(entry.alternatives?.[0]).toEqual({ adapterId: 'kimi', model: 'kimi-code/k3' });
    expect(entry.alternatives?.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(entry.alternatives)).not.toContain('texto livre');
  });
});
