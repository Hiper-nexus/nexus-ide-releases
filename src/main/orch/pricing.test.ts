import { describe, expect, it } from 'vitest';
import { isCredentiallessOpenCodeModel } from '../adapters/model-auth-readiness';
import {
  DEFAULT_PRICE,
  MODEL_PRICES,
  estimateCost,
  estimateTokens,
  priceForModel,
} from './pricing';

describe('priceForModel', () => {
  it.each(['claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5', 'claude-sonnet-5-5[1m]'])(
    'prices %s using its own registry entry', (model) => {
      expect(priceForModel(model)).toBe(MODEL_PRICES['claude-sonnet-5-5']);
      expect(priceForModel(model)).toEqual({ inputPerM: 2, outputPerM: 10,
        cacheReadPerM: 0.2, cacheWritePerM: 2.5 });
      expect(estimateCost(model, 1_000_000, 1_000_000)).toBe(12);
      expect(priceForModel('claude-sonnet-5')).toBe(MODEL_PRICES['claude-sonnet-5']);
    },
  );
  it('keeps gpt-5.6-sol at the official OpenAI list price (F-913)', () => {
    // Fonte: https://openai.com/index/gpt-5-6/ (consultado em 2026-10-04) —
    // "Sol is $5 input / $30 output" por 1M tokens; cache da família GPT-5.6:
    // leitura a 10% da entrada, escrita a 1,25x.
    expect(MODEL_PRICES['gpt-5.6-sol']).toEqual({
      inputPerM: 5,
      outputPerM: 30,
      cacheReadPerM: 0.5,
      cacheWritePerM: 6.25,
    });
    expect(priceForModel('gpt-5.6-sol')).toBe(MODEL_PRICES['gpt-5.6-sol']);
    expect(estimateCost('gpt-5.6-sol', 1_000_000, 1_000_000)).toBe(35);
  });
  it('matches by prefix and resolves specific variants', () => {
    expect(priceForModel('claude-opus-4-8')).toEqual(MODEL_PRICES['claude-opus-4-8']);
    expect(priceForModel('gpt-5.2')).toEqual(MODEL_PRICES['gpt-5.2']);
    expect(priceForModel('deepseek-v3')).toEqual(MODEL_PRICES.deepseek);
  });

  it('prefers the longest matching prefix', () => {
    expect(priceForModel('gemini-flash-latest')).toEqual(
      MODEL_PRICES['gemini-flash'],
    );
    expect(priceForModel('gemini-3.7-flash-high')).toEqual(
      MODEL_PRICES['gemini-3.7-flash'],
    );
    expect(priceForModel('gemini-3.6-flash-low')).toEqual(
      MODEL_PRICES['gemini-3.6-flash'],
    );
    expect(priceForModel('gemini-2.5-pro')).toEqual(MODEL_PRICES['gemini-2.5-pro']);
    expect(priceForModel('claude-sonnet-5')).toEqual(
      MODEL_PRICES['claude-sonnet-5'],
    );
    expect(priceForModel('gpt-5-mini')).toEqual(MODEL_PRICES['gpt-5-mini']);
    expect(priceForModel('claude-opus-5-5')).toEqual(
      MODEL_PRICES['claude-opus-5-5'],
    );
    expect(priceForModel('claude-opus-5')).toEqual(
      MODEL_PRICES['claude-opus-5'],
    );
    expect(priceForModel('glm-5.3-flash')).toEqual(
      MODEL_PRICES['glm-5.3-flash'],
    );
    expect(priceForModel('claude-fable-5-1')).toEqual(
      MODEL_PRICES['claude-fable-5-1'],
    );
    expect(priceForModel('gpt-6-astra')).toEqual(
      MODEL_PRICES['gpt-6-astra'],
    );
    expect(priceForModel('gpt-6.1-sol')).toEqual(
      MODEL_PRICES['gpt-6.1-sol'],
    );
    expect(priceForModel('gpt-6-sol')).toEqual(
      MODEL_PRICES['gpt-6-sol'],
    );
    expect(priceForModel('gpt-6-luna')).toEqual(
      MODEL_PRICES['gpt-6-luna'],
    );
  });

  it('matches compound names and namespaced models correctly', () => {
    expect(priceForModel('kimi-code/k3')).toEqual(MODEL_PRICES['kimi-code/k3']);
    // O prefixo `kimi-code/k3` ($3/$15) não pode engolir o K3.1 Pro nem o Highspeed.
    expect(priceForModel('kimi-code/k3.1-pro')).toEqual({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 });
    expect(priceForModel('kimi-code/k3.1-pro-highspeed')).toEqual({ inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2 });
    expect(priceForModel('moonshot/kimi-k3.1-pro-highspeed')).toEqual(MODEL_PRICES['kimi-code/k3.1-pro-highspeed']);
    expect(priceForModel('moonshot/kimi-k2')).toEqual(MODEL_PRICES.kimi);
    expect(priceForModel('xiaomi/mimo-v2')).toEqual(MODEL_PRICES.mimo);
    expect(priceForModel('openrouter/anthropic/claude-fable-5-1')).toEqual(
      MODEL_PRICES['claude-fable-5-1'],
    );
    expect(priceForModel('devin/swe-2-high')).toEqual(MODEL_PRICES['swe-2-high']);
    expect(priceForModel('muse')).toEqual(MODEL_PRICES.muse);
    expect(priceForModel('opencode/big-pickle')).toEqual(
      MODEL_PRICES['opencode/big-pickle'],
    );
  });

  it('supports short model aliases', () => {
    expect(priceForModel('sonnet')).toEqual(MODEL_PRICES.sonnet);
    expect(priceForModel('opus')).toEqual(MODEL_PRICES.opus);
    expect(priceForModel('haiku')).toEqual(MODEL_PRICES.haiku);
    expect(priceForModel('gpt-4o')).toEqual(MODEL_PRICES['gpt-4o']);
    expect(priceForModel('gpt-4o-mini')).toEqual(MODEL_PRICES['gpt-4o-mini']);
  });

  it('is case-insensitive', () => {
    expect(priceForModel('Claude-Opus-5')).toEqual(MODEL_PRICES['claude-opus-5']);
  });

  it('falls back to the default price', () => {
    expect(priceForModel('mystery-model')).toEqual(DEFAULT_PRICE);
    expect(priceForModel(undefined)).toEqual(DEFAULT_PRICE);
    expect(priceForModel('')).toEqual(DEFAULT_PRICE);
  });
});

