import { describe, expect, it, vi } from 'vitest';
import {
  fetchKimiCodingUsageWindows,
  KIMI_USAGES_URL,
  parseKimiUsagesPayload,
} from './kimi-usage';

describe('parseKimiUsagesPayload', () => {
  it('maps data[] used/limit with model_name all as weekly', () => {
    const w = parseKimiUsagesPayload({
      data: [
        { model_name: 'all', used: 25, limit: 100, resetTime: '2026-07-20T00:00:00Z' },
        { model_name: 'kimi-k2', name: '5 Hour', used: 40, limit: 100 },
      ],
    });
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0.25);
    expect(w.find((x) => x.kind === 'hours')?.usedRatio).toBe(0.4);
    expect(w.every((x) => x.source === 'provider-api')).toBe(true);
  });

  it('maps usage + limits windows by duration', () => {
    const w = parseKimiUsagesPayload({
      usage: { used: 10, limit: 100 },
      limits: [
        {
          window: { duration: 5, timeUnit: 'HOUR' },
          detail: { used: 50, limit: 100 },
        },
      ],
    });
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0.1);
    expect(w.find((x) => x.kind === 'hours')?.usedRatio).toBe(0.5);
  });
});

describe('fetchKimiCodingUsageWindows', () => {
  it('calls /usages with Bearer sk-kimi key', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ model_name: 'all', used: 1, limit: 10 }],
      }),
      text: async () => '',
    }));
    const w = await fetchKimiCodingUsageWindows('sk-kimi-test', {
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      KIMI_USAGES_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-kimi-test',
        }),
      }),
    );
    expect(w?.[0]?.usedRatio).toBe(0.1);
  });
});
