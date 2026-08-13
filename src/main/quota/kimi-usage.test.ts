import { describe, expect, it, vi } from 'vitest';
import {
  fetchKimiCodingUsageWindows,
  fetchKimiUsageWithOauth,
  KIMI_OAUTH_TOKEN_URL,
  KIMI_USAGES_URL,
  parseKimiUsagesPayload,
} from './kimi-usage';

/** Live shape from Kimi CLI OAuth /usages (2026-07). */
const LIVE_USAGES = {
  user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
  usage: {
    limit: '100',
    remaining: '100',
    resetTime: '2026-07-19T20:35:00.441410Z',
  },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: {
        limit: '100',
        remaining: '100',
        resetTime: '2026-07-13T05:35:00.441410Z',
      },
    },
  ],
  totalQuota: { limit: '100', remaining: '99' },
};

describe('parseKimiUsagesPayload', () => {
  it('maps weekly usage + 5h limit window (300 minutes)', () => {
    const w = parseKimiUsagesPayload(LIVE_USAGES);
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0); // 100-100
    expect(w.find((x) => x.kind === 'hours')?.usedRatio).toBe(0);
    expect(w.find((x) => x.kind === 'hours')?.label).toBe('5 Horas');
    expect(w.every((x) => x.source === 'provider-api')).toBe(true);
  });

  it('computes used from remaining strings', () => {
    const w = parseKimiUsagesPayload({
      usage: { limit: '100', remaining: '40', resetTime: '2026-07-20T00:00:00Z' },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '50', remaining: '10' },
        },
      ],
    });
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBeCloseTo(0.6);
    expect(w.find((x) => x.kind === 'hours')?.usedRatio).toBeCloseTo(0.8);
  });
});

describe('fetchKimiUsageWithOauth', () => {
  it('refreshes expired token then hits /usages', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'fresh-at',
            refresh_token: 'fresh-rt',
            expires_in: 900,
          }),
          text: async () => '',
        };
      }
      if (String(url).includes('/usages')) {
        return {
          ok: true,
          status: 200,
          json: async () => LIVE_USAGES,
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });

    const w = await fetchKimiUsageWithOauth(
      {
        accessToken: 'stale',
        refreshToken: 'rt',
        expiresAt: 1,
      },
      {
        fetchImpl: fetchImpl as never,
        allowRefresh: true,
        persistRefresh: false,
        now: Date.now(),
      },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      KIMI_OAUTH_TOKEN_URL,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      KIMI_USAGES_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fresh-at',
        }),
      }),
    );
    expect(w?.some((x) => x.kind === 'hours')).toBe(true);
    expect(w?.some((x) => x.kind === 'weekly')).toBe(true);
  });

  it('não rotaciona o grant nativo — access expirado usa o token atual', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        throw new Error('quota probe must not refresh native kimi-code');
      }
      if (String(url).includes('/usages')) {
        return {
          ok: true,
          status: 200,
          json: async () => LIVE_USAGES,
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });

    const w = await fetchKimiUsageWithOauth(
      {
        accessToken: 'stale-but-cli-owned',
        refreshToken: 'rt-must-not-be-spent',
        expiresAt: 1,
      },
      { fetchImpl: fetchImpl as never, now: Date.now() },
    );

    expect(fetchImpl).not.toHaveBeenCalledWith(
      KIMI_OAUTH_TOKEN_URL,
      expect.anything(),
    );
    expect(w?.some((x) => x.kind === 'weekly')).toBe(true);
  });
});

describe('fetchKimiCodingUsageWindows', () => {
  it('calls /usages with Bearer key', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => LIVE_USAGES,
      text: async () => '',
    }));
    const w = await fetchKimiCodingUsageWindows('sk-kimi-test', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      KIMI_USAGES_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-kimi-test',
        }),
      }),
    );
    expect(w?.length).toBeGreaterThan(0);
  });
});