describe('estimateCost', () => {
  it('prices Grok 4.7 at its published base rates instead of the Grok 4 fallback', () => {
    expect(estimateCost('grok-4.7', 1_000_000, 0)).toBe(2);
    expect(estimateCost('xai/grok-4.7', 0, 1_000_000)).toBe(6);
  });

  it('uses the published Xiaomi V2.6 base rates for every CLI model', () => {
    expect(estimateCost('xiaomi/mimo-v2.6-flash', 1_000_000, 1_000_000)).toBeCloseTo(0.42);
    expect(estimateCost('xiaomi/mimo-v2.6-pro', 1_000_000, 1_000_000)).toBeCloseTo(1.305);
    expect(estimateCost('xiaomi/mimo-v2.6-pro-ultraspeed', 1_000_000, 1_000_000)).toBeCloseTo(13.05);
  });

  it('usa os preços do estudo 2026-09 (docs/models/estudo-2026-09.md)', () => {
    const inOut = (model: string) => estimateCost(model, 1_000_000, 1_000_000);
    expect(inOut('claude-opus-5-5')).toBeCloseTo(24);
    expect(inOut('gpt-6-astra')).toBeCloseTo(60);
    expect(inOut('gpt-6.1-sol')).toBeCloseTo(12);
    expect(inOut('gpt-6-sol')).toBeCloseTo(12);
    expect(inOut('gpt-6-luna')).toBeCloseTo(0.6);
    expect(inOut('gemini-3.8-flash-high')).toBeCloseTo(4.5);
    expect(inOut('gemini-3.1-pro-high')).toBeCloseTo(14);
    expect(inOut('kimi-code/k3')).toBeCloseTo(18);
    expect(inOut('grok-4.6')).toBeCloseTo(8);
    expect(inOut('glm-5.3')).toBeCloseTo(5.8);
  });

  it('prices input and output tokens separately', () => {
    // claude-opus-5: $5/M in, $25/M out.
    const cost = estimateCost('claude-opus-5', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(30, 10);
  });

  it('prices frontier claude-fable at $10 in and $50 out', () => {
    const cost = estimateCost('claude-fable-5-1', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(60, 10);
  });

  it('prices free tools at $0', () => {
    expect(estimateCost('muse', 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCost('big-pickle', 500_000, 500_000)).toBe(0);
  });

  it('scales linearly with token counts', () => {
    const cost = estimateCost('claude-3-7-sonnet', 500_000, 100_000);
    expect(cost).toBeCloseTo(0.5 * 3 + 0.1 * 15, 10);
  });

  it('returns zero for zero tokens', () => {
    expect(estimateCost('claude-opus-5', 0, 0)).toBe(0);
  });

  it('uses the default price for unknown models', () => {
    const cost = estimateCost('mystery', 1_000_000, 0);
    expect(cost).toBeCloseTo(DEFAULT_PRICE.inputPerM, 10);
  });
});

describe('estimateTokens', () => {
  it('returns zero for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('approximates ~4 chars per token, rounding up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });

  it('never returns zero for non-empty text', () => {
    expect(estimateTokens('a')).toBe(1);
  });
});

/**
 * F-820: o F-774 precificou `opencode/deepseek-v4-flash` a $0 (antes saía
 * $0,27/$1,10 pelo prefixo `deepseek`), mas o id sem `-free` é o modelo pago do
 * gateway e o F-683 registra "Model access is disabled" nele. Grátis é só o que
 * é provadamente sem credencial (allowlist exata) ou termina em `-free`.
 */
describe('opencode: só o provadamente grátis custa $0 (F-820)', () => {
  it('opencode/deepseek-v4-flash é pago, no preço da família DeepSeek', () => {
    const price = priceForModel('opencode/deepseek-v4-flash');
    expect(price).toEqual(MODEL_PRICES.deepseek);
    expect(price.inputPerM).toBeGreaterThan(0);
    expect(price.outputPerM).toBeGreaterThan(0);
    expect(estimateCost('opencode/deepseek-v4-flash', 1_000_000, 1_000_000)).toBeCloseTo(1.37);
    expect(estimateCost('OpenCode/DeepSeek-V4-Flash', 1_000_000, 0)).toBeCloseTo(0.27);
  });

  it('a variante -free continua grátis (sufixo é mais longo e vence o prefixo)', () => {
    expect(estimateCost('opencode/deepseek-v4-flash-free', 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCost('opencode/mimo-v2.5-free', 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCost('opencode/nemotron-3-ultra-free', 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCost('opencode/big-pickle', 1_000_000, 1_000_000)).toBe(0);
  });

  it('nenhum opencode/ a $0 na tabela escapa da regra: -free ou allowlist sem credencial', () => {
    const zero = Object.entries(MODEL_PRICES).filter(
      ([id, price]) =>
        id.startsWith('opencode/') && price.inputPerM === 0 && price.outputPerM === 0,
    );
    expect(zero.length).toBeGreaterThan(0);
    for (const [id] of zero) {
      expect(
        id.endsWith('-free') || isCredentiallessOpenCodeModel('opencode', id),
        `${id} está a $0 sem ser -free nem provado sem credencial`,
      ).toBe(true);
    }
  });

  it('id opencode/ desconhecido nunca vira grátis por prefixo', () => {
    expect(priceForModel('opencode/algum-modelo-novo')).toEqual(DEFAULT_PRICE);
    expect(priceForModel('opencode/deepseek-v4-pro').inputPerM).toBeGreaterThan(0);
  });
});
