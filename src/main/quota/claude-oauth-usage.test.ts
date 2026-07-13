import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_OAUTH_BETA,
  CLAUDE_OAUTH_USAGE_URL,
  extractClaudeAccessToken,
  fetchClaudeOauthUsageWindows,
  parseClaudeOauthUsage,
} from './claude-oauth-usage';

/** Fixture shaped like live Anthropic /api/oauth/usage (2026-07). */
const LIVE_SHAPE = {
  five_hour: {
    utilization: 2.0,
    resets_at: '2026-07-13T05:30:00.097620+00:00',
  },
  seven_day: {
    utilization: 50.0,
    resets_at: '2026-07-15T04:00:00.097642+00:00',
  },
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false },
  limits: [
    { kind: 'session', percent: 2 },
    { kind: 'weekly_all', percent: 50 },
  ],
};

describe('extractClaudeAccessToken', () => {
  it('reads claudeAiOauth.accessToken from credential blob', () => {
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test',
        refreshToken: 'refresh',
      },
    });
    expect(extractClaudeAccessToken(blob)).toBe('sk-ant-oat01-test');
  });

  it('returns null for empty/invalid blobs without throwing', () => {
    expect(extractClaudeAccessToken('')).toBeNull();
    expect(extractClaudeAccessToken('not-json')).toBeNull();
    expect(extractClaudeAccessToken('{}')).toBeNull();
    expect(
      extractClaudeAccessToken(JSON.stringify({ claudeAiOauth: {} })),
    ).toBeNull();
  });
});

describe('parseClaudeOauthUsage', () => {
  const NOW = Date.parse('2026-07-12T12:00:00.000Z');

  it('maps five_hour + seven_day to 5h/weekly with provider-api source', () => {
    const windows = parseClaudeOauthUsage(LIVE_SHAPE, NOW);
    expect(windows).toHaveLength(2);

    const hours = windows.find((w) => w.kind === 'hours');
    expect(hours).toMatchObject({
      label: '5 Horas',
      usedRatio: 0.02,
      source: 'provider-api',
      confidence: 'high',
    });
    expect(hours?.resetsAt).toBe(Date.parse(LIVE_SHAPE.five_hour.resets_at));
    expect(hours?.remainingLabel).toBeTruthy();

    const weekly = windows.find((w) => w.kind === 'weekly');
    expect(weekly).toMatchObject({
      label: 'Semanal',
      usedRatio: 0.5,
      source: 'provider-api',
      confidence: 'high',
    });
    expect(weekly?.resetsAt).toBe(Date.parse(LIVE_SHAPE.seven_day.resets_at));
  });

  it('treats utilization 0 as real 0% (not unknown null)', () => {
    const windows = parseClaudeOauthUsage(
      {
        five_hour: { utilization: 0, resets_at: '2026-07-13T00:00:00Z' },
        seven_day: { utilization: 0, resets_at: '2026-07-15T00:00:00Z' },
      },
      NOW,
    );
    expect(windows.every((w) => w.usedRatio === 0)).toBe(true);
    expect(windows.every((w) => w.source === 'provider-api')).toBe(true);
  });

  it('scales 0–100 percent (1 → 1%, not 100%) and clamps above 100', () => {
    const high = parseClaudeOauthUsage(
      { five_hour: { utilization: 150 }, seven_day: { utilization: 100 } },
      NOW,
    );
    expect(high.find((w) => w.kind === 'hours')?.usedRatio).toBe(1);
    expect(high.find((w) => w.kind === 'weekly')?.usedRatio).toBe(1);

    const onePct = parseClaudeOauthUsage(
      { five_hour: { utilization: 1 }, seven_day: { utilization: 0.5 } },
      NOW,
    );
    expect(onePct.find((w) => w.kind === 'hours')?.usedRatio).toBeCloseTo(0.01);
    expect(onePct.find((w) => w.kind === 'weekly')?.usedRatio).toBeCloseTo(0.005);
  });

  it('returns empty when body lacks usable buckets (honest unknown upstream)', () => {
    expect(parseClaudeOauthUsage(null)).toEqual([]);
    expect(parseClaudeOauthUsage({})).toEqual([]);
    expect(parseClaudeOauthUsage({ five_hour: null, seven_day: null })).toEqual(
      [],
    );
    expect(
      parseClaudeOauthUsage({
        five_hour: { utilization: 'nope' },
        seven_day: { utilization: NaN },
      }),
    ).toEqual([]);
  });
});

describe('fetchClaudeOauthUsageWindows', () => {
  it('calls Anthropic OAuth usage with Bearer + beta header', async () => {
    const fetchImpl = vi.fn(
      async (
        _input: string,
        _init?: {
          method?: string;
          headers?: Record<string, string>;
          signal?: AbortSignal;
        },
      ) => ({
        ok: true,
        status: 200,
        json: async () => LIVE_SHAPE,
        text: async () => JSON.stringify(LIVE_SHAPE),
      }),
    );

    const windows = await fetchClaudeOauthUsageWindows('sk-ant-oat01-x', {
      fetchImpl,
      now: Date.parse('2026-07-12T12:00:00.000Z'),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      CLAUDE_OAUTH_USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-ant-oat01-x',
          'anthropic-beta': CLAUDE_OAUTH_BETA,
        }),
      }),
    );
    expect(windows?.find((w) => w.kind === 'weekly')?.usedRatio).toBe(0.5);
  });

  it('returns null on HTTP error / network throw / empty token (no fake %)', async () => {
    expect(await fetchClaudeOauthUsageWindows('')).toBeNull();
    expect(
      await fetchClaudeOauthUsageWindows('tok', {
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          json: async () => ({}),
          text: async () => 'nope',
        }),
      }),
    ).toBeNull();
    expect(
      await fetchClaudeOauthUsageWindows('tok', {
        fetchImpl: async () => {
          throw new Error('network down');
        },
      }),
    ).toBeNull();
  });
});
