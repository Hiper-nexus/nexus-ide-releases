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
    expect(w.find((x) => x.kind === 'monthly')).toMatchObject({
      label: 'MCP mensal',
      usedRatio: 0.01,
      source: 'provider-api',
    });
    expect(w.find((x) => x.kind === 'weekly')?.resetsAt).toBe(1784073369995);
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
