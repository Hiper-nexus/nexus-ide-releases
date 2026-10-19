import { describe, expect, it } from 'vitest';
import type { AdapterInfo } from '../../shared/adapter-types';
import {
  buildModelComparison,
  comparisonAdaptersFrom,
  type ModelComparisonAdapter,
} from './model-comparison';

function adapterInfo(
  id: string,
  installed: boolean,
  list: string[],
  info: NonNullable<AdapterInfo['models']['info']> = {},
): AdapterInfo {
  return {
    id,
    label: id.toUpperCase(),
    installed,
    models: { list, default: list[0] ?? '', info },
  } as AdapterInfo;
}

describe('comparisonAdaptersFrom (F-1588)', () => {
  it('usa a oferta elegível e marca CLI desligada ou ausente', () => {
    const adapters = comparisonAdaptersFrom(
      [
        adapterInfo('shell', true, ['bash']),
        adapterInfo('claude', true, ['claude-opus-5-5', 'claude-fable-5'], {
          'claude-fable-5': { id: 'claude-fable-5', availability: 'api-only' },
        }),
        adapterInfo('codex', true, ['gpt-6.1-sol', 'gpt-6-luna']),
        adapterInfo('devin', false, ['swe-2-high']),
        adapterInfo('grok', true, []),
      ],
      new Set(['codex']),
      (adapterId, model) => adapterId === 'codex' && model === 'gpt-6-luna',
    );
    expect(adapters.map((a) => [a.adapterId, a.cli, a.models])).toEqual([
      ['claude', 'ready', ['claude-opus-5-5']],
      ['codex', 'disabled', ['gpt-6.1-sol']],
      ['devin', 'missing', ['swe-2-high']],
    ]);
  });
});

const AT = '2026-10-19T12:00:00.000Z';

function adapter(
  adapterId: string,
  models: string[],
  extra: Partial<ModelComparisonAdapter> = {},
): ModelComparisonAdapter {
  return { adapterId, label: adapterId, cli: 'ready', models, info: {}, ...extra };
}

describe('buildModelComparison (F-1588)', () => {
  it('usa o benchmark oficial com fonte, nunca a fixture escrita à mão', () => {
    const snapshot = buildModelComparison(
      [
        adapter('codex', ['gpt-6.1-sol'], {
          info: {
            'gpt-6.1-sol': {
              id: 'gpt-6.1-sol',
              costTier: 'high',
              quality: {
                overall: 99,
                evaluatedAt: '2026-07-11T21:00:00.000Z',
                source: 'nexus-eval/v1/fixture',
              },
            },
          },
        }),
      ],
      AT,
    );
    const [sol] = snapshot.entries;
    expect(sol).toMatchObject({
      id: 'codex/gpt-6.1-sol',
      scoreKind: 'published',
      benchmarks: { deepSWE: 75.2 },
      source: 'https://openai.com/index/introducing-gpt-6-1-sol/',
      origin: 'own',
      costTier: 'high',
    });
    // DeepSWE 75,2 em [45,76] → 97,4; nunca os 99 da fixture.
    expect(sol!.score).toBeCloseTo(97.4, 1);
    expect(sol!.measured).toBeUndefined();
  });

  it('avaliação medida pelo Nexus vence o benchmark publicado, como na rota', () => {
    const snapshot = buildModelComparison(
      [
        adapter('codex', ['gpt-6.1-sol'], {
          info: {
            'gpt-6.1-sol': {
              id: 'gpt-6.1-sol',
              quality: {
                overall: 81,
                coding: 84,
                evaluatedAt: '2026-10-01T00:00:00.000Z',
                source: 'nexus-eval/v2/run-2026-10-01',
              },
            },
          },
        }),
      ],
      AT,
    );
    expect(snapshot.entries[0]).toMatchObject({
      score: 81,
      scoreKind: 'measured',
      measured: { overall: 81, coding: 84, evaluatedAt: '2026-10-01T00:00:00.000Z' },
      benchmarks: { deepSWE: 75.2 },
    });
  });

  it('esconde a versão antiga quando a mesma linha tem versão mais nova na oferta', () => {
    const snapshot = buildModelComparison(
      [
        adapter('claude', ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-4-8', 'claude-opus-5-5']),
        adapter('codex', ['gpt-5.6-luna', 'gpt-6-luna']),
      ],
      AT,
    );
    expect(snapshot.entries.map((e) => e.modelId)).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'gpt-6-luna',
    ]);
    expect(snapshot.olderVersionsHidden).toBe(3);
  });

  it('diz de quem são os números: variante, mesmo modelo ou antecessor', () => {
    const snapshot = buildModelComparison(
      [
        adapter('agy', ['gemini-3.8-flash-high']),
        adapter('claude', ['deepseek-flash']),
        adapter('codex', ['gpt-6.2-sol']),
      ],
      AT,
    );
    const byId = new Map(snapshot.entries.map((e) => [e.id, e]));
    expect(byId.get('agy/gemini-3.8-flash-high')).toMatchObject({
      origin: 'variant',
      numbersFrom: 'gemini-3.8-flash',
      benchmarks: { deepSWE: 73.7, terminalBench21: 89.4 },
    });
    expect(byId.get('claude/deepseek-flash')).toMatchObject({
      origin: 'same-model',
      numbersFrom: 'deepseek-flash',
    });
    expect(byId.get('codex/gpt-6.2-sol')).toMatchObject({
      origin: 'predecessor',
      numbersFrom: 'gpt-6.1-sol',
      scoreKind: 'published',
    });
  });

  it('modelo sem número publicado fica sem nota — ausência nunca vira zero', () => {
    const snapshot = buildModelComparison(
      [adapter('qwen', ['qwen3.8-max'], { cli: 'missing', label: 'Qwen Code' })],
      AT,
    );
    expect(snapshot.entries[0]).toEqual({
      id: 'qwen/qwen3.8-max',
      adapterId: 'qwen',
      adapterLabel: 'Qwen Code',
      modelId: 'qwen3.8-max',
      cli: 'missing',
      score: null,
      scoreKind: 'none',
      benchmarks: {},
    });
  });

  it('não duplica o mesmo id e leva a data de geração', () => {
    const snapshot = buildModelComparison(
      [adapter('codex', ['gpt-6.1-sol', 'gpt-6.1-sol'])],
      AT,
    );
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.generatedAt).toBe(AT);
  });
});
