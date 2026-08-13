import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICE,
  MODEL_PRICES,
  estimateCost,
  estimateTokens,
  priceForModel,
} from './pricing';

describe('priceForModel', () => {
  it('matches by prefix', () => {
    expect(priceForModel('claude-opus-4-8')).toEqual(MODEL_PRICES['claude-opus']);
    expect(priceForModel('gpt-5.2')).toEqual(MODEL_PRICES['gpt-5']);
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
    expect(priceForModel('gemini-2.5-pro')).toEqual(MODEL_PRICES.gemini);
    expect(priceForModel('claude-sonnet-5')).toEqual(
      MODEL_PRICES['claude-sonnet'],
    );
    expect(priceForModel('gpt-5-mini')).toEqual(MODEL_PRICES['gpt-5-mini']);
    expect(priceForModel('claude-opus-5')).toEqual(
      MODEL_PRICES['claude-opus-5'],
    );
  });

  it('strips provider namespaces before matching', () => {
    expect(priceForModel('moonshot/kimi-k2')).toEqual(MODEL_PRICES.kimi);
    expect(priceForModel('xiaomi/mimo-v2')).toEqual(MODEL_PRICES.mimo);
  });

  it('is case-insensitive', () => {
    expect(priceForModel('Claude-Opus-4-8')).toEqual(MODEL_PRICES['claude-opus']);
  });

  it('falls back to the default price', () => {
    expect(priceForModel('mystery-model')).toEqual(DEFAULT_PRICE);
    expect(priceForModel(undefined)).toEqual(DEFAULT_PRICE);
    expect(priceForModel('')).toEqual(DEFAULT_PRICE);
  });
});

describe('estimateCost', () => {
  it('prices input and output tokens separately', () => {
    // claude-opus: $15/M in, $75/M out.
    const cost = estimateCost('claude-opus-4-8', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(90, 10);
  });

  it('uses the official lower Opus 5 list price without changing Opus 4', () => {
    const cost = estimateCost('claude-opus-5', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(30, 10);
    expect(priceForModel('claude-opus-4-8')).toEqual(
      MODEL_PRICES['claude-opus'],
    );
  });

  it('scales linearly with token counts', () => {
    const cost = estimateCost('claude-sonnet-5', 500_000, 100_000);
    expect(cost).toBeCloseTo(0.5 * 3 + 0.1 * 15, 10);
  });

  it('returns zero for zero tokens', () => {
    expect(estimateCost('claude-opus', 0, 0)).toBe(0);
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
