import { describe, expect, it } from 'vitest';
import { planFromAgyTier, planFromClaudeTier, planFromCodexPlanType } from './account-plan';
import { buildFleetSnapshot } from './quota-policy';
import type { ProviderQuotaEntry } from '../../shared/quota-types';

function entry(partial: Partial<ProviderQuotaEntry> & Pick<ProviderQuotaEntry, 'id' | 'adapterId'>): ProviderQuotaEntry {
  return {
    label: partial.id,
    installed: true,
    onCooldown: false,
    windows: [],
    updatedAt: 1,
    ...partial,
  };
}

describe('plan list prices', () => {
  it('prices the two subscriptions that produced the $400 card', () => {
    expect(planFromClaudeTier('default_claude_max_20x')?.monthlyUsd).toBe(200);
    expect(planFromCodexPlanType('pro')?.monthlyUsd).toBe(200);
  });

  it('prices Google Ultra only when the tier names 5× or 20×', () => {
    expect(planFromAgyTier('ultra-20x', 'Google AI Ultra')?.monthlyUsd).toBe(200);
    expect(planFromAgyTier('ultra-5x')?.monthlyUsd).toBe(100);
    expect(planFromAgyTier('g1-ultra-tier', 'Google AI Ultra')?.monthlyUsd).toBeNull();
    expect(planFromAgyTier('google-ai-pro')?.monthlyUsd).toBe(20);
    expect(planFromAgyTier('free-tier')?.monthlyUsd).toBe(0);
  });
});

describe('fleet plan total', () => {
  it('does not present two priced plans as the whole connected fleet', () => {
    const snapshot = buildFleetSnapshot([
      entry({
        id: 'claude',
        adapterId: 'claude',
        plan: { source: 'detected', tier: 'max_20x', label: 'Claude Max 20×', monthlyUsd: 200 },
      }),
      entry({
        id: 'codex',
        adapterId: 'codex',
        plan: { source: 'detected', tier: 'pro', label: 'ChatGPT Pro', monthlyUsd: 200 },
      }),
      entry({
        id: 'agy',
        adapterId: 'agy',
        planEligible: true,
        plan: { source: 'detected', tier: 'ultra', label: 'Google AI Ultra', monthlyUsd: null },
      }),
      entry({ id: 'grok', adapterId: 'grok' }),
      entry({ id: 'kimi', adapterId: 'kimi' }),
    ]);
    expect(snapshot.plans).toMatchObject({
      monthlyUsd: 400,
      priced: 2,
      detected: 3,
      connected: 5,
    });
  });
});
