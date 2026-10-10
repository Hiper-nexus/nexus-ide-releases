import { describe, expect, it } from 'vitest';
import { decisionResultCostUsd } from './decision-pricing';

describe('model-specific decision pricing', () => {
  it('derives price from reported usage instead of trusting an injected estimate', () => {
    expect(decisionResultCostUsd({ model: 'clef', answers: {}, usage: { input_tokens: 1_000_000, output_tokens: 0 }, estimatedUsd: -100 })).toBeCloseTo(0.24, 10);
  });
  it.each([
    ['jev-1.13.0', 0.042], ['jev-latest', 0.042], ['clef', 0.24],
    ['clef-flash', 0.038], ['@cf/cloudflare/clef-flash', 0.038],
    ['clef-omni', 0.15], ['@cf/cloudflare/clef-omni', 0.15], ['gpt-6-luna', 0.10],
  ])('prices a million reported input tokens from %s', (model, expectedUsd) => {
    expect(decisionResultCostUsd({ model, answers: {}, usage: { input_tokens: 1_000_000, output_tokens: 100 } })).toBeCloseTo(expectedUsd, 10);
  });
  it('prices a Luna route at the published input rate even when the echoed model name is unfamiliar', () => {
    expect(decisionResultCostUsd({ model: 'other', route: { provider: 'luna', model: 'gpt-6-luna', policyVersion: 'jev-clef-luna-v1', evidence: 'manual', reason: 'manual' },
      answers: {}, usage: { input_tokens: 1_000_000, output_tokens: 50 } })).toBeCloseTo(0.10, 10);
  });
});
