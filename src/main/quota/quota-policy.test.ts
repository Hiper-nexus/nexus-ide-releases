import { describe, expect, it } from 'vitest';
import type { ProviderQuotaEntry } from '../../shared/quota-types';
import {
  buildFleetSnapshot,
  entryWorstRatio,
  isHighUsage,
  preferAccountByQuota,
  quotaAvailabilityScore,
  spawnWarningForAccount,
} from './quota-policy';

function entry(
  partial: Partial<ProviderQuotaEntry> & Pick<ProviderQuotaEntry, 'id' | 'adapterId'>,
): ProviderQuotaEntry {
  return {
    label: partial.id,
    installed: true,
    onCooldown: false,
    windows: [],
    updatedAt: 1,
    ...partial,
  };
}

describe('quota-policy', () => {
  it('does not count an auth cooldown as high quota when the provider reports low usage', () => {
    const account = entry({ id: 'auth', adapterId: 'claude', onCooldown: true, cooldownKind: 'auth',
      windows: [{ kind: 'weekly', label: 'Semanal', usedRatio: 0.1, source: 'provider-api', confidence: 'high' }],
    });
    expect(buildFleetSnapshot([account]).highUsageCount).toBe(0);
    expect(quotaAvailabilityScore(account)).toBe(0);
  });
  it('cooldown never fabricates 100% over real telemetry in fleet display counters', () => {
    // O caso do cockpit: conta em cooldown(quota) com leitura real Semanal 54%.
    // Decisão (entryWorstRatio) continua tratando como esgotada; EXIBIÇÃO
    // (worstUsedRatio/highUsageCount) reporta o fato: 54%.
    const account = entry({ id: 'codex:ret', adapterId: 'codex', onCooldown: true, cooldownKind: 'quota',
      windows: [
        { kind: 'hours', label: '5 Horas', usedRatio: null, source: 'unknown', confidence: 'low' },
        { kind: 'weekly', label: 'Semanal', usedRatio: 0.54, source: 'provider-api', confidence: 'high' },
      ],
    });
    expect(entryWorstRatio(account)).toBe(1);
    const fleet = buildFleetSnapshot([account]);
    expect(fleet.worstUsedRatio).toBe(0.54);
    expect(fleet.highUsageCount).toBe(0);
  });
  it('computes worst ratio and high usage', () => {
    const e = entry({
      id: 'claude:a',
      adapterId: 'claude',
      windows: [
        {
          kind: 'session',
          label: 'Sessão',
          usedRatio: 0.1,
          source: 'provider-api',
          confidence: 'high',
        },
        {
          kind: 'weekly',
          label: 'Semanal',
          usedRatio: 0.9,
          source: 'provider-api',
          confidence: 'high',
        },
      ],
    });
    expect(entryWorstRatio(e)).toBe(0.9);
    expect(isHighUsage(e)).toBe(true);
    expect(spawnWarningForAccount(e)).toMatch(/90%/);
  });

  it('unknown windows do not invent worst ratio of zero', () => {
    const e = entry({
      id: 'x',
      adapterId: 'kimi',
      windows: [
        {
          kind: 'weekly',
          label: 'Semanal',
          usedRatio: null,
          source: 'unknown',
          confidence: 'low',
        },
      ],
    });
    expect(entryWorstRatio(e)).toBeNull();
    const fleet = buildFleetSnapshot([e]);
    expect(fleet.worstUsedRatio).toBeNull();
    expect(fleet.unknownCount).toBe(1);
  });

  it('prefers freer account for failover weight', () => {
    const low = entry({
      id: 'a',
      adapterId: 'claude',
      windows: [
        {
          kind: 'weekly',
          label: 'Semanal',
          usedRatio: 0.2,
          source: 'provider-api',
          confidence: 'high',
        },
      ],
    });
    const high = entry({
      id: 'b',
      adapterId: 'claude',
      windows: [
        {
          kind: 'weekly',
          label: 'Semanal',
          usedRatio: 0.95,
          source: 'provider-api',
          confidence: 'high',
        },
      ],
    });
    expect(preferAccountByQuota(low, high).id).toBe('a');
    expect(quotaAvailabilityScore(low)).toBeGreaterThan(
      quotaAvailabilityScore(high),
    );
  });

  it('cooldown is high usage with score 0', () => {
    const e = entry({
      id: 'c',
      adapterId: 'codex',
      onCooldown: true,
      cooldownKind: 'rate-limit',
      cooldownUntil: Date.now() + 60_000,
      windows: [],
    });
    expect(isHighUsage(e)).toBe(true);
    expect(quotaAvailabilityScore(e)).toBe(0);
    expect(spawnWarningForAccount(e)).toMatch(/cooldown/i);
  });

  it('auth cooldown blocks spawning without inventing quota usage', () => {
    const e = entry({
      id: 'claude:expired',
      adapterId: 'claude',
      onCooldown: true,
      cooldownKind: 'auth',
      cooldownUntil: Date.now() + 60_000,
      windows: [
        {
          kind: 'hours',
          label: '5 Horas',
          usedRatio: null,
          source: 'unknown',
          confidence: 'low',
        },
      ],
    });

    expect(entryWorstRatio(e)).toBeNull();
    expect(isHighUsage(e)).toBe(false);
    expect(buildFleetSnapshot([e]).worstUsedRatio).toBeNull();
    expect(quotaAvailabilityScore(e)).toBe(0);
  });
});
