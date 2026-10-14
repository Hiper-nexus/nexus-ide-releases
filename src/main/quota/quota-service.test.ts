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
import { buildRedlineSnapshotFile } from './redline-sink';

const HIT_AT = 1_000_000;
const COOLDOWN_MS = 60_000;

function provider(
  adapterId: string,
  label = adapterId,
  opts?: { installed?: boolean; enabled?: boolean },
): ProviderSettingsInfo {
  return {
    adapterId,
    label,
    installed: opts?.installed ?? true,
    enabled: opts?.enabled ?? true,
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

describe('QuotaService.publishSnapshot (post-boot first read)', () => {
  it('honors the live API cache that refresh() bypasses', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ config: { creditUsagePercent: 6 } }), text: async () => '' }));
    const svc = new QuotaService({
      listProviders: () => [provider('grok')],
      listAccounts: () => [{ id: 'grok-a', adapterId: 'grok', label: 'Grok', mode: 'subscription', hasCredential: true, onCooldown: false } as AccountInfo],
      resolveGrokTokenCandidates: () => ['fresh-access'],
      fetchImpl,
    });
    try {
      await svc.snapshot();
      const probes = fetchImpl.mock.calls.length;
      expect(probes).toBeGreaterThan(0);
      const published = await svc.publishSnapshot();
      expect(published.entries[0].windows.some((w) => w.usedRatio === 0.06)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(probes);
      await svc.refresh();
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(probes);
    } finally {
      svc.stop();
    }
  });
});

