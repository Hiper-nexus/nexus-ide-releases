import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

import { QuotaService } from './quota-service';
import type { AccountInfo } from '../../shared/account-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { CLAUDE_OAUTH_USAGE_URL } from './claude-oauth-usage';

const HIT_AT = 1_000_000;
const COOLDOWN_MS = 60_000;

function provider(adapterId: string, label = adapterId): ProviderSettingsInfo {
  return {
    adapterId,
    label,
    installed: true,
    enabled: true,
  } as ProviderSettingsInfo;
}

const LIVE_USAGE = {
  five_hour: {
    utilization: 12,
    resets_at: '2026-07-13T05:30:00Z',
  },
  seven_day: {
    utilization: 47,
    resets_at: '2026-07-15T04:00:00Z',
  },
};

describe('QuotaService limit-hit expiry', () => {
  it('applies noted hit while cooldown active, then recovers to unknown after expiry', async () => {
    const svc = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => [] as AccountInfo[],
    });

    svc.noteLimitHit(
      'claude',
      {
        kind: 'rate-limit',
        reason: 'usage limit',
        cooldownMs: COOLDOWN_MS,
      },
      undefined,
      HIT_AT,
    );

    const during = await svc.snapshot(HIT_AT + 1_000);
    const duringEntry = during.entries.find((e) => e.adapterId === 'claude');
    expect(duringEntry).toBeDefined();
    const sessionDuring = duringEntry!.windows.find((w) => w.kind === 'session');
    expect(sessionDuring?.usedRatio).toBe(1);
    expect(sessionDuring?.source).toBe('limit-hit');
    // resetsAt fixed at hitAt+cooldown — not now+cooldown (perpetual full bar)
    expect(sessionDuring?.resetsAt).toBe(HIT_AT + COOLDOWN_MS);

    const after = await svc.snapshot(HIT_AT + COOLDOWN_MS + 1);
    const afterEntry = after.entries.find((e) => e.adapterId === 'claude');
    expect(afterEntry).toBeDefined();
    // Exhausted limit-hit windows must not stick past cooldown
    const exhausted = afterEntry!.windows.filter(
      (w) => w.source === 'limit-hit' && w.usedRatio === 1,
    );
    expect(exhausted).toHaveLength(0);
    // Honest unknown again (not invented 0%)
    expect(afterEntry!.windows.every((w) => w.usedRatio === null)).toBe(true);

    svc.stop();
  });

  it('keys multi-account hits and expires only the hit that aged out', async () => {
    const accounts: AccountInfo[] = [
      {
        id: 'acc-a',
        adapterId: 'codex',
        label: 'A',
        mode: 'subscription',
        active: true,
        hasCredential: true,
        onCooldown: false,
      } as AccountInfo,
      {
        id: 'acc-b',
        adapterId: 'codex',
        label: 'B',
        mode: 'subscription',
        active: false,
        hasCredential: true,
        onCooldown: false,
      } as AccountInfo,
    ];

    const svc = new QuotaService({
      listProviders: () => [provider('codex', 'Codex')],
      listAccounts: () => accounts,
    });

    svc.noteLimitHit(
      'codex',
      { kind: 'rate-limit', reason: '5h', cooldownMs: COOLDOWN_MS },
      'acc-a',
      HIT_AT,
    );

    const mid = await svc.snapshot(HIT_AT + 5_000);
    const a = mid.entries.find((e) => e.accountId === 'acc-a');
    const b = mid.entries.find((e) => e.accountId === 'acc-b');
    expect(a?.windows.find((w) => w.kind === 'hours')?.usedRatio).toBe(1);
    // B never hit — stays unknown
    expect(b?.windows.every((w) => w.usedRatio === null)).toBe(true);

    const done = await svc.snapshot(HIT_AT + COOLDOWN_MS + 50);
    const aDone = done.entries.find((e) => e.accountId === 'acc-a');
    expect(
      aDone?.windows.filter((w) => w.source === 'limit-hit' && w.usedRatio === 1),
    ).toHaveLength(0);

    svc.stop();
  });

  it('adapter-level hit does not exhaust per-account vault rows', async () => {
    const accounts: AccountInfo[] = [
      {
        id: 'acc-a',
        adapterId: 'claude',
        label: 'A',
        mode: 'subscription',
        active: true,
        hasCredential: true,
        onCooldown: false,
      } as AccountInfo,
      {
        id: 'acc-b',
        adapterId: 'claude',
        label: 'B',
        mode: 'subscription',
        active: false,
        hasCredential: true,
        onCooldown: false,
      } as AccountInfo,
    ];
    const svc = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => accounts,
    });
    // Unpinned / bare adapter hit — must not paint every account at 100%.
    svc.noteLimitHit(
      'claude',
      { kind: 'rate-limit', reason: 'x', cooldownMs: COOLDOWN_MS },
      undefined,
      HIT_AT,
    );
    const snap = await svc.snapshot(HIT_AT + 1);
    const a = snap.entries.find((e) => e.accountId === 'acc-a');
    const b = snap.entries.find((e) => e.accountId === 'acc-b');
    expect(a?.windows.every((w) => w.usedRatio === null)).toBe(true);
    expect(b?.windows.every((w) => w.usedRatio === null)).toBe(true);
    svc.stop();
  });
});

