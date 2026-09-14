import { describe, expect, it, vi } from 'vitest';
import {
  fetchGlmUsageWindows,
  GLM_QUOTA_LIMIT_URL,
  parseGlmQuotaLimit,
} from './glm-usage';

/** Live-shaped fixture (Z.ai max plan). */
const GLM_FIXTURE = {
  code: 200,
  msg: 'Operation successful',
  success: true,
  data: {
    level: 'max',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
      {
        type: 'TOKENS_LIMIT',
        unit: 6,
        number: 1,
        percentage: 12,
        nextResetTime: 1784073369995,
      },
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 20,
        remaining: 3980,
        percentage: 1,
      },
    ],
  },
};

describe('parseGlmQuotaLimit', () => {
  const NOW = 1_700_000_000_000;

  it('maps 5h + weekly + MCP monthly percentages', () => {
    const w = parseGlmQuotaLimit(GLM_FIXTURE, NOW);
    expect(w.find((x) => x.kind === 'hours')).toMatchObject({
      label: '5 Horas',
      usedRatio: 0,
      source: 'provider-api',
      confidence: 'high',
    });
    expect(w.find((x) => x.kind === 'weekly')).toMatchObject({
      label: 'Semanal',
      usedRatio: 0.12,
      source: 'provider-api',
    });
    // Counts beat percentage: TIME_LIMIT usage=4000 currentValue=20 → 0.5%,
    // mesmo com o campo percentage (arredondado) dizendo 1.
    expect(w.find((x) => x.kind === 'monthly')).toMatchObject({
      label: 'MCP mensal',
      usedRatio: 0.005,
      source: 'provider-api',
    });
    expect(w.find((x) => x.kind === 'weekly')?.resetsAt).toBe(1784073369995);
  });

  it('exact counts take precedence over a stale percentage on token windows', () => {
    // percentage dizendo 1% enquanto as contagens reais mostram 25% usado —
    // a prática da comunidade (CodexBar/zai.md): contagens mandam.
    const w = parseGlmQuotaLimit(
      {
        data: {
          limits: [
            {
              type: 'TOKENS_LIMIT',
              unit: 6,
              number: 1,
              percentage: 1,
              usage: 800_000_000,
              currentValue: 200_000_000,
              remaining: 600_000_000,
              nextResetTime: 1784073369995,
            },
          ],
        },
      },
      NOW,
    );
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0.25);
  });

  it('falls back to percentage when counts are absent or unusable', () => {
    const w = parseGlmQuotaLimit(
      {
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 12 },
          ],
        },
      },
      NOW,
    );
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0.12);
  });

  it('returns empty for garbage', () => {
    expect(parseGlmQuotaLimit(null)).toEqual([]);
    expect(parseGlmQuotaLimit({})).toEqual([]);
  });
});

describe('fetchGlmUsageWindows', () => {
  it('sends Authorization without Bearer prefix', async () => {
    const fetchImpl = vi.fn(
      async (
        _url: string,
        _init?: {
          headers?: Record<string, string>;
          method?: string;
          signal?: AbortSignal;
        },
      ) => ({
        ok: true,
        status: 200,
        json: async () => GLM_FIXTURE,
        text: async () => '',
      }),
    );
    const windows = await fetchGlmUsageWindows('zai-key-123', {
      fetchImpl,
      now: Date.now(),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      GLM_QUOTA_LIMIT_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'zai-key-123',
        }),
      }),
    );
    expect(windows?.find((w) => w.kind === 'weekly')?.usedRatio).toBe(0.12);
  });

  it('returns null when API fails', async () => {
    expect(
      await fetchGlmUsageWindows('k', {
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          json: async () => ({}),
          text: async () => '',
        }),
      }),
    ).toBeNull();
  });
});
