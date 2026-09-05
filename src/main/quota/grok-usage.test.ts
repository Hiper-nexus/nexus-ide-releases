import { describe, expect, it, vi } from 'vitest';
import {
  fetchGrokUsageWindows,
  GROK_BILLING_URL,
  parseGrokBilling,
  parseGrokTeamsUsage,
  windowsFromRateLimitHeaders,
} from './grok-usage';

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