describe('QuotaService live Claude OAuth usage', () => {
  it('hydrates session + weekly from provider-api when token resolves', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => LIVE_USAGE,
      text: async () => JSON.stringify(LIVE_USAGE),
    }));

    const svc = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => [] as AccountInfo[],
      resolveClaudeAccessToken: () => 'sk-ant-oat01-test',
      fetchImpl,
    });

    const snap = await svc.snapshot(HIT_AT);
    const entry = snap.entries.find((e) => e.adapterId === 'claude');
    expect(entry).toBeDefined();
    expect(entry!.windows.find((w) => w.kind === 'session')).toMatchObject({
      usedRatio: 0.12,
      source: 'provider-api',
      confidence: 'high',
    });
    expect(entry!.windows.find((w) => w.kind === 'weekly')).toMatchObject({
      usedRatio: 0.47,
      source: 'provider-api',
    });
    expect(snap.unknownCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      CLAUDE_OAUTH_USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-ant-oat01-test',
        }),
      }),
    );

    // Cache TTL: second snapshot within window does not re-fetch.
    await svc.snapshot(HIT_AT + 5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    svc.stop();
  });

  it('stays honest unknown when token missing or API fails', async () => {
    const failFetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => 'rate limited',
    }));

    const noToken = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => [] as AccountInfo[],
      resolveClaudeAccessToken: () => null,
      fetchImpl: failFetch,
    });
    const snapNoTok = await noToken.snapshot(HIT_AT);
    const claude = snapNoTok.entries.find((e) => e.adapterId === 'claude');
    expect(claude?.windows.every((w) => w.usedRatio === null)).toBe(true);
    expect(failFetch).not.toHaveBeenCalled();
    noToken.stop();

    const badApi = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => [] as AccountInfo[],
      resolveClaudeAccessToken: () => 'tok',
      fetchImpl: failFetch,
    });
    const snapFail = await badApi.snapshot(HIT_AT);
    const c2 = snapFail.entries.find((e) => e.adapterId === 'claude');
    expect(c2?.windows.every((w) => w.usedRatio === null)).toBe(true);
    // Never invent 0% on failure
    expect(c2?.windows.some((w) => w.usedRatio === 0)).toBe(false);
    badApi.stop();
  });

  it('resolves per-account vault tokens and does not cross-paint', async () => {
    const accounts: AccountInfo[] = [
      {
        id: 'acc-a',
        adapterId: 'claude',
        label: 'A',
        mode: 'subscription',
        active: true,
        hasCredential: true,
        onCooldown: false,
      } as AccountInfo,
      {
        id: 'acc-b',
        adapterId: 'claude',
        label: 'B',
        mode: 'subscription',
        active: false,
        hasCredential: true,
        onCooldown: false,
      } as AccountInfo,
    ];

    const fetchImpl = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      const auth = init?.headers?.Authorization ?? '';
      const util = auth.includes('token-a') ? 10 : 80;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: util, resets_at: '2026-07-13T00:00:00Z' },
          seven_day: { utilization: util, resets_at: '2026-07-15T00:00:00Z' },
        }),
        text: async () => '',
      };
    });

    const svc = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => accounts,
      resolveClaudeAccessToken: (accountId) =>
        accountId === 'acc-a' ? 'token-a' : accountId === 'acc-b' ? 'token-b' : null,
      fetchImpl,
    });

    const snap = await svc.snapshot(HIT_AT);
    const a = snap.entries.find((e) => e.accountId === 'acc-a');
    const b = snap.entries.find((e) => e.accountId === 'acc-b');
    expect(a?.windows.find((w) => w.kind === 'session')?.usedRatio).toBe(0.1);
    expect(b?.windows.find((w) => w.kind === 'session')?.usedRatio).toBe(0.8);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  it('refresh force-reprobes provider API', async () => {
    let utilization = 5;
    const fetchImpl = vi.fn(async () => {
      const u = utilization;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: u, resets_at: '2026-07-13T00:00:00Z' },
          seven_day: { utilization: u * 2, resets_at: '2026-07-15T00:00:00Z' },
        }),
        text: async () => '',
      };
    });

    const svc = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => [] as AccountInfo[],
      resolveClaudeAccessToken: () => 'tok',
      fetchImpl,
    });

    await svc.snapshot(HIT_AT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    utilization = 40;
    const refreshed = await svc.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      refreshed.entries
        .find((e) => e.adapterId === 'claude')
        ?.windows.find((w) => w.kind === 'session')?.usedRatio,
    ).toBe(0.4);
    svc.stop();
  });

  it('hydrates codex + glm live usage in the same fleet snapshot', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('wham/usage')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            rate_limit: {
              primary_window: {
                used_percent: 6,
                limit_window_seconds: 604800,
              },
            },
          }),
          text: async () => '',
        };
      }
      if (String(url).includes('quota/limit')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              limits: [
                { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 8 },
                { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 12 },
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
    });

    const svc = new QuotaService({
      listProviders: () => [
        provider('codex', 'Codex'),
        provider('glm', 'GLM'),
        provider('grok', 'Grok'),
      ],
      listAccounts: () => [] as AccountInfo[],
      resolveCodexAuthCandidates: () => [
        { accessToken: 'c-tok', accountId: 'a1' },
      ],
      resolveGlmApiKeyCandidates: () => ['glm-key'],
      resolveGrokTokenCandidates: () => ['grok-jwt'],
      fetchImpl,
    });

    const snap = await svc.snapshot(HIT_AT);
    const codex = snap.entries.find((e) => e.adapterId === 'codex');
    const glm = snap.entries.find((e) => e.adapterId === 'glm');
    const grok = snap.entries.find((e) => e.adapterId === 'grok');

    expect(codex?.windows.find((w) => w.kind === 'weekly')?.usedRatio).toBe(
      0.06,
    );
    expect(glm?.windows.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.08);
    expect(glm?.windows.find((w) => w.kind === 'weekly')?.usedRatio).toBe(0.12);
    // Grok has no public used% API — honest unknown, not fake 0
    expect(grok?.windows.every((w) => w.usedRatio === null)).toBe(true);
    svc.stop();
  });
});
