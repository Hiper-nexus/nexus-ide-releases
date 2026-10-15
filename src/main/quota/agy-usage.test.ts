import { describe, expect, it, vi } from 'vitest';
import {
  AGY_RETRIEVE_USER_QUOTA_URL,
  GEMINI_TOKEN_URL,
  fetchAgyUsageWindows,
  parseAgyUserQuota,
  parseGeminiOauthCredsJson,
  refreshGeminiAccessToken,
  type GeminiRefreshedGrant,
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
    expect(w[0]?.kind).toBe('session');
    expect(w[0]?.label).toBe('Cota Google');
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
      { fetchImpl: fetchImpl as never, now: Date.now(), allowRefresh: true },
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

/** Token endpoint do Google + retrieveUserQuota com o fixture. */
function googleFetch(tokenResponse: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    if (url === GEMINI_TOKEN_URL) {
      return { ok: true, status: 200, json: async () => tokenResponse };
    }
    if (url === AGY_RETRIEVE_USER_QUOTA_URL) {
      return { ok: true, status: 200, json: async () => QUOTA_FIXTURE };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('refreshGeminiAccessToken', () => {
  it('devolve o grant inteiro: access, refresh rotacionado, expiry e id_token', async () => {
    const fetchImpl = googleFetch({
      access_token: 'at-2',
      refresh_token: 'rt-2',
      expires_in: 3599,
      id_token: 'idt-2',
      token_type: 'Bearer',
    });
    await expect(
      refreshGeminiAccessToken('rt-1', { fetchImpl: fetchImpl as never, now: 1_000 }),
    ).resolves.toEqual({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiryDate: 1_000 + 3_599_000,
      idToken: 'idt-2',
    });
  });

  it('sem rotação não inventa refresh token; sem access é falha', async () => {
    await expect(
      refreshGeminiAccessToken('rt-1', {
        fetchImpl: googleFetch({ access_token: 'at-2', expires_in: 3600 }) as never,
        now: 0,
      }),
    ).resolves.toEqual({ accessToken: 'at-2', expiryDate: 3_600_000 });
    await expect(
      refreshGeminiAccessToken('rt-1', {
        fetchImpl: googleFetch({ refresh_token: 'rt-2' }) as never,
      }),
    ).resolves.toBeNull();
  });
});

describe('fetchAgyUsageWindows write-back', () => {
  const NOW = Date.parse('2026-10-15T12:00:00Z');
  const expired = { accessToken: 'stale', refreshToken: 'rt-1', expiryDate: NOW - 1 };

  it('entrega o grant renovado a persistRefreshed e devolve a cota', async () => {
    const persisted: GeminiRefreshedGrant[] = [];
    const windows = await fetchAgyUsageWindows(expired, {
      fetchImpl: googleFetch({
        access_token: 'fresh-at',
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      }) as never,
      now: NOW,
      allowRefresh: true,
      persistRefreshed: (grant) => persisted.push(grant),
    });
    expect(persisted).toEqual([
      { accessToken: 'fresh-at', refreshToken: 'rt-rotated', expiryDate: NOW + 3_600_000 },
    ]);
    expect(windows?.[0]?.usedRatio).toBeCloseTo(0.75);
  });

  it('write-back que falha não derruba a leitura deste ciclo', async () => {
    const windows = await fetchAgyUsageWindows(expired, {
      fetchImpl: googleFetch({ access_token: 'fresh-at', expires_in: 3600 }) as never,
      now: NOW,
      allowRefresh: true,
      persistRefreshed: () => {
        throw new Error('vault indisponível');
      },
    });
    expect(windows?.[0]?.usedRatio).toBeCloseTo(0.75);
  });

  it('access vigente não refresca nem persiste', async () => {
    const fetchImpl = googleFetch({ access_token: 'unused' });
    const persistRefreshed = vi.fn();
    await fetchAgyUsageWindows(
      { ...expired, expiryDate: NOW + 3_600_000 },
      { fetchImpl: fetchImpl as never, now: NOW, allowRefresh: true, persistRefreshed },
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(GEMINI_TOKEN_URL, expect.anything());
    expect(persistRefreshed).not.toHaveBeenCalled();
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

describe('windowsFromAgyTier', () => {
  it('labels free-tier without inventing usedRatio', async () => {
    const { windowsFromAgyTier } = await import('./agy-usage');
    const w = windowsFromAgyTier({
      currentTier: { id: 'free-tier', name: 'Antigravity' },
    });
    expect(w).toHaveLength(2);
    expect(w.every((x) => x.usedRatio === null)).toBe(true);
    expect(w[0]?.remainingLabel).toMatch(/free-tier/);
  });
});
