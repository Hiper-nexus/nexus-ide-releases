import { describe, expect, it } from 'vitest';
import type { ModelComparisonEntry } from '../../../shared/eval-ranking-types';
import {
  bestFor,
  bestValuePick,
  formatPercent,
  formatScore,
  groupByBand,
  originBadge,
  originNote,
  sortComparison,
  sourceHref,
  valueFor,
} from './ranking-view';

function entry(
  patch: Partial<ModelComparisonEntry> & Pick<ModelComparisonEntry, 'modelId'>,
): ModelComparisonEntry {
  return {
    id: `codex/${patch.modelId}`,
    adapterId: 'codex',
    adapterLabel: 'Codex',
    cli: 'ready',
    score: null,
    scoreKind: 'none',
    benchmarks: {},
    ...patch,
  };
}

const sol = entry({
  modelId: 'gpt-6.1-sol',
  score: 97.4,
  scoreKind: 'published',
  costTier: 'high',
  benchmarks: { deepSWE: 75.2 },
});
const flash = entry({
  modelId: 'gemini-3.8-flash-low',
  adapterId: 'agy',
  score: 85.1,
  scoreKind: 'published',
  costTier: 'low',
  benchmarks: { deepSWE: 73.7, terminalBench21: 89.4 },
});
const sonnet = entry({
  modelId: 'claude-sonnet-5',
  adapterId: 'claude',
  score: 70.6,
  scoreKind: 'published',
  costTier: 'medium',
  benchmarks: { terminalBench21: 80.4, swebenchVerified: 85.2 },
});
const qwen = entry({ modelId: 'qwen3.8-max', adapterId: 'qwen', costTier: 'medium' });

describe('ranking-view (F-1588)', () => {
  it('ordena pelo número escolhido e manda quem não publicou para o fim', () => {
    expect(sortComparison([qwen, sonnet, sol, flash], 'score').map((e) => e.modelId)).toEqual([
      'gpt-6.1-sol',
      'gemini-3.8-flash-low',
      'claude-sonnet-5',
      'qwen3.8-max',
    ]);
    // Sem DeepSWE publicado: fim da lista, desempate pela nota geral.
    expect(sortComparison([sonnet, qwen, flash, sol], 'deepSWE').map((e) => e.modelId)).toEqual([
      'gpt-6.1-sol',
      'gemini-3.8-flash-low',
      'claude-sonnet-5',
      'qwen3.8-max',
    ]);
    expect(valueFor(sonnet, 'deepSWE')).toBeNull();
    expect(valueFor(sonnet, 'swebenchVerified')).toBe(85.2);
  });

  it('destaque só existe com número; ausência nunca vence', () => {
    expect(bestFor([sol, flash, sonnet], 'terminalBench21')?.modelId).toBe('gemini-3.8-flash-low');
    expect(bestFor([sol, qwen], 'swebenchVerified')).toBeNull();
    expect(bestFor([], 'score')).toBeNull();
  });

  it('melhor da faixa mais barata: rápida antes de equilibrada', () => {
    expect(bestValuePick([sol, flash, sonnet])?.modelId).toBe('gemini-3.8-flash-low');
    expect(bestValuePick([sol, sonnet, qwen])?.modelId).toBe('claude-sonnet-5');
    expect(bestValuePick([sol])).toBeNull();
  });

  it('faixas vêm do custo do catálogo, em ordem de nota', () => {
    const groups = groupByBand([qwen, sonnet, sol, flash]);
    expect(groups.fast.map((e) => e.modelId)).toEqual(['gemini-3.8-flash-low']);
    expect(groups.balanced.map((e) => e.modelId)).toEqual(['claude-sonnet-5', 'qwen3.8-max']);
    expect(groups.deep.map((e) => e.modelId)).toEqual(['gpt-6.1-sol']);
  });

  it('diz de quem são os números quando não são do próprio modelo', () => {
    expect(originNote(sol)).toBeNull();
    expect(originBadge(sol)).toBeNull();
    const heir = entry({ modelId: 'gpt-6.2-sol', origin: 'predecessor', numbersFrom: 'gpt-6.1-sol' });
    expect(originNote(heir)).toContain('herda a nota de gpt-6.1-sol');
    expect(originBadge(heir)).toBe('nota herdada');
    const twin = entry({ modelId: 'deepseek-flash', origin: 'same-model', numbersFrom: 'deepseek-flash' });
    expect(originBadge(twin)).toBe('mesmo modelo');
    const variant = entry({ modelId: 'gemini-3.8-flash-high', origin: 'variant', numbersFrom: 'gemini-3.8-flash' });
    expect(originNote(variant)).toContain('esforço e contexto não mudam o modelo');
    expect(originBadge(variant)).toBeNull();
  });

  it('só http(s) vira link; nome de documento fica texto', () => {
    expect(sourceHref({ source: 'https://openai.com/index/gpt-5-6/' })).toBe('https://openai.com/index/gpt-5-6/');
    expect(sourceHref({ source: 'Fable 5.1 & Mythos 5.1 System Card' })).toBeNull();
    expect(sourceHref({ source: 'javascript:alert(1)' })).toBeNull();
    expect(sourceHref({})).toBeNull();
  });

  it('formata em pt-BR e escreve "—" para ausência', () => {
    expect(formatPercent(75.2)).toBe('75,2%');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatScore(97.4)).toBe('97,4');
    expect(formatScore(null)).toBe('—');
  });
});
