import { describe, expect, it } from 'vitest';
import type {
  ProviderQuotaEntry,
  QuotaWindow,
} from '../../shared/quota-types';
import {
  hasFreshProviderApiWindowForLimit,
  providerApiExhaustsAccount,
  longCooldownNeedsFreshProviderApi,
  providerApiRefutesCooldown,
  providerApiRefutesLimit,
  LONG_COOLDOWN_MIN_MS,
  REFUTE_FRESH_MS,
} from './limit-refutation';

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

describe('provider-api authority for long cooldowns', () => {
  it('requires provider-api for long usage cooldowns, but preserves auth/transient and short backoff', () => {
    expect(
      longCooldownNeedsFreshProviderApi({
        kind: 'quota',
        cooldownMs: 12 * 60 * 60 * 1000,
      }),
    ).toBe(true);
    expect(
      longCooldownNeedsFreshProviderApi({
        kind: 'rate-limit',
        cooldownMs: LONG_COOLDOWN_MIN_MS,
      }),
    ).toBe(true);
    expect(
      longCooldownNeedsFreshProviderApi({
        kind: 'rate-limit',
        cooldownMs: LONG_COOLDOWN_MIN_MS - 1,
      }),
    ).toBe(false);
    expect(
      longCooldownNeedsFreshProviderApi({
        kind: 'auth',
        cooldownMs: 12 * 60 * 60 * 1000,
      }),
    ).toBe(false);
    expect(
      longCooldownNeedsFreshProviderApi({
        kind: 'transient',
        cooldownMs: 12 * 60 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it('accepts only a fresh, matching provider-api window as authority', () => {
    const rateEntry = entry({
      windows: [win({ kind: 'hours', usedRatio: 0.92 })],
    });
    expect(
      hasFreshProviderApiWindowForLimit(
        rateEntry,
        { kind: 'rate-limit' },
        NOW,
      ),
    ).toBe(true);
    expect(
      hasFreshProviderApiWindowForLimit(
        {
          ...rateEntry,
          updatedAt: NOW - REFUTE_FRESH_MS - 1,
        },
        { kind: 'rate-limit' },
        NOW,
      ),
    ).toBe(false);
    expect(
      hasFreshProviderApiWindowForLimit(
        entry({
          windows: [
            win({ kind: 'hours', source: 'limit-hit', usedRatio: 1 }),
          ],
        }),
        { kind: 'rate-limit' },
        NOW,
      ),
    ).toBe(false);
    expect(
      hasFreshProviderApiWindowForLimit(
        entry({
          windows: [win({ kind: 'weekly', usedRatio: 0.99 })],
        }),
        { kind: 'rate-limit' },
        NOW,
      ),
    ).toBe(false);
    expect(
      hasFreshProviderApiWindowForLimit(
        entry({
          windows: [win({ kind: 'weekly', usedRatio: 0.99 })],
        }),
        { kind: 'quota' },
        NOW,
      ),
    ).toBe(true);
    expect(
      hasFreshProviderApiWindowForLimit(
        entry({
          windows: [win({ kind: 'weekly', usedRatio: null })],
        }),
        { kind: 'quota' },
        NOW,
      ),
    ).toBe(false);
    expect(
      hasFreshProviderApiWindowForLimit(
        undefined,
        { kind: 'quota' },
        NOW,
      ),
    ).toBe(false);
  });
});

describe('providerApiRefutesCooldown', () => {
  it('refuta cooldown persistido quando toda leitura provider-api está saudável', () => {
    // Resíduo da cascata fantasma: conta em cooldown 10h+ com cota sobrando.
    const windows = [
      win({ kind: 'hours', usedRatio: 0.12 }),
      win({ kind: 'weekly', label: 'Semanal', usedRatio: 0.3 }),
    ];
    expect(providerApiRefutesCooldown(windows, NOW - 1000, NOW)).toBe(true);
  });

  it('NÃO refuta quando alguma janela está perto do teto', () => {
    const windows = [
      win({ kind: 'hours', usedRatio: 0.12 }),
      win({ kind: 'weekly', label: 'Semanal', usedRatio: 0.92 }),
    ];
    expect(providerApiRefutesCooldown(windows, NOW - 1000, NOW)).toBe(false);
  });

  it('refuta conta pausada com uso alto mas comprovadamente não bloqueado (Semanal 54%)', () => {
    // O caso real do cockpit: cooldown de quota gravado, leitura fresca diz
    // 54% semanal + 5h unknown. 54% é "uso alto com folga" — manter a conta
    // travada em 100% falso era o bug. Abaixo de 0.8 (limiar de uso elevado)
    // a leitura autoritativa desmente o sinal textual.
    const windows = [
      win({ kind: 'hours', usedRatio: null }),
      win({ kind: 'weekly', label: 'Semanal', usedRatio: 0.54 }),
    ];
    expect(providerApiRefutesCooldown(windows, NOW - 1000, NOW)).toBe(true);
  });

  it('NÃO refuta no limiar de uso elevado (0.8)', () => {
    const windows = [win({ kind: 'weekly', label: 'Semanal', usedRatio: 0.8 })];
    expect(providerApiRefutesCooldown(windows, NOW - 1000, NOW)).toBe(false);
  });

  it('NÃO refuta com leitura velha demais', () => {
    const windows = [win({ usedRatio: 0.1 })];
    expect(
      providerApiRefutesCooldown(windows, NOW - REFUTE_FRESH_MS - 1, NOW),
    ).toBe(false);
  });

  it('NÃO refuta sem nenhum ratio provider-api conhecido', () => {
    expect(providerApiRefutesCooldown([], NOW, NOW)).toBe(false);
    expect(
      providerApiRefutesCooldown(
        [win({ source: 'limit-hit', usedRatio: 1 })],
        NOW,
        NOW,
      ),
    ).toBe(false);
  });
});


describe('providerApiExhaustsAccount — cross-window measured exhaustion', () => {
  it.each(['quota', 'rate-limit'] as const)('requires 100% in the opposite window for %s', (kind) => {
    const opposite = kind === 'quota' ? 'hours' : 'weekly';
    for (const [usedRatio, exhausted] of [[0.79, false], [0.8, false], [0.99, false], [1, true]] as const) {
      expect(providerApiExhaustsAccount(entry({ windows: [win({ kind: opposite, usedRatio })] }), { kind }, NOW))
        .toBe(exhausted);
    }
  });

  it.each(['weekly', 'monthly', 'credits', 'hours', 'session'] as const)('accepts measured account window %s', (kind) => {
    expect(providerApiExhaustsAccount(entry({ windows: [win({ kind, usedRatio: 1 })] }), { kind: 'quota' }, NOW)).toBe(true);
  });

  it('exhaustion overrides a healthy alleged-kind reading', () => {
    const e = entry({ windows: [win({ kind: 'hours', usedRatio: 0.1 }), win({ kind: 'weekly', usedRatio: 1 })] });
    expect(providerApiRefutesLimit(e, { kind: 'rate-limit' }, NOW)).toBe(false);
    expect(providerApiExhaustsAccount(e, { kind: 'rate-limit' }, NOW)).toBe(true);
  });

  it.each([0.79, 0.8, 0.99])('opposite %s alone does not refute or confirm', (usedRatio) => {
    const e = entry({ windows: [win({ kind: 'weekly', usedRatio })] });
    expect(providerApiRefutesLimit(e, { kind: 'rate-limit' }, NOW)).toBe(false);
    expect(providerApiExhaustsAccount(e, { kind: 'rate-limit' }, NOW)).toBe(false);
  });

  it.each(['auth', 'model', 'transient'] as const)('does not confirm %s', (kind) => {
    expect(providerApiExhaustsAccount(entry({ windows: [win({ usedRatio: 1 })] }), { kind }, NOW)).toBe(false);
  });

  it.each(['tier:opus', 'model:gpt-6'])('does not confirm scoped hit %s', (scope) => {
    expect(providerApiExhaustsAccount(entry({ windows: [win({ usedRatio: 1 })] }), { kind: 'quota', scope }, NOW)).toBe(false);
  });

  it('ignores missing/stale/future data, local windows, non-api sources and non-finite ratios', () => {
    for (const e of [undefined, entry({ updatedAt: NOW - REFUTE_FRESH_MS - 1, windows: [win({ usedRatio: 1 })] }),
      entry({ updatedAt: NOW + 1, windows: [win({ usedRatio: 1 })] }),
      entry({ updatedAt: NaN, windows: [win({ usedRatio: 1 })] }),
      ...[null, NaN, Infinity].map(usedRatio => entry({ windows: [win({ usedRatio })] })),
      entry({ windows: [win({ kind: 'local', usedRatio: 1 })] }),
      ...(['transcript-inferred', 'limit-hit', 'local-tokens', 'cooldown', 'unknown'] as const).map(source =>
        entry({ windows: [win({ source, usedRatio: 1 })] })),
    ]) expect(providerApiExhaustsAccount(e, { kind: 'quota' }, NOW)).toBe(false);
  });

  it('keeps matching-kind 0.8 policy without calling it measured exhaustion', () => {
    const e = entry({ windows: [win({ kind: 'hours', usedRatio: 0.8 })] });
    expect(providerApiRefutesLimit(e, { kind: 'rate-limit' }, NOW)).toBe(false);
    expect(hasFreshProviderApiWindowForLimit(e, { kind: 'rate-limit' }, NOW)).toBe(true);
    expect(providerApiExhaustsAccount(e, { kind: 'rate-limit' }, NOW)).toBe(false);
  });
});
