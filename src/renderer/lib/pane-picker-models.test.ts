import { describe, expect, it } from 'vitest';
import type { ModelInfoMap } from '../../shared/adapter-types';
import {
  modelStrength,
  parseModelVersion,
  rankPickerModels,
} from './pane-picker-models';

function info(
  entries: Record<
    string,
    { cost?: 'free' | 'low' | 'medium' | 'high'; availability?: 'free' | 'cheap' | 'paid' | 'api-only' | 'deprecated'; warning?: string }
  >,
): ModelInfoMap {
  const map: ModelInfoMap = {};
  for (const [id, entry] of Object.entries(entries)) {
    map[id] = {
      id,
      ...(entry.cost ? { costTier: entry.cost } : {}),
      ...(entry.availability ? { availability: entry.availability } : {}),
      ...(entry.warning ? { warning: entry.warning } : {}),
    };
  }
  return map;
}

describe('parseModelVersion — a geração embutida no id', () => {
  it.each([
    ['claude-opus-4-8', [4, 8]],
    ['claude-fable-5-1', [5, 1]],
    ['claude-opus-5-5', [5, 5]],
    ['claude-opus-5', [5, 0]],
    ['gpt-5.6-sol', [5, 6]],
    ['gpt-6.1-sol', [6, 1]],
    ['gpt-6-sol', [6, 0]],
    ['gpt-6-luna', [6, 0]],
    ['gpt-6-astra', [6, 0]],
    ['gpt-5.4-mini', [5, 4]],
    ['gpt-4o-mini', [4, 0]],
    ['gemini-3.7-flash-high', [3, 7]],
    ['grok-4.6', [4, 6]],
    ['grok-code-fast-1', [1, 0]],
    ['glm-5.3[1m]', [5, 3]],
    ['kimi-code/k3', [3, 0]],
    ['kimi-k2.7', [2, 7]],
    ['LongCat-2.0', [2, 0]],
    ['qwen3-coder', [3, 0]],
    ['claude-sonnet-4-5-20250929', [4, 5]],
    ['codex-default', [0, 0]],
    ['kimi-code/kimi-for-coding', [0, 0]],
    // Tamanho e data não são geração.
    ['gpt-oss-120b-medium', [0, 0]],
    ['llama-3.1-70b-instruct', [3, 1]],
    ['qwen3-235b-a22b', [3, 0]],
    ['gpt-4-0613', [4, 0]],
    ['model-20250929', [0, 0]],
  ])('%s → %j', (id, expected) => {
    expect(parseModelVersion(id)).toEqual(expected);
  });
});

describe('modelStrength — custo do catálogo manda, família desempata', () => {
  it('sem catálogo, a família no id decide', () => {
    expect(modelStrength('acme-opus-2')).toBeGreaterThan(modelStrength('acme-2'));
    expect(modelStrength('acme-2')).toBeGreaterThan(modelStrength('acme-2-mini'));
  });

  it('com catálogo, o custo vence a família', () => {
    const cheapPro = modelStrength('x-pro', { id: 'x-pro', costTier: 'low' });
    const dearPlain = modelStrength('x', { id: 'x', costTier: 'high' });
    expect(dearPlain).toBeGreaterThan(cheapPro);
  });

  it('esforço embutido ordena as variantes da mesma geração', () => {
    const high = modelStrength('gemini-3.7-flash-high', { id: 'a', costTier: 'low' });
    const medium = modelStrength('gemini-3.7-flash-medium', { id: 'b', costTier: 'low' });
    const low = modelStrength('gemini-3.7-flash-low', { id: 'c', costTier: 'free' });
    expect(high).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(low);
  });
});

