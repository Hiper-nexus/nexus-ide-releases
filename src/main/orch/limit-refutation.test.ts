import { describe, expect, it } from 'vitest';
import type {
  ProviderQuotaEntry,
  QuotaWindow,
} from '../../shared/quota-types';
import { providerApiRefutesLimit, REFUTE_FRESH_MS } from './limit-refutation';

const NOW = 1_000_000_000;

function win(partial: Partial<QuotaWindow>): QuotaWindow {
  return {
    kind: 'hours',
    label: '5 Horas',
    usedRatio: 0.07,
    source: 'provider-api',
    confidence: 'high',
    ...partial,
  };
}

function entry(partial: Partial<ProviderQuotaEntry>): ProviderQuotaEntry {
  return {
    id: 'claude:account-a',
    adapterId: 'claude',
    accountId: 'account-a',
    label: 'conta adm',
    installed: true,
    onCooldown: false,
    updatedAt: NOW,
    windows: [],
    ...partial,
  };
}

describe('providerApiRefutesLimit', () => {
  it('refutes a rate-limit hit when the 5h provider-api reading is clearly healthy', () => {
    const e = entry({ windows: [win({ kind: 'hours', usedRatio: 0.07 })] });
    expect(providerApiRefutesLimit(e, { kind: 'rate-limit' }, NOW)).toBe(true);
  });

  it('refutes a quota hit when the weekly provider-api reading is clearly healthy', () => {
    const e = entry({
      windows: [win({ kind: 'weekly', label: 'Semanal', usedRatio: 0.16 })],
    });
    expect(providerApiRefutesLimit(e, { kind: 'quota' }, NOW)).toBe(true);
  });

  it('does NOT refute auth hits (credential validity is orthogonal to usage)', () => {
    const e = entry({ windows: [win({ kind: 'hours', usedRatio: 0.07 })] });
    expect(providerApiRefutesLimit(e, { kind: 'auth' }, NOW)).toBe(false);
  });

  it('does NOT refute transient hits (already short, self-healing)', () => {
    const e = entry({ windows: [win({ kind: 'hours', usedRatio: 0.07 })] });
    expect(providerApiRefutesLimit(e, { kind: 'transient' }, NOW)).toBe(false);
  });

  it('does NOT refute a scoped (per-tier) hit — an account-wide reading cannot clear it', () => {
    const e = entry({ windows: [win({ kind: 'hours', usedRatio: 0.07 })] });
    expect(
      providerApiRefutesLimit(e, { kind: 'rate-limit', scope: 'tier:opus' }, NOW),
    ).toBe(false);
  });

  it('does NOT refute when the relevant window is near its limit', () => {
    const e = entry({ windows: [win({ kind: 'hours', usedRatio: 0.92 })] });
    expect(providerApiRefutesLimit(e, { kind: 'rate-limit' }, NOW)).toBe(false);
  });

  it('does NOT refute when the reading is stale', () => {
    const e = entry({
      updatedAt: NOW - REFUTE_FRESH_MS - 1,
      windows: [win({ kind: 'hours', usedRatio: 0.07 })],
    });
    expect(providerApiRefutesLimit(e, { kind: 'rate-limit' }, NOW)).toBe(false);
  });

  it('does NOT refute when there is no provider-api window (only cooldown/unknown)', () => {
    // The reported case: the account only carries cooldown+unknown windows, so
    // there is no authoritative reading to refute with — fall back to the PTY.
    const e = entry({
      onCooldown: true,
      windows: [
        win({ kind: 'hours', source: 'cooldown', usedRatio: 1 }),
        win({ kind: 'hours', source: 'unknown', usedRatio: null }),
      ],
    });
    expect(providerApiRefutesLimit(e, { kind: 'rate-limit' }, NOW)).toBe(false);
  });

  it('does NOT refute a quota hit using only an hours window (wrong kind)', () => {
    // A plan-exhaustion (weekly) claim is not cleared by a healthy 5h reading.
    const e = entry({ windows: [win({ kind: 'hours', usedRatio: 0.07 })] });
    expect(providerApiRefutesLimit(e, { kind: 'quota' }, NOW)).toBe(false);
  });

  it('does NOT refute when any relevant provider-api window is near limit', () => {
    const e = entry({
      windows: [
        win({ kind: 'hours', usedRatio: 0.07 }),
        win({ kind: 'session', usedRatio: 0.95 }),
      ],
    });
    expect(providerApiRefutesLimit(e, { kind: 'rate-limit' }, NOW)).toBe(false);
  });

  it('returns false for an unknown (missing) entry', () => {
    expect(providerApiRefutesLimit(undefined, { kind: 'quota' }, NOW)).toBe(false);
  });
});
