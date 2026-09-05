import { describe, expect, it, vi } from 'vitest';
import { fetchLiveProviderWindows, parseKimiUsage } from './provider-live-usage';

const nativeOpenCode = vi.hoisted(() => vi.fn(() => [{ providerId: 'custom', key: 'native-other-account' }]));
vi.mock('./opencode-auth', () => ({ loadOpenCodeAuthKeys: nativeOpenCode }));

describe('fetchLiveProviderWindows', () => {
  it('uses an explicitly routed provider without changing the adapter/account that owns the key', async () => {
    const resolveApiQuotaKey = vi.fn(() => 'owner-bound-key');
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requests.push(new URL(url).hostname);
      return { ok: false, status: 403, json: async () => ({}), text: async () => '' };
    });
    await fetchLiveProviderWindows('claude', 'exact-account', { resolveApiQuotaKey, fetchImpl }, 100, 'glm', 'api-key');
    expect(resolveApiQuotaKey).toHaveBeenCalledWith({ adapterId: 'claude', accountId: 'exact-account', usageProviderId: 'glm', authMode: 'api-key' });
    expect(requests).toEqual(['api.z.ai']);
  });

  it('does not replace a missing routed account credential with the destination provider global key', async () => {
    const resolveApiQuotaKey = vi.fn(() => null);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' }));
    expect(await fetchLiveProviderWindows('claude', 'missing-account', { resolveApiQuotaKey, fetchImpl }, 100, 'glm', 'api-key')).toBeNull();
    expect(resolveApiQuotaKey).toHaveBeenCalledWith({ adapterId: 'claude', accountId: 'missing-account', usageProviderId: 'glm', authMode: 'api-key' });
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it('never falls back to the flattened generic key list for a declared route', async () => {
    const resolveGenericApiKeyCandidates = vi.fn(() => ['fixture-foreign-key']);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' }));
    expect(await fetchLiveProviderWindows('aider', undefined, { resolveGenericApiKeyCandidates, fetchImpl }, 100, 'glm', 'api-key')).toBeNull();
    expect(resolveGenericApiKeyCandidates.mock.calls.length + fetchImpl.mock.calls.length).toBe(0);
  });
  it('preserves the declared provider of a native OpenCode key for quota routing', async () => {
    nativeOpenCode.mockReturnValueOnce([{ providerId: 'zai', key: 'opaque-provider-owned-key' }]);
    const origins: string[] = [];
    await fetchLiveProviderWindows('opencode', undefined, {
      fetchImpl: async (url) => {
        origins.push(new URL(url).hostname);
        return { ok: false, status: 403, json: async () => ({}), text: async () => '' };
      },
    });
    expect(origins).toEqual(['api.z.ai']);
  });
  it('never reads native OpenCode keys for an account-bound quota row', async () => {
    nativeOpenCode.mockClear();
    const result = await fetchLiveProviderWindows('opencode', 'saved-account', {
      resolveGenericApiKeyCandidates: () => [],
      fetchImpl: vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' })),
    });
    expect(result).toBeNull();
    expect(nativeOpenCode).not.toHaveBeenCalled();
  });
  it('dispatches claude + codex + glm with resolvers', async () => {
    const fetchImpl = vi.fn(
      async (
        url: string,
        _init?: {
          headers?: Record<string, string>;
          method?: string;
          signal?: AbortSignal;
        },
      ) => {
        if (url.includes('anthropic.com')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              five_hour: { utilization: 10 },
              seven_day: { utilization: 20 },
            }),
            text: async () => '',
          };
        }
        if (url.includes('wham/usage')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              rate_limit: {
                primary_window: {
                  used_percent: 15,
                  limit_window_seconds: 604800,
                },
              },
            }),
            text: async () => '',
          };
        }
        if (url.includes('quota/limit')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                limits: [
                  { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 5 },
                  { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 25 },
                ],
              },
            }),
            text: async () => '',
          };
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => '',
        };
      },
    );

    const claude = await fetchLiveProviderWindows('claude', undefined, {
      resolveClaudeToken: () => 'claude-tok',
      fetchImpl,
    });
    expect(claude?.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.1);

    const codex = await fetchLiveProviderWindows('codex', undefined, {
      resolveCodexAuthCandidates: () => [
        { accessToken: 'codex-tok', accountId: 'a' },
      ],
      fetchImpl,
    });
    expect(codex?.find((w) => w.kind === 'weekly')?.usedRatio).toBe(0.15);

    const glm = await fetchLiveProviderWindows('glm', undefined, {
      resolveGlmApiKeyCandidates: () => ['bad-key', 'glm-key'],
      fetchImpl,
    });
    expect(glm?.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.05);
    expect(glm?.find((w) => w.kind === 'weekly')?.usedRatio).toBe(0.25);
  });

  it('returns null for grok/agy/longcat without inventing %', async () => {
    const failFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    }));
    expect(
      await fetchLiveProviderWindows('grok', undefined, {
        resolveGrokToken: () => 'jwt',
        fetchImpl: failFetch,
      }),
    ).toBeNull();
    expect(
      await fetchLiveProviderWindows('agy', undefined, {
        resolveGeminiToken: () => 'gat',
        // expired-looking token without refresh → null / fail
        resolveGeminiOauthCreds: () => ({ accessToken: 'gat' }),
        fetchImpl: failFetch,
      }),
    ).toBeNull();
    expect(
      await fetchLiveProviderWindows('longcat', undefined, {
        resolveLongcatApiKey: () => 'longcat-key-value-here',
        fetchImpl: failFetch,
      }),
    ).toBeNull();
  });

  it('returns null when resolver missing or token null', async () => {
    expect(await fetchLiveProviderWindows('claude', undefined, {})).toBeNull();
    expect(
      await fetchLiveProviderWindows('glm', undefined, {
        resolveGlmApiKey: () => null,
      }),
    ).toBeNull();
  });
});

describe('parseKimiUsage', () => {
  it.each([0, 0.5, 1, 50, 100])('interprets the explicit percent field %s on a 0–100 scale', (percent) => {
    expect(parseKimiUsage({ five_hour_usage_percent: percent })[0]?.usedRatio).toBe(percent / 100);
  });
  it('maps known percent fields', () => {
    const w = parseKimiUsage({
      five_hour_usage_percent: 30,
      weekly_usage_percent: 55,
    });
    expect(w.find((x) => x.kind === 'hours')?.usedRatio).toBe(0.3);
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0.55);
  });
});
