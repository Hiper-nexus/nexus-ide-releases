import { describe, expect, it, vi } from 'vitest';
import {
  fetchGrokUsageWindows,
  GROK_BILLING_URL,
  GROK_CREDITS_URL,
  parseGrokBilling,
  parseGrokCredits,
  parseGrokTeamsUsage,
  probeGrokUsageWindows,
  windowsFromRateLimitHeaders,
} from './grok-usage';

/** Fixture shaped like GET /v1/billing?format=credits on a live SuperGrok
 * account (recorded by Codenotch, GrokUsage.swift). */
const CREDITS_FIXTURE = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-09-05T08:21:18.802818+00:00',
      end: '2026-09-12T08:21:18.802818+00:00',
    },
    creditUsagePercent: 8.0,
    productUsage: [{ product: 'GrokBuild', usagePercent: 8.0 }],
    billingPeriodStart: '2026-09-05T08:21:18.802818+00:00',
    billingPeriodEnd: '2026-09-12T08:21:18.802818+00:00',
  },
};

describe('parseGrokCredits', () => {
  const NOW = Date.parse('2026-09-08T12:00:00Z');

  it('maps creditUsagePercent (0–100) onto the weekly window with reset', () => {
    const w = parseGrokCredits(CREDITS_FIXTURE, NOW);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      kind: 'weekly',
      label: 'Semanal',
      usedRatio: 0.08,
      source: 'provider-api',
      confidence: 'high',
    });
    expect(w[0]?.resetsAt).toBe(Date.parse('2026-09-12T08:21:18.802818+00:00'));
    expect(w[0]?.remainingLabel).toBeTruthy();
  });

  it('treats 0% as a real reading, not absence', () => {
    const w = parseGrokCredits(
      {
        config: {
          ...CREDITS_FIXTURE.config,
          creditUsagePercent: 0,
        },
      },
      NOW,
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.usedRatio).toBe(0);
  });

  it('falls back to productUsage[].usagePercent when headline is missing', () => {
    const body = {
      config: {
        ...CREDITS_FIXTURE.config,
        creditUsagePercent: undefined,
      },
    };
    const w = parseGrokCredits(body, NOW);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe('weekly');
    expect(w[0]?.usedRatio).toBe(0.08);
  });

  it('fresh weekly period without percent is honest 0%, never unknown', () => {
    const body = {
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-09-05T08:21:18.802818+00:00',
          end: '2026-09-12T08:21:18.802818+00:00',
        },
      },
    };
    const w = parseGrokCredits(body, NOW);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      kind: 'weekly',
      label: 'Semanal',
      usedRatio: 0,
      source: 'provider-api',
    });
    expect(w[0]?.resetsAt).toBe(Date.parse('2026-09-12T08:21:18.802818+00:00'));
  });

  it('returns empty without weekly period nor percent (stay unknown upstream)', () => {
    expect(parseGrokCredits({ config: {} })).toEqual([]);
    expect(parseGrokCredits({})).toEqual([]);
    expect(parseGrokCredits(null)).toEqual([]);
    // Non-weekly period + no percent: nothing to meter honestly.
    expect(
      parseGrokCredits({
        config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_LEGACY' } },
      }),
    ).toEqual([]);
  });

  it('clamps percent above 100', () => {
    const w = parseGrokCredits(
      { config: { ...CREDITS_FIXTURE.config, creditUsagePercent: 140 } },
      NOW,
    );
    expect(w[0]?.usedRatio).toBe(1);
  });
});

const BILLING_FIXTURE = {
  config: {
    monthlyLimit: { val: 150_000 },
    used: { val: 21_104 },
    onDemandCap: { val: 0 },
    billingPeriodStart: '2026-07-01T00:00:00+00:00',
    billingPeriodEnd: '2026-08-01T00:00:00+00:00',
  },
};

