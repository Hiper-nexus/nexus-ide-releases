import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_WHAM_USAGE_URL,
  fetchCodexUsageWindows,
  parseCodexAuthJson,
  parseCodexWhamUsage,
} from './codex-usage';

const WHAM_FIXTURE = {
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 6,
      limit_window_seconds: 604800,
      reset_after_seconds: 582000,
      reset_at: 1784489178,
    },
    secondary_window: {
      used_percent: 40,
      limit_window_seconds: 18000,
      reset_after_seconds: 9000,
      reset_at: 1783900000,
    },
  },
};

describe('parseCodexAuthJson', () => {
  it('reads tokens.access_token + account_id', () => {
    const auth = parseCodexAuthJson(
      JSON.stringify({
        tokens: {
          access_token: 'at-1',
          account_id: 'acc-9',
        },
      }),
    );
    expect(auth).toEqual({ accessToken: 'at-1', accountId: 'acc-9' });
  });

  it('returns null without token', () => {
    expect(parseCodexAuthJson('{}')).toBeNull();
    expect(parseCodexAuthJson('nope')).toBeNull();
  });
});

describe('parseCodexWhamUsage', () => {
  const NOW = 1_700_000_000_000;

  it('maps primary weekly + secondary 5h from used_percent', () => {
    const w = parseCodexWhamUsage(WHAM_FIXTURE, NOW);
    const weekly = w.find((x) => x.kind === 'weekly');
    const hours = w.find((x) => x.kind === 'hours');
    expect(weekly).toMatchObject({
      usedRatio: 0.06,
      source: 'provider-api',
      confidence: 'high',
      label: 'Semanal',
    });
    expect(hours).toMatchObject({
      usedRatio: 0.4,
      source: 'provider-api',
      label: '5 Horas',
    });
    expect(weekly?.resetsAt).toBe(1784489178 * 1000);
  });

  it('does not invent a 5h quota when the provider reports only a weekly window', () => {
    const w = parseCodexWhamUsage(
      {
        rate_limit: {
          primary_window: {
            used_percent: 6,
            limit_window_seconds: 604800,
            reset_at: 1784489178,
          },
          secondary_window: null,
        },
      },
      NOW,
    );
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0.06);
    expect(w.find((x) => x.kind === 'hours')).toBeUndefined();
    expect(w).toHaveLength(1);
    expect(w.every((x) => x.source === 'provider-api')).toBe(true);
  });

  it('treats used_percent 0 as real 0%', () => {
    const w = parseCodexWhamUsage(
      {
        rate_limit: {
          primary_window: {
            used_percent: 0,
            limit_window_seconds: 604800,
          },
        },
      },
      NOW,
    );
    expect(w[0]?.usedRatio).toBe(0);
    expect(w[0]?.source).toBe('provider-api');
  });

  it('returns empty when rate_limit missing', () => {
    expect(parseCodexWhamUsage({})).toEqual([]);
    expect(parseCodexWhamUsage(null)).toEqual([]);
  });
});

describe('fetchCodexUsageWindows', () => {
  it('calls wham/usage with Bearer + ChatGPT-Account-ID', async () => {
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
        json: async () => WHAM_FIXTURE,
        text: async () => '',
      }),
    );
    const windows = await fetchCodexUsageWindows(
      { accessToken: 'tok', accountId: 'acct' },
      { fetchImpl, now: Date.now() },
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      CODEX_WHAM_USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'ChatGPT-Account-ID': 'acct',
        }),
      }),
    );
    expect(windows?.some((w) => w.source === 'provider-api')).toBe(true);
  });

  it('returns null on HTTP failure', async () => {
    expect(
      await fetchCodexUsageWindows(
        { accessToken: 'tok' },
        {
          fetchImpl: async () => ({
            ok: false,
            status: 403,
            json: async () => ({}),
            text: async () => '',
          }),
        },
      ),
    ).toBeNull();
  });
});