describe('rankPickerModels — o mais forte primeiro', () => {
  it('Claude: geração de fronteira (fable/mythos) lidera; deprecated afunda, api-only rankeia', () => {
    const ranked = rankPickerModels({
      defaultModel: 'claude-sonnet-5',
      models: [
        'claude-opus-5',
        'claude-fable-5-1',
        'claude-mythos-5-1',
        'claude-fable-5',
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
      ],
      modelInfo: info({
        'claude-opus-5': { cost: 'high', availability: 'paid' },
        'claude-fable-5-1': { cost: 'high', availability: 'paid' },
        'claude-mythos-5-1': { cost: 'high', availability: 'api-only', warning: 'Trusted-access only' },
        'claude-fable-5': { cost: 'high', availability: 'api-only' },
        'claude-opus-4-8': { cost: 'high', availability: 'paid' },
        'claude-opus-4-7': { cost: 'high', availability: 'paid' },
        'claude-sonnet-5': { cost: 'medium', availability: 'paid' },
        'claude-sonnet-4-6': { cost: 'medium', availability: 'paid' },
        'claude-haiku-4-5': { cost: 'low', availability: 'cheap' },
      }),
    });

    expect(ranked.map((row) => row.id)).toEqual([
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
    // O default deixa de ser o primeiro à força, mas segue marcado.
    expect(ranked.find((row) => row.id === 'claude-sonnet-5')?.isDefault).toBe(true);
    expect(ranked[0]?.isDefault).toBe(false);
    expect(ranked[0]?.band).toBe('deep');
    expect(ranked.find((row) => row.id === 'claude-haiku-4-5')?.band).toBe('fast');
    const mythos = ranked.find((row) => row.id === 'claude-mythos-5-1');
    expect(mythos?.restricted).toBe(true);
    expect(mythos?.warning).toBe('Trusted-access only');
  });

  it('Codex: astra (GPT-6) lidera mesmo api-only; sol antes de terra, luna antes de legados', () => {
    const ranked = rankPickerModels({
      defaultModel: 'gpt-5.6-terra',
      models: [
        'gpt-6-astra',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.3-codex',
      ],
      modelInfo: info({
        'gpt-6-astra': { cost: 'high', availability: 'api-only' },
        'gpt-5.6-sol': { cost: 'high', availability: 'paid' },
        'gpt-5.6-terra': { cost: 'high', availability: 'paid' },
        'gpt-5.6-luna': { cost: 'medium', availability: 'paid' },
        'gpt-5.4': { cost: 'medium', availability: 'paid' },
        'gpt-5.4-mini': { cost: 'low', availability: 'cheap' },
        'gpt-5.3-codex': { cost: 'medium', availability: 'paid' },
      }),
    });

    expect(ranked.map((row) => row.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.4-mini',
    ]);
  });

  it('Gemini: pro acima de flash; dentro do flash, 3.7 > 3.6 e high > medium > low', () => {
    const ranked = rankPickerModels({
      defaultModel: 'gemini-3.7-flash-high',
      models: [
        'gemini-3.7-flash-low',
        'gemini-3.7-flash-high',
        'gemini-3.7-flash-medium',
        'gemini-3.6-flash-high',
        'gemini-3.1-pro-high',
      ],
      modelInfo: info({
        'gemini-3.7-flash-low': { cost: 'free', availability: 'free' },
        'gemini-3.7-flash-high': { cost: 'low', availability: 'cheap' },
        'gemini-3.7-flash-medium': { cost: 'low', availability: 'cheap' },
        'gemini-3.6-flash-high': { cost: 'low', availability: 'cheap' },
        'gemini-3.1-pro-high': { cost: 'medium', availability: 'paid' },
      }),
    });

    expect(ranked.map((row) => row.id)).toEqual([
      'gemini-3.1-pro-high',
      'gemini-3.7-flash-high',
      'gemini-3.6-flash-high',
      'gemini-3.7-flash-medium',
      'gemini-3.7-flash-low',
    ]);
  });

  it('sem catálogo de metadados, ids sem versão mantêm a ordem do provider (default primeiro)', () => {
    const ranked = rankPickerModels({
      defaultModel: 'codex-default',
      models: ['codex-alt', 'codex-default'],
    });
    expect(ranked.map((row) => row.id)).toEqual(['codex-default', 'codex-alt']);
    expect(ranked[0]?.band).toBeNull();
    expect(ranked[0]?.isDefault).toBe(true);
  });

  it('catálogo vazio devolve lista vazia; espaços e repetições não viram linhas', () => {
    expect(rankPickerModels({ defaultModel: '', models: [] })).toEqual([]);
    expect(
      rankPickerModels({ defaultModel: ' x-1 ', models: ['x-1', '', 'x-1 '] }).map(
        (row) => row.id,
      ),
    ).toEqual(['x-1']);
  });

  it('modelo fraco continua na lista e selecionável — só nunca acima do forte', () => {
    const ranked = rankPickerModels({
      defaultModel: 'gpt-5.6-luna',
      models: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.4-mini'],
      modelInfo: info({
        'gpt-5.6-sol': { cost: 'high', availability: 'paid' },
        'gpt-5.6-luna': { cost: 'medium', availability: 'paid' },
        'gpt-5.4-mini': { cost: 'low', availability: 'cheap' },
      }),
    });
    const ids = ranked.map((row) => row.id);
    // O fraco (mini) NÃO some — segue escolhível, apenas no fim.
    expect(ids).toContain('gpt-5.4-mini');
    expect(ids.indexOf('gpt-5.6-sol')).toBeLessThan(ids.indexOf('gpt-5.4-mini'));
    expect(ids[ids.length - 1]).toBe('gpt-5.4-mini');
    // Todos utilizáveis: nenhum foi marcado como restrito/removido.
    expect(ranked.every((row) => row.restricted === false)).toBe(true);
  });

  it('modelo restrito (api-only) rankeia pela força e mantém o selo "restrito"', () => {
    const ranked = rankPickerModels({
      defaultModel: 'gpt-5.6-sol',
      models: ['gpt-6-astra', 'gpt-5.6-sol'],
      modelInfo: info({
        'gpt-6-astra': { cost: 'high', availability: 'api-only' },
        'gpt-5.6-sol': { cost: 'high', availability: 'paid' },
      }),
    });
    const ids = ranked.map((row) => row.id);
    expect(ids).toEqual(['gpt-6-astra', 'gpt-5.6-sol']);
    expect(ranked.find((row) => row.id === 'gpt-6-astra')?.restricted).toBe(true);
  });

  it('modelo deprecated ("não use") afunda por último mesmo sendo forte', () => {
    const ranked = rankPickerModels({
      defaultModel: 'x-1',
      models: ['x-9', 'x-1'],
      modelInfo: info({
        'x-9': { cost: 'high', availability: 'deprecated' },
        'x-1': { cost: 'low', availability: 'cheap' },
      }),
    });
    expect(ranked.map((row) => row.id)).toEqual(['x-1', 'x-9']);
    expect(ranked[1]?.restricted).toBe(true);
  });
});