describe('parseGrokBilling', () => {
  it.each([0, 0.5, 1, 50, 100])('interprets explicit team percent %s on a 0–100 scale', (percent) => {
    expect(parseGrokTeamsUsage({ used_percent: percent })[0]?.usedRatio).toBe(percent / 100);
  });
  it('maps monthly used/limit from CLI billing response', () => {
    const w = parseGrokBilling(BILLING_FIXTURE, Date.parse('2026-07-13T00:00:00Z'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      kind: 'monthly',
      label: 'Mensal',
      source: 'provider-api',
      confidence: 'high',
    });
    // 21104/150000 ≈ 0.1407
    expect(w[0]?.usedRatio).toBeCloseTo(21_104 / 150_000, 4);
    expect(w[0]?.resetsAt).toBe(Date.parse('2026-08-01T00:00:00+00:00'));
  });

  it('returns empty without inventing when fields missing', () => {
    expect(parseGrokBilling({})).toEqual([]);
    expect(parseGrokBilling(null)).toEqual([]);
  });
});

describe('windowsFromRateLimitHeaders', () => {
  it('builds RPM window from remaining/limit request headers', () => {
    const w = windowsFromRateLimitHeaders({
      'x-ratelimit-remaining-requests': '700',
      'x-ratelimit-limit-requests': '900',
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      kind: 'hours',
      label: 'RPM API',
      usedRatio: expect.closeTo(1 - 700 / 900, 5),
      source: 'provider-api',
    });
  });
});

describe('fetchGrokUsageWindows', () => {
  it('probes ?format=credits first with X-XAI-Token-Auth and returns weekly %', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('format=credits')) {
        return {
          ok: true,
          status: 200,
          json: async () => CREDITS_FIXTURE,
          text: async (): Promise<string> => '',
          headers: { get: (): null => null },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async (): Promise<string> => '',
        headers: { get: (): null => null },
      };
    });

    const w = await fetchGrokUsageWindows('jwt-token', {
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      GROK_CREDITS_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          'X-XAI-Token-Auth': 'xai-grok-cli',
        }),
      }),
    );
    // Credits answered — legacy /billing must not even be asked.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(w?.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0.08);
  });

  it('falls back to legacy monthly billing when credits has nothing', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('format=credits')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ config: {} }),
          text: async (): Promise<string> => '',
          headers: { get: (): null => null },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => BILLING_FIXTURE,
        text: async (): Promise<string> => '',
        headers: { get: (): null => null },
      };
    });

    const w = await fetchGrokUsageWindows('jwt-token', {
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      GROK_BILLING_URL,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(w?.find((x) => x.kind === 'monthly')?.usedRatio).toBeCloseTo(
      21_104 / 150_000,
      4,
    );
  });

  it('calls /v1/billing and returns Mensal %', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/billing')) {
        return {
          ok: true,
          status: 200,
          json: async () => BILLING_FIXTURE,
          text: async (): Promise<string> => '',
          headers: { get: (): null => null },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
        text: async (): Promise<string> => '',
        headers: { get: (): null => null },
      };
    });

    const w = await fetchGrokUsageWindows('jwt-token', {
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      GROK_BILLING_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
        }),
      }),
    );
    expect(w?.find((x) => x.kind === 'monthly')?.usedRatio).toBeCloseTo(
      21_104 / 150_000,
      4,
    );
  });
});

describe('probeGrokUsageWindows', () => {
  const rejected = () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Invalid or expired credentials' }),
    text: async (): Promise<string> => '',
    headers: { get: (): null => null },
  });

  it('flags authFailed when every endpoint rejects the token (401)', async () => {
    const probe = await probeGrokUsageWindows('dead-jwt', {
      fetchImpl: vi.fn(rejected) as never,
    });
    expect(probe.windows).toBeNull();
    expect(probe.authFailed).toBe(true);
  });

  it('does not flag authFailed on transient failures (500)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async (): Promise<string> => '',
      headers: { get: (): null => null },
    }));
    const probe = await probeGrokUsageWindows('jwt', {
      fetchImpl: fetchImpl as never,
    });
    expect(probe.windows).toBeNull();
    expect(probe.authFailed).toBeFalsy();
  });

  it('windows win over a partial auth rejection', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('format=credits')) {
        return rejected() as never;
      }
      return {
        ok: true,
        status: 200,
        json: async () => BILLING_FIXTURE,
        text: async (): Promise<string> => '',
        headers: { get: (): null => null },
      };
    });
    const probe = await probeGrokUsageWindows('jwt', {
      fetchImpl: fetchImpl as never,
    });
    expect(probe.windows?.find((x) => x.kind === 'monthly')).toBeTruthy();
    expect(probe.authFailed).toBeFalsy();
  });
});
