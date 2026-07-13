import { describe, expect, it, vi } from 'vitest';
import { fetchLiveProviderWindows, parseKimiUsage } from './provider-live-usage';

describe('fetchLiveProviderWindows', () => {
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
    expect(claude?.find((w) => w.kind === 'session')?.usedRatio).toBe(0.1);

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
    expect(
      await fetchLiveProviderWindows('grok', undefined, {
        resolveGrokToken: () => 'jwt',
      }),
    ).toBeNull();
    expect(
      await fetchLiveProviderWindows('agy', undefined, {
        resolveGeminiToken: () => 'gat',
      }),
    ).toBeNull();
    expect(
      await fetchLiveProviderWindows('longcat', undefined, {
        resolveLongcatApiKey: () => 'key',
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
  it('maps known percent fields', () => {
    const w = parseKimiUsage({
      five_hour_usage_percent: 30,
      weekly_usage_percent: 55,
    });
    expect(w.find((x) => x.kind === 'hours')?.usedRatio).toBe(0.3);
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0.55);
  });
});
