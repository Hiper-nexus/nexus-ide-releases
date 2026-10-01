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
});
