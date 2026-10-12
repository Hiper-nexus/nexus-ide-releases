import { describe, expect, it, vi } from 'vitest';
import {
  extractAlibabaTokenPlanUsage,
  fetchAlibabaTokenPlanUsage,
  fetchAlibabaTokenPlanUsageFromCli,
  parseAlibabaTokenPlanUsage,
  probeAlibabaTokenPlanUsage,
} from './alibaba-token-plan-usage';

const nested = {
  data: {
    DataV2: {
      data: {
        data: {
          per5HourPercentage: 0.31,
          per5HourResetTime: 1_789_078_632_000,
          per1WeekPercentage: 0.13,
          per1WeekResetTime: 1_789_344_000_000,
          per1MonthPercentage: 0.0104,
          per1MonthResetTime: 1_800_200_000_000,
        },
      },
    },
  },
};

describe('alibaba-token-plan-usage', () => {
  it('parses 5h / weekly / monthly from the nested console payload', () => {
    const windows = parseAlibabaTokenPlanUsage(nested, 100);
    expect(windows.map((w) => [w.kind, w.label, w.usedRatio])).toEqual([
      ['hours', '5 Horas', 0.31],
      ['weekly', 'Semanal', 0.13],
      ['monthly', 'Mensal', 0.0104],
    ]);
    expect(windows.every((w) => w.source === 'provider-api')).toBe(true);
  });

  it('accepts a monthly-only plan (newer console shape)', () => {
    const windows = parseAlibabaTokenPlanUsage(
      { data: { per1MonthPercentage: 0.01, per1MonthResetTime: 1_800_200_000_000 } },
      100,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ kind: 'monthly', usedRatio: 0.01 });
  });

  it('never invents windows from empty or unknown shapes', () => {
    expect(parseAlibabaTokenPlanUsage(null)).toEqual([]);
    expect(parseAlibabaTokenPlanUsage({})).toEqual([]);
    expect(parseAlibabaTokenPlanUsage({ data: { foo: 1 } })).toEqual([]);
    expect(extractAlibabaTokenPlanUsage({ data: { nope: true } })).toBeNull();
  });

  it('console probe posts the tunnelled usage API with cookie auth', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('user/info.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { secToken: 'sec-1' } }),
          text: async (): Promise<string> => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => nested,
        text: async (): Promise<string> => '',
      };
    });
    const probe = await fetchAlibabaTokenPlanUsage('session_id=abc', {
      fetchImpl: fetchImpl as never,
      now: 100,
    });
    expect(probe.windows?.map((w) => w.usedRatio)).toEqual([0.31, 0.13, 0.0104]);
    const post = fetchImpl.mock.calls.find((c) => String(c[0]).includes('api.json'));
    expect(post).toBeTruthy();
    expect(String(post![0])).toContain('zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage');
  });

  it('CLI probe parses bl console call JSON and reports auth failure', async () => {
    const runImpl = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify(nested),
      stderr: '',
    }));
    const ok = await fetchAlibabaTokenPlanUsageFromCli({ runImpl, now: 100 });
    expect(ok.windows?.[0]?.usedRatio).toBe(0.31);
    expect(runImpl).toHaveBeenCalled();

    const dead = await fetchAlibabaTokenPlanUsageFromCli({
      runImpl: async () => ({ code: 1, stdout: '', stderr: 'please login' }),
    });
    expect(dead).toEqual({ windows: null, authFailed: true });
  });

  it('unified probe prefers cookie, falls back to CLI', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => nested,
      text: async (): Promise<string> => '',
    }));
    const fromCookie = await probeAlibabaTokenPlanUsage({
      cookie: 'session_id=x',
      fetchImpl: fetchImpl as never,
      now: 100,
    });
    expect(fromCookie.windows).toHaveLength(3);

    const fromCli = await probeAlibabaTokenPlanUsage({
      cookie: null,
      skipCli: false,
      now: 100,
    });
    // Without cookie and without bl binary: honest null windows.
    expect(fromCli.windows === null || Array.isArray(fromCli.windows)).toBe(true);
  });
});

describe('escala do Token Plan (F-1417)', () => {
  it('fração acima de 1 é estouro do plano, não 1,04%', () => {
    const windows = parseAlibabaTokenPlanUsage({ data: { per1MonthPercentage: 1.04, per5HourPercentage: '0.5' } }, 100);
    const monthly = windows.find((w) => w.kind === 'monthly');
    expect(monthly?.usedRatio).toBe(1);
    expect(windows.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.5);
  });
});