describe('QuotaService limit-hit expiry', () => {
  it('clears a proven stale auth warning and publishes the updated account to Redline immediately', async () => {
    let needsRelogin = true;
    let published: AccountInfo[] = [];
    const svc = new QuotaService({
      listProviders: () => [provider('grok')],
      listAccounts: () => [{ id: 'grok-a', adapterId: 'grok', label: 'Grok', mode: 'subscription', hasCredential: true, needsRelogin, onCooldown: false } as AccountInfo],
      resolveGrokTokenCandidates: () => ['fresh-access'],
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ config: { creditUsagePercent: 6 } }), text: async () => '' }),
      clearRefutedAuthCooldown: () => { needsRelogin = false; },
      persistSnapshot: (_snap, accounts) => { published = [...accounts]; },
    });
    await svc.snapshot();
    expect(needsRelogin).toBe(false);
    expect(published[0]?.needsRelogin).toBe(false);
    svc.stop();
  });

  it('retains a valid quota reading if clearing the persisted auth warning fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new QuotaService({
      listProviders: () => [provider('grok')],
      listAccounts: () => [{ id: 'grok-a', adapterId: 'grok', label: 'Grok', mode: 'subscription', hasCredential: true, needsRelogin: true, onCooldown: false } as AccountInfo],
      resolveGrokTokenCandidates: () => ['fresh-access'],
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ config: { creditUsagePercent: 6 } }), text: async () => '' }),
      clearRefutedAuthCooldown: () => { throw new Error('storage unavailable'); },
    });
    const result = await svc.snapshot();
    expect(result.entries[0].windows.some(w => w.usedRatio === 0.06)).toBe(true);
    svc.stop(); warn.mockRestore();
  });

  it('reports a revoked saved Codex login without assigning its sibling quota', async () => {
    const marked: string[] = [];
    const svc = new QuotaService({
      listProviders: () => [provider('codex')],
      listAccounts: () => ['healthy', 'revoked'].map((id) => ({ id, adapterId: 'codex', label: id, mode: 'subscription', hasCredential: true, onCooldown: false } as AccountInfo)),
      resolveCodexAuthCandidates: () => [{ accessToken: 'expired-access' }],
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' }),
      codexAccountUsage: async (id) => id === 'revoked'
        ? { windows: null, hint: 'auth-expired' }
        : { windows: [{ kind: 'weekly', label: 'Semanal', usedRatio: 0.2, source: 'provider-api', confidence: 'high' }] },
      markAccountAuthExpired: (id) => { marked.push(id); },
    });
    const result = await svc.snapshot(HIT_AT);
    expect(result.entries.find((entry) => entry.accountId === 'healthy')?.windows.some((window) => window.usedRatio === 0.2)).toBe(true);
    const revoked = result.entries.find((entry) => entry.accountId === 'revoked');
    expect(revoked?.readHint).toBe('auth-expired');
    expect(revoked?.windows.every((window) => window.usedRatio === null)).toBe(true);
    expect(marked).toEqual(['revoked']);
    svc.stop();
  });

  it('marks a Claude account for re-login when the provider proves another identity', async () => {
    const marked: Array<[string, string, string | undefined]> = [];
    const svc = new QuotaService({
      listProviders: () => [provider('claude')],
      listAccounts: () => [{ id: 'wrong-claude', adapterId: 'claude', label: 'Wrong', mode: 'subscription', hasCredential: true, onCooldown: false } as AccountInfo],
      claudeAccountUsage: async () => ({ windows: null, hint: 'identity-mismatch' }),
      markAccountAuthExpired: (id, adapter, reason) => { marked.push([id, adapter, reason]); },
    });
    const result = await svc.snapshot(HIT_AT);
    const entry = result.entries.find((row) => row.accountId === 'wrong-claude');
    expect(entry?.readHint).toBe('identity-mismatch');
    expect(entry?.windows.every((window) => window.usedRatio === null)).toBe(true);
    expect(marked).toEqual([['wrong-claude', 'claude', 'identity-mismatch']]);
    svc.stop();
  });
  it.each([true, false])('never probes an incompatible or orphaned routed account (provider exists=%s)', async (exists) => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' }));
    const svc = new QuotaService({
      listProviders: () => exists ? [{ ...provider('grok'), routable: false, authStrategy: 'api-key' }] : [],
      listAccounts: () => [{ id: 'foreign-route', adapterId: 'grok', mode: 'api-key', upstream: 'longcat', label: 'foreign fixture', onCooldown: false } as AccountInfo],
      resolveGenericApiKeyCandidates: (_owner, accountId) => accountId ? ['fixture-longcat-owned-opaque'] : [],
      resolveApiQuotaKey: ({ accountId }) => accountId ? 'fixture-longcat-owned-opaque' : null, fetchImpl,
    });
    const result = await svc.snapshot(HIT_AT);
    expect(result.entries.find((entry) => entry.accountId === 'foreign-route')?.windows.every((w) => w.usedRatio === null)).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(0);
    svc.stop();
  });
  it.each(['claude', 'codex'])('does not read a native OAuth quota for a %s API-key origin', async (adapterId) => {
    const resolveClaudeAccessToken = vi.fn(() => 'native-oauth-not-to-read');
    const resolveCodexAuthCandidates = vi.fn(() => [{ accessToken: 'native-codex-not-to-read' }]);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => LIVE_USAGE, text: async () => '' }));
    const svc = new QuotaService({
      listProviders: () => [{ ...provider(adapterId), authStrategy: 'api-key', routable: false, upstream: 'anthropic' }],
      listAccounts: () => [], resolveClaudeAccessToken, resolveCodexAuthCandidates, fetchImpl,
    });
    const result = await svc.snapshot(HIT_AT);
    expect(result.entries[0].windows.every((w) => w.usedRatio === null)).toBe(true);
    expect(resolveClaudeAccessToken.mock.calls.length + resolveCodexAuthCandidates.mock.calls.length).toBe(0);
    expect(fetchImpl.mock.calls.length).toBe(0);
    svc.stop();
  });

  it('does not consult subscription credentials for an exact Anthropic API-key account', async () => {
    const resolvedAccounts: Array<string | undefined> = [];
    const svc = new QuotaService({
      listProviders: () => [{ ...provider('claude'), authStrategy: 'subscription', routable: true, upstream: 'anthropic' }],
      listAccounts: () => [{ id: 'api-account', adapterId: 'claude', mode: 'api-key', upstream: 'anthropic', label: 'API', onCooldown: false } as AccountInfo],
      resolveClaudeAccessToken: (accountId) => { resolvedAccounts.push(accountId); return null; },
    });
    const result = await svc.snapshot(HIT_AT);
    expect(result.entries.find((entry) => entry.accountId === 'api-account')?.windows.every((w) => w.usedRatio === null)).toBe(true);
    expect(resolvedAccounts).toEqual([undefined]);
    svc.stop();
  });

  it('invalidates cached API quota when auth mode changes on the same explicit upstream', async () => {
    let authStrategy: 'subscription' | 'api-key' = 'subscription';
    const requests: string[] = [];
    const svc = new QuotaService({
      listProviders: () => [{ ...provider('claude'), routable: true, upstream: 'glm', authStrategy }],
      listAccounts: () => [], resolveApiQuotaKey: () => 'owner-key',
      fetchImpl: async (url) => { requests.push(url); return { ok: true, status: 200,
        json: async () => ({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12 }] } }), text: async () => '' };
      },
    });
    await svc.snapshot(HIT_AT);
    authStrategy = 'api-key';
    await svc.snapshot(HIT_AT + 1_000);
    expect(requests).toHaveLength(2);
    svc.stop();
  });
  it('keeps installed native sessions eligible while their auth proof is still warming', async () => {
    const svc = new QuotaService({
      listProviders: () => [{ ...provider('claude'), authStrategy: 'login-needed', authState: 'unknown' }],
      listAccounts: () => [],
      resolveClaudeAccessToken: async () => 'native-test-token',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => LIVE_USAGE, text: async () => '' }),
    });
    const result = await svc.snapshot(HIT_AT);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].windows.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.12);
    svc.stop();
  });
  it('sonda a linha nativa de provider subscription mesmo com upstream declarado não-anthropic (kimi/moonshot)', async () => {
    // Regressão: kimi declara upstream 'moonshot' (família da API) e
    // routable:false — canProbeQuota lia isso como «rota para outro vendor»
    // e nunca sondava o OAuth nativo. A linha ficava «Sem informação» com
    // ~/.kimi-code vivo.
    const resolveKimiOauthCreds = vi.fn(() => ({
      accessToken: 'kimi-at',
      refreshToken: 'kimi-rt',
      expiresAt: 4_000_000_000,
    }));
    const svc = new QuotaService({
      listProviders: () => [
        { ...provider('kimi'), routable: false, upstream: 'moonshot', authStrategy: 'subscription' },
      ],
      listAccounts: () => [],
      resolveKimiOauthCreds,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          usage: { limit: '100', used: '16', remaining: '84' },
          limits: [],
        }),
        text: async () => '',
      }),
    });
    const result = await svc.snapshot(HIT_AT);
    expect(resolveKimiOauthCreds).toHaveBeenCalled();
    expect(result.entries[0].windows.some((w) => w.usedRatio !== null)).toBe(true);
    svc.stop();
  });

  it('F-720: GLM e GLM Flash na mesma chave z.ai saem com o mesmo grupo de cota; chaves distintas não', async () => {
    const zaiLimits = { data: { limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 4 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 66 },
    ] } };
    const run = async (keys: Record<string, string>) => {
      const svc = new QuotaService({
        listProviders: () => [
          { ...provider('glm', 'GLM (z.ai)'), authStrategy: 'api-key' },
          { ...provider('glm-flash', 'GLM Flash (z.ai)'), authStrategy: 'api-key' },
        ],
        listAccounts: () => [],
        resolveApiQuotaKey: ({ adapterId }) => keys[adapterId] ?? null,
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => zaiLimits, text: async () => '' }),
      });
      try {
        return await svc.snapshot(HIT_AT);
      } finally {
        svc.stop();
      }
    };

    const shared = await run({ glm: 'zai-shared-key', 'glm-flash': 'zai-shared-key' });
    const glm = shared.entries.find((entry) => entry.adapterId === 'glm');
    const flash = shared.entries.find((entry) => entry.adapterId === 'glm-flash');
    // O snapshot segue com as duas entradas (failover/roteamento por adapter)…
    expect(glm?.quotaGroup).toBeDefined();
    expect(flash?.quotaGroup).toBe(glm?.quotaGroup);
    // …e o Redline mostra uma só.
    expect(buildRedlineSnapshotFile(shared, [], HIT_AT).entries).toHaveLength(1);

    const distinct = await run({ glm: 'zai-key-a', 'glm-flash': 'zai-key-b' });
    const groups = distinct.entries.map((entry) => entry.quotaGroup);
    expect(new Set(groups).size).toBe(2);
    expect(buildRedlineSnapshotFile(distinct, [], HIT_AT).entries).toHaveLength(2);
  });

  it('keeps adapter identity while routing an explicitly configured upstream quota', async () => {
    const resolveClaudeAccessToken = vi.fn(async () => 'native-credential-not-to-use');
    const resolveApiQuotaKey = vi.fn(() => 'routed-owner-key');
    const svc = new QuotaService({
      listProviders: () => [{ ...provider('claude', 'Claude'), routable: true, upstream: 'glm', authStrategy: 'api-key' }],
      listAccounts: () => [], resolveClaudeAccessToken, resolveApiQuotaKey,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12 },
      ] } }), text: async () => '' }),
    });
    const result = await svc.snapshot(HIT_AT);
    expect(result.entries[0]).toMatchObject({ adapterId: 'claude', usageProviderId: 'glm' });
    expect(result.entries[0].windows.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.12);
    expect(resolveClaudeAccessToken.mock.calls.length).toBe(0);
    expect(resolveApiQuotaKey).toHaveBeenCalledWith({ adapterId: 'claude', accountId: undefined, usageProviderId: 'glm', authMode: 'api-key' });
    svc.stop();
  });

  it('does not reuse a cached quota after the declared upstream changes', async () => {
    let upstream = 'glm';
    const svc = new QuotaService({
      listProviders: () => [{ ...provider('claude'), routable: true, upstream }], listAccounts: () => [],
      resolveApiQuotaKey: () => 'owner-key',
      fetchImpl: async (url) => ({ ok: url.includes('api.z.ai'), status: url.includes('api.z.ai') ? 200 : 403,
        json: async () => ({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12 }] } }),
        text: async () => '',
      }),
    });
    const original = await svc.snapshot(HIT_AT);
    expect(original.entries[0].windows.some((window) => window.source === 'provider-api')).toBe(true);
    upstream = 'longcat';
    const changed = await svc.snapshot(HIT_AT + 1_000);
    expect(changed.entries[0].usageProviderId).toBe('longcat');
    expect(changed.entries[0].windows.every((w) => w.usedRatio === null)).toBe(true);
    svc.stop();
  });

  it('does not infer routed API quota from the default upstream or a subscription account', async () => {
    const resolveGenericApiKeyCandidates = vi.fn(() => ['must-not-read']);
    const svc = new QuotaService({
      listProviders: () => [{ ...provider('claude'), routable: true, upstream: 'anthropic' }],
      listAccounts: () => [{ id: 'subscription', adapterId: 'claude', mode: 'subscription', upstream: 'glm', label: 'saved', onCooldown: false } as AccountInfo],
      resolveGenericApiKeyCandidates,
    });
    const result = await svc.snapshot(HIT_AT);
    expect(result.entries.every((entry) => entry.usageProviderId === undefined)).toBe(true);
    expect(resolveGenericApiKeyCandidates.mock.calls.length).toBe(0);
    svc.stop();
  });
  it('drops an expired API reading when its normal refresh fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => LIVE_USAGE })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    const svc = new QuotaService({
      listProviders: () => [provider('claude')], listAccounts: () => [],
      resolveClaudeAccessToken: () => 'test-token', fetchImpl,
    });
    const first = await svc.snapshot(HIT_AT);
    expect(first.entries[0].windows.some((w) => w.source === 'provider-api')).toBe(true);
    const expired = await svc.snapshot(HIT_AT + 60_001);
    expect(expired.entries[0].windows.every((w) => w.usedRatio === null)).toBe(true);
    svc.stop();
  });

  it('keeps the observation time of cached API readings instead of claiming a new observation', async () => {
    const svc = new QuotaService({
      listProviders: () => [provider('claude')], listAccounts: () => [],
      resolveClaudeAccessToken: () => 'test-token',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => LIVE_USAGE, text: async () => '' }),
    });
    await svc.snapshot(HIT_AT);
    const cached = await svc.snapshot(HIT_AT + 1_000);
    expect(cached.entries[0].updatedAt).toBe(HIT_AT);
    svc.stop();
  });
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
    const hoursDuring = duringEntry!.windows.find((w) => w.kind === 'hours');
    expect(hoursDuring?.usedRatio).toBe(1);
    expect(hoursDuring?.source).toBe('limit-hit');
    // resetsAt fixed at hitAt+cooldown — not now+cooldown (perpetual full bar)
    expect(hoursDuring?.resetsAt).toBe(HIT_AT + COOLDOWN_MS);

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
        needsRelogin: false,
      } as AccountInfo,
      {
        id: 'acc-b',
        adapterId: 'codex',
        label: 'B',
        mode: 'subscription',
        active: false,
        hasCredential: true,
        onCooldown: false,
        needsRelogin: false,
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
        needsRelogin: false,
      } as AccountInfo,
      {
        id: 'acc-b',
        adapterId: 'claude',
        label: 'B',
        mode: 'subscription',
        active: false,
        hasCredential: true,
        onCooldown: false,
        needsRelogin: false,
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

  it('shows OAuth 401 cooldown as auth trouble, not 100% quota', async () => {
    const accounts: AccountInfo[] = [
      {
        id: 'acc-expired',
        adapterId: 'claude',
        label: 'Conta limpa',
        mode: 'subscription',
        active: true,
        hasCredential: true,
        onCooldown: true,
        needsRelogin: false,
        cooldownUntil: HIT_AT + COOLDOWN_MS,
        lastError: 'Error: 401 OAuth access token has expired',
      } as AccountInfo,
    ];
    const svc = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => accounts,
    });

    const snap = await svc.snapshot(HIT_AT + 1);
    const account = snap.entries.find((e) => e.accountId === 'acc-expired');

    expect(account).toMatchObject({
      onCooldown: true,
      cooldownKind: 'auth',
    });
    expect(account?.windows.every((w) => w.usedRatio === null)).toBe(true);
    expect(snap.worstUsedRatio).toBeNull();
    expect(snap.highUsageCount).toBe(0);
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
    expect(entry!.windows.find((w) => w.kind === 'hours')).toMatchObject({
      usedRatio: 0.12,
      source: 'provider-api',
      confidence: 'high',
      label: '5 Horas',
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

  it('backs off a failed probe instead of hammering a rate-limited API', async () => {
    const failFetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => 'rate limited',
    }));
    const svc = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => [] as AccountInfo[],
      resolveClaudeAccessToken: () => 'tok',
      fetchImpl: failFetch,
    });

    await svc.snapshot(HIT_AT);
    expect(failFetch).toHaveBeenCalledTimes(1);

    // Backoff: refresh dentro da janela de 5 min NÃO re-tenta a probe.
    await svc.snapshot(HIT_AT + 60_000);
    expect(failFetch).toHaveBeenCalledTimes(1);

    // forceApi (botão Atualizar) respeita a decisão do usuário.
    await svc.snapshot(HIT_AT + 120_000, { forceApi: true });
    expect(failFetch).toHaveBeenCalledTimes(2);

    // Backoff expirado (o forceApi reiniciou a janela: 120s + 5min < 8min):
    // volta a sondar sozinho.
    await svc.snapshot(HIT_AT + 8 * 60_000);
    expect(failFetch).toHaveBeenCalledTimes(3);

    svc.stop();
  });

  it('uses account-owned Claude readings without resolving an unchecked pinned token', async () => {
    const accounts: AccountInfo[] = [
      {
        id: 'acc-a',
        adapterId: 'claude',
        label: 'A',
        mode: 'subscription',
        active: true,
        hasCredential: true,
        onCooldown: false,
        needsRelogin: false,
      } as AccountInfo,
      {
        id: 'acc-b',
        adapterId: 'claude',
        label: 'B',
        mode: 'subscription',
        active: false,
        hasCredential: true,
        onCooldown: false,
        needsRelogin: false,
      } as AccountInfo,
    ];

    const resolveClaudeAccessToken = vi.fn(() => 'unchecked-other-account');
    const claudeAccountUsage = vi.fn(async (id: string) => ({ windows: [{
      kind: 'hours' as const, label: '5 Horas', usedRatio: id === 'acc-a' ? 0.1 : 0.8,
      source: 'provider-api' as const, confidence: 'high' as const,
    }] }));

    const svc = new QuotaService({
      listProviders: () => [provider('claude', 'Claude')],
      listAccounts: () => accounts,
      resolveClaudeAccessToken,
      claudeAccountUsage,
    });

    const snap = await svc.snapshot(HIT_AT);
    const a = snap.entries.find((e) => e.accountId === 'acc-a');
    const b = snap.entries.find((e) => e.accountId === 'acc-b');
    expect(a?.windows.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.1);
    expect(b?.windows.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.8);
    expect(claudeAccountUsage).toHaveBeenCalledTimes(2);
    expect(resolveClaudeAccessToken).not.toHaveBeenCalled();
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
        ?.windows.find((w) => w.kind === 'hours')?.usedRatio,
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
    // Grok mock has no billing response — honest unknown, not fake 0
    expect(grok?.windows.every((w) => w.usedRatio === null)).toBe(true);
    svc.stop();
  });

  it('publishes MiniMax 5h and weekly usage to Redline and leaves failures unknown', async () => {
    let healthy = true;
    let published: ReturnType<typeof buildRedlineSnapshotFile> | undefined;
    const fetchImpl = vi.fn(async () => ({
      ok: healthy, status: healthy ? 200 : 401,
      json: async () => ({ base_resp: { status_code: 0 }, model_remains: [{
        current_interval_remaining_percent: 70,
        current_weekly_total_count: 100,
        current_weekly_usage_count: 20,
      }] }),
      text: async () => '',
    }));
    const svc = new QuotaService({
      listProviders: () => [provider('minimax-code', 'MiniMax Code')],
      listAccounts: () => [],
      resolveGenericApiKeyCandidates: (adapterId) => adapterId === 'minimax-code' ? ['subscription-key'] : [],
      fetchImpl,
      persistSnapshot: (snapshot, accounts) => { published = buildRedlineSnapshotFile(snapshot, accounts, HIT_AT); },
    });
    const snapshot = await svc.snapshot(HIT_AT);
    expect(snapshot.entries[0]?.windows[0]?.usedRatio).toBeCloseTo(0.3);
    expect(snapshot.entries[0]?.windows[1]?.usedRatio).toBeCloseTo(0.8);
    expect(published?.entries[0]?.adapterId).toBe('minimax-code');
    expect(published?.entries[0]?.excludedReason).toBeUndefined();
    healthy = false;
    const failed = await svc.refresh();
    expect(failed.entries[0]?.windows.every((w) => w.usedRatio === null)).toBe(true);
    expect(published?.entries[0]?.excludedReason).toBe('unknown-usage');
    svc.stop();
  });

  it('skips unused adapters that are not installed (e.g. OpenCode)', async () => {
    const svc = new QuotaService({
      listProviders: () => [
        provider('claude', 'Claude', { installed: true }),
        provider('opencode', 'OpenCode', { installed: false }),
        provider('aider', 'Aider', { installed: false, enabled: false }),
      ],
      listAccounts: () => [] as AccountInfo[],
    });
    const snap = await svc.snapshot(HIT_AT);
    expect(snap.entries.map((e) => e.adapterId)).toEqual(['claude']);
    expect(snap.entries.some((e) => e.adapterId === 'opencode')).toBe(false);
    svc.stop();
  });

  it('deduplicates native CLI row when active vault account is present', async () => {
    const svc = new QuotaService({
      listProviders: () => [
        { ...provider('codex', 'Codex', { installed: true }), authStrategy: 'subscription' },
        { ...provider('claude', 'Claude', { installed: true }), authStrategy: 'subscription' },
      ],
      listAccounts: () => [
        {
          id: 'codex-acct-1',
          adapterId: 'codex',
          label: 'retornoja@gmail.com',
          mode: 'subscription',
          active: true,
          onCooldown: false,
        } as AccountInfo,
        {
          id: 'claude-acct-1',
          adapterId: 'claude',
          label: 'admin@volarehost.com.br',
          mode: 'subscription',
          active: false,
          onCooldown: false,
        } as AccountInfo,
        {
          id: 'claude-acct-2',
          adapterId: 'claude',
          label: 'retornoja@gmail.com',
          mode: 'subscription',
          active: true,
          onCooldown: false,
        } as AccountInfo,
      ],
    });
    const snap = await svc.snapshot(HIT_AT);
    // Codex should only have 1 entry (retornoja@gmail.com), no duplicate "Codex · CLI nativo"
    const codexEntries = snap.entries.filter((e) => e.adapterId === 'codex');
    expect(codexEntries).toHaveLength(1);
    expect(codexEntries[0].accountId).toBe('codex-acct-1');
    expect(codexEntries[0].active).toBe(true);

    // Claude should have exactly 2 vault entries, no duplicate "Claude · CLI nativo"
    const claudeEntries = snap.entries.filter((e) => e.adapterId === 'claude');
    expect(claudeEntries).toHaveLength(2);
    expect(claudeEntries.map((e) => e.accountId).sort()).toEqual([
      'claude-acct-1',
      'claude-acct-2',
    ]);
    expect(claudeEntries[0]?.accountId).toBe('claude-acct-2');
    expect(claudeEntries.find((e) => e.accountId === 'claude-acct-2')?.active).toBe(true);
    svc.stop();
  });
});

