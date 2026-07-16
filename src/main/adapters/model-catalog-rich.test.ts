import { describe, expect, it } from 'vitest';
import {
  RICH_MODEL_CATALOG,
  richCatalogProviders,
} from '../../vendor/omp/catalog/rich-models';
import { classifyModelId } from '../../vendor/omp/catalog/identity';
import { getRichModelMetadata } from './model-catalog';

// Camada de metadados ricos vendorada do oh-my-pi (recorte em
// src/vendor/omp/catalog/models-rich.json — ver README.md ao lado).

describe('recorte vendorado (models-rich.json)', () => {
  it('parseia e contém os providers esperados', () => {
    const providers = richCatalogProviders();
    for (const expected of [
      'anthropic',
      'openai',
      'openai-codex',
      'zai',
      'zhipu-coding-plan',
      'deepseek',
      'xai',
      'google',
      'google-gemini-cli',
      'kimi-code',
      'moonshot',
      'openrouter',
      'sakana',
    ]) {
      expect(providers).toContain(expected);
    }
  });

  it('mantém só famílias relevantes no recorte do openrouter', () => {
    const ids = Object.keys(RICH_MODEL_CATALOG.openrouter ?? {});
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toMatch(/claude|gpt|glm|deepseek|kimi|grok|gemini/i);
    }
  });

  it('normaliza entradas com id e custos finitos e não-negativos', () => {
    for (const models of Object.values(RICH_MODEL_CATALOG)) {
      for (const [modelId, entry] of Object.entries(models)) {
        expect(entry.id).toBe(modelId);
        for (const value of Object.values(entry.cost ?? {})) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('getRichModelMetadata — um modelo real por adapter', () => {
  it('claude: resolve preço e janela de claude-sonnet-4-5', () => {
    const meta = getRichModelMetadata('claude', 'claude-sonnet-4-5');
    expect(meta).not.toBeNull();
    expect(meta?.ompProvider).toBe('anthropic');
    expect(meta?.cost?.input).toBe(3);
    expect(meta?.cost?.output).toBe(15);
    expect(meta?.contextWindow).toBe(1_000_000);
    expect(meta?.maxTokens).toBe(64_000);
  });

  it('codex: resolve preço e janela de gpt-5.5', () => {
    const meta = getRichModelMetadata('codex', 'gpt-5.5');
    expect(meta).not.toBeNull();
    expect(meta?.ompProvider).toBe('openai-codex');
    expect(meta?.cost?.input).toBe(5);
    expect(meta?.contextWindow).toBe(272_000);
  });

  it('glm: resolve custo e janela de glm-4.6 via zai', () => {
    const meta = getRichModelMetadata('glm', 'glm-4.6');
    expect(meta).not.toBeNull();
    expect(meta?.ompProvider).toBe('zai');
    expect(meta?.cost).toBeDefined();
    expect(meta?.contextWindow).toBe(204_800);
  });

  it('kimi: resolve id com prefixo kimi-code/kimi-for-coding', () => {
    const meta = getRichModelMetadata('kimi', 'kimi-code/kimi-for-coding');
    expect(meta).not.toBeNull();
    expect(meta?.ompProvider).toBe('kimi-code');
    expect(meta?.cost).toBeDefined();
    expect(meta?.contextWindow).toBe(262_144);
  });

  it('kimi: cai para o provider moonshot quando o id é bare', () => {
    const meta = getRichModelMetadata('kimi', 'kimi-k2.6');
    expect(meta).not.toBeNull();
    expect(meta?.ompProvider).toBe('moonshot');
    expect(meta?.contextWindow).toBeGreaterThan(0);
  });

  it('grok: resolve preço e janela de grok-4.5', () => {
    const meta = getRichModelMetadata('grok', 'grok-4.5');
    expect(meta).not.toBeNull();
    expect(meta?.ompProvider).toBe('xai');
    expect(meta?.cost?.input).toBe(2);
    expect(meta?.contextWindow).toBe(500_000);
  });

  it('omp: resolve pelo prefixo provider/ do id (deepseek)', () => {
    const meta = getRichModelMetadata('omp', 'deepseek/deepseek-v4-pro');
    expect(meta).not.toBeNull();
    expect(meta?.ompProvider).toBe('deepseek');
    expect(meta?.cost?.input).toBeCloseTo(0.435);
    expect(meta?.contextWindow).toBe(1_000_000);
  });
});

describe('getRichModelMetadata — fuzzy leve', () => {
  it('remove sufixo de data: claude-sonnet-5-20260101 → claude-sonnet-5', () => {
    const meta = getRichModelMetadata('claude', 'claude-sonnet-5-20260101');
    expect(meta).not.toBeNull();
    expect(meta?.id).toBe('claude-sonnet-5');
    expect(meta?.cost?.input).toBe(2);
  });

  it('expande snapshot: claude-opus-4 → claude-opus-4-20250514', () => {
    const meta = getRichModelMetadata('claude', 'claude-opus-4');
    expect(meta).not.toBeNull();
    expect(meta?.id).toBe('claude-opus-4-20250514');
  });

  it('remove sufixo -thinking do agy e resolve no fallback anthropic', () => {
    const meta = getRichModelMetadata('agy', 'claude-opus-4-6-thinking');
    expect(meta).not.toBeNull();
    expect(meta?.ompProvider).toBe('anthropic');
    expect(meta?.id).toBe('claude-opus-4-6');
  });

  it('não remove sufixos que mudam identidade (-fast)', () => {
    const meta = getRichModelMetadata('grok', 'grok-4-fast');
    // grok-4-fast existe no recorte como modelo próprio — não pode virar grok-4.
    expect(meta?.id).toBe('grok-4-fast');
  });
});

describe('getRichModelMetadata — desconhecidos', () => {
  it('retorna null para modelo inexistente', () => {
    expect(getRichModelMetadata('claude', 'no-such-model-v99')).toBeNull();
  });

  it('retorna null para adapter sem mapeamento', () => {
    expect(getRichModelMetadata('longcat', 'LongCat-2.0')).toBeNull();
  });

  it('retorna null para prefixo de provider desconhecido no omp', () => {
    expect(getRichModelMetadata('omp', 'unknown-provider/foo')).toBeNull();
  });

  it('retorna null para modelId vazio ou ausente', () => {
    expect(getRichModelMetadata('claude', undefined)).toBeNull();
    expect(getRichModelMetadata('claude', '  ')).toBeNull();
  });
});

describe('identity (derivado do omp)', () => {
  it('classifica claude em família/kind/versão', () => {
    expect(classifyModelId('claude-sonnet-4-5')).toEqual({
      family: 'anthropic',
      kind: 'sonnet',
      version: { major: 4, minor: 5, patch: 0 },
    });
    expect(classifyModelId('anthropic/claude-haiku-4-5')).toMatchObject({
      family: 'anthropic',
      kind: 'haiku',
    });
  });

  it('classifica openai/glm/gemini em variantes', () => {
    expect(classifyModelId('gpt-5.4-mini')).toMatchObject({
      family: 'openai',
      variant: 'mini',
    });
    expect(classifyModelId('glm-4.5-air')).toMatchObject({
      family: 'glm',
      variant: 'air',
    });
    expect(classifyModelId('gemini-3.1-pro-preview')).toMatchObject({
      family: 'gemini',
      kind: 'pro',
    });
  });

  it('preserva id desconhecido sem namespace', () => {
    expect(classifyModelId('vendor/mystery-model')).toEqual({
      family: 'unknown',
      id: 'mystery-model',
    });
  });
});
