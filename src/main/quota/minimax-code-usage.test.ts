import { describe, expect, it, vi } from 'vitest';
import { fetchMinimaxTokenPlan, parseMinimaxTokenPlan } from './minimax-code-usage';

const NOW = 1_800_000_000_000;
const body = {
  base_resp: { status_code: 0 },
  model_remains: [{
    model_name: 'MiniMax-M3',
    current_interval_total_count: 100,
    current_interval_usage_count: 30,
    current_interval_remaining_percent: 80,
    current_interval_status: 1,
    end_time: NOW + 3_600_000,
    current_weekly_total_count: 200,
    current_weekly_usage_count: 50,
    current_weekly_status: 1,
    weekly_end_time: NOW + 604_800_000,
  }],
};

function response(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => '' };
}

describe('MiniMax Token Plan', () => {
  it('uses explicit remaining percent before counts and converts remaining into used', () => {
    const windows = parseMinimaxTokenPlan(body, NOW);
    expect(windows).toMatchObject([
      { kind: 'hours', resetsAt: NOW + 3_600_000, source: 'provider-api' },
      { kind: 'weekly', resetsAt: NOW + 604_800_000, source: 'provider-api' },
    ]);
    expect(windows[0]?.usedRatio).toBeCloseTo(0.2);
    expect(windows[1]?.usedRatio).toBeCloseTo(0.75);
  });

  it('represents unlimited without fabricating a used percentage', () => {
    const windows = parseMinimaxTokenPlan({
      ...body,
      model_remains: [{ ...body.model_remains[0], current_interval_status: 3, current_weekly_status: 3 }],
    }, NOW);
    expect(windows.map((w) => [w.usedRatio, w.remainingLabel])).toEqual([
      [null, 'Ilimitado'], [null, 'Ilimitado'],
    ]);
  });

  it('rejects provider errors, missing models and invalid counts', () => {
    expect(parseMinimaxTokenPlan({ ...body, base_resp: { status_code: 1001 } })).toEqual([]);
    expect(parseMinimaxTokenPlan({ ...body, model_remains: [] })).toEqual([]);
    expect(parseMinimaxTokenPlan({ ...body, model_remains: [{ current_interval_total_count: 0, current_interval_usage_count: 0 }] })).toEqual([]);
  });

  it('uses only the public endpoints and returns unknown when both regions refuse the key', async () => {
    const fetchImpl = vi.fn(async (_url: string) => response(401, body));
    expect(await fetchMinimaxTokenPlan('subscription-key', { fetchImpl })).toBeNull();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://www.minimax.io/v1/token_plan/remains',
      'https://www.minimaxi.com/v1/token_plan/remains',
    ]);
    expect(fetchImpl).toHaveBeenCalledWith('https://www.minimax.io/v1/token_plan/remains', expect.objectContaining({
      method: 'GET',
      headers: { Authorization: 'Bearer subscription-key', 'Content-Type': 'application/json' },
    }));
  });

  it('falls back to the other region once when the preferred one refuses the key', async () => {
    const fetchImpl = vi.fn(async (url: string) => url.includes('minimaxi.com')
      ? response(200, body)
      : response(200, { base_resp: { status_code: 1004, status_msg: 'invalid key' } }));
    const windows = await fetchMinimaxTokenPlan('cn-key', { fetchImpl, now: NOW });
    expect(windows?.[0]?.usedRatio).toBeCloseTo(0.2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not switch region on a network or server failure', async () => {
    const fetchImpl = vi.fn(async (_url: string) => response(503, {}));
    expect(await fetchMinimaxTokenPlan('key', { fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('supports the documented China endpoint when selected', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' }));
    expect((await fetchMinimaxTokenPlan('key', { fetchImpl, region: 'cn', now: NOW }))?.[0]?.usedRatio).toBeCloseTo(0.2);
    expect(fetchImpl).toHaveBeenCalledWith('https://www.minimaxi.com/v1/token_plan/remains', expect.anything());
  });
});
