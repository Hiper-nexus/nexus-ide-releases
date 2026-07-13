import { describe, expect, it, vi } from 'vitest';
import {
  AGY_RETRIEVE_USER_QUOTA_URL,
  fetchAgyUsageWindows,
  parseAgyUserQuota,
  parseGeminiOauthCredsJson,
} from './agy-usage';

const QUOTA_FIXTURE = {
  buckets: [
    {
      resetTime: '2026-07-14T02:00:38Z',
      tokenType: 'REQUESTS',
      modelId: 'gemini-2.5-flash',
      remainingFraction: 1,
    },
    {
      resetTime: '2026-07-14T02:00:38Z',
      tokenType: 'REQUESTS',
      modelId: 'gemini-2.5-pro',
      remainingFraction: 0.25,
    },
  ],
};

describe('parseAgyUserQuota', () => {
  it('maps remainingFraction to usedRatio (worst model)', () => {
    const w = parseAgyUserQuota(QUOTA_FIXTURE, Date.parse('2026-07-13T12:00:00Z'));
    expect(w).toHaveLength(1);
    // worst remaining 0.25 → used 0.75
    expect(w[0]?.usedRatio).toBeCloseTo(0.75);
    expect(w[0]?.source).toBe('provider-api');
    expect(w[0]?.kind).toBe('hours');
    expect(w[0]?.label).toBe('5 Horas');
  });

  it('treats remainingFraction 1 as real 0% used', () => {
    const w = parseAgyUserQuota({
      buckets: [
        { remainingFraction: 1, tokenType: 'REQUESTS', resetTime: '2026-07-14T00:00:00Z' },
      ],
    });
    expect(w[0]?.usedRatio).toBe(0);
  });
});

describe('fetchAgyUsageWindows', () => {
  it('refreshes expired token then calls retrieveUserQuota', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'fresh-at' }),
          text: async () => '',
        };
      }
      if (String(url).includes('retrieveUserQuota')) {
        return {
          ok: true,
          status: 200,
          json: async () => QUOTA_FIXTURE,
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });

    const windows = await fetchAgyUsageWindows(
      {
        accessToken: 'stale',
        refreshToken: 'rt',
        expiryDate: 1, // long expired
      },
      { fetchImpl: fetchImpl as never, now: Date.now() },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      AGY_RETRIEVE_USER_QUOTA_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fresh-at',
        }),
      }),
    );
    expect(windows?.[0]?.usedRatio).toBeCloseTo(0.75);
  });
});

describe('parseGeminiOauthCredsJson', () => {
  it('reads access + refresh + expiry', () => {
    const c = parseGeminiOauthCredsJson(
      JSON.stringify({
        access_token: 'at',
        refresh_token: 'rt',
        expiry_date: 123,
      }),
    );
    expect(c).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiryDate: 123,
    });
  });
});
