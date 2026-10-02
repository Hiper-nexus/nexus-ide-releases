import { describe, expect, it } from 'vitest';
import { decisionResultUsage } from './decision-usage';

describe('safe decision usage receipts', () => {
  it('prices Cloudflare usage without copying raw inputs into the receipt', () => {
    const result = { model: 'clef', answers: {}, usage: { input_tokens: 1_000_000, output_tokens: 0 },
      requestCount: 2, durationMs: 30, state: 'private-state', images: ['private-image'] };
    expect(decisionResultUsage(result)).toMatchObject({ provider: 'clef', inputTokens: 1_000_000, usd: 0.24, requestCount: 2 });
    expect(decisionResultUsage(result)).not.toHaveProperty('state');
    expect(decisionResultUsage(result)).not.toHaveProperty('images');
  });

  it('keeps tokens and cost unknown (never zero) when the provider omitted usage', () => {
    const result = { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, usageMissing: true as const };
    expect(decisionResultUsage(result)).toMatchObject({ provider: 'jev', inputTokens: null, usd: null, usageIncomplete: true });
  });
});