describe('sonda do Muse é uma inferência real: TTL de sucesso ≥ 5 min (F-1417)', () => {
  it('não repete o POST de geração a cada minuto', async () => {
    const snapshot = {
      subscription: {
        weekly: { resets_at: '1789344000', used_percent: '12.5' },
        window: { resets_at: '1789078632', used_percent: '34', window_duration_mins: '300' },
      },
    };
    const sse = `data: ${JSON.stringify(snapshot)}\n\n`;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => sse,
    }));
    const svc = new QuotaService({
      listProviders: () => [provider('muse', 'Muse Code')],
      listAccounts: () => [] as AccountInfo[],
      resolveMuseCredential: () => ({ apiKey: 'muse-key', model: 'muse-spark-1.3' }),
      fetchImpl,
    });
    const first = await svc.snapshot(HIT_AT);
    expect(first.entries.find((e) => e.adapterId === 'muse')?.windows.some((w) => w.usedRatio !== null)).toBe(true);
    await svc.snapshot(HIT_AT + 2 * 60_000);
    await svc.snapshot(HIT_AT + 4 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await svc.snapshot(HIT_AT + 5 * 60_000 + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    svc.stop();
  });
});

describe('F-1484: cooldown de limite confirmado pelo provedor (StopFailure)', () => {
  const CONFIRMED_REASON = 'Claude StopFailure (limite de uso)';
  function confirmedService(cleared: string[]) {
    const account: AccountInfo = { id: 'grok-a', adapterId: 'grok', label: 'Grok', mode: 'subscription',
      hasCredential: true, onCooldown: false } as AccountInfo;
    const svc = new QuotaService({
      listProviders: () => [provider('grok')],
      listAccounts: () => [{ ...account }],
      resolveGrokTokenCandidates: () => ['fresh-access'],
      // Leitura sadia (6%): sozinha, ela refutaria qualquer cooldown.
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ config: { creditUsagePercent: 6 } }), text: async () => '' }),
      clearRefutedCooldown: (id) => { cleared.push(id); Object.assign(account, { onCooldown: false, cooldownUntil: undefined }); },
    });
    const confirm = (at: number) => {
      // commitLimitHit: cooldown na conta + hit registrado no serviço.
      Object.assign(account, { onCooldown: true, cooldownUntil: at + 900_000, lastError: CONFIRMED_REASON });
      svc.noteLimitHit('grok', { kind: 'rate-limit', reason: CONFIRMED_REASON, cooldownMs: 900_000,
        confirmed: true, confirmedAt: at }, 'grok-a', at);
    };
    return { svc, confirm };
  }

  it('leitura em cache de ANTES da confirmação não apaga o cooldown (broadcast de 750 ms)', async () => {
    const cleared: string[] = [];
    const { svc, confirm } = confirmedService(cleared);
    await svc.snapshot(HIT_AT - 5_000);
    confirm(HIT_AT);
    const during = await svc.snapshot(HIT_AT + 750);
    expect(cleared).toEqual([]);
    // O tipo vem do hit registrado: a janela sintética e o peso de failover ficam.
    expect(during.entries.find((e) => e.accountId === 'grok-a')).toMatchObject({
      onCooldown: true, cooldownKind: 'rate-limit',
    });
    svc.stop();
  });

  it('leitura feita DEPOIS da confirmação, sadia, ainda refuta o cooldown', async () => {
    const cleared: string[] = [];
    const { svc, confirm } = confirmedService(cleared);
    confirm(HIT_AT);
    await svc.snapshot(HIT_AT + 2_000, { forceApi: true });
    expect(cleared).toEqual(['grok-a']);
    svc.stop();
  });
});
