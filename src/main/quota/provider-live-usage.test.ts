import { describe, expect, it, vi } from 'vitest';
import type { QuotaWindow } from '../../shared/quota-types';
import { fetchLiveProviderWindows, parseKimiUsage } from './provider-live-usage';

const nativeOpenCode = vi.hoisted(() => vi.fn(() => [{ providerId: 'custom', key: 'native-other-account' }]));
vi.mock('./opencode-auth', () => ({ loadOpenCodeAuthKeys: nativeOpenCode }));

describe('fetchLiveProviderWindows', () => {
  it('uses an explicitly routed provider without changing the adapter/account that owns the key', async () => {
    const resolveApiQuotaKey = vi.fn(() => 'owner-bound-key');
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requests.push(new URL(url).hostname);
      return { ok: false, status: 403, json: async () => ({}), text: async () => '' };
    });
    await fetchLiveProviderWindows('claude', 'exact-account', { resolveApiQuotaKey, fetchImpl }, 100, 'glm', 'api-key');
    expect(resolveApiQuotaKey).toHaveBeenCalledWith({ adapterId: 'claude', accountId: 'exact-account', usageProviderId: 'glm', authMode: 'api-key' });
    expect(requests).toEqual(['api.z.ai']);
  });

  it('does not replace a missing routed account credential with the destination provider global key', async () => {
    const resolveApiQuotaKey = vi.fn(() => null);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' }));
    const probe = await fetchLiveProviderWindows('claude', 'missing-account', { resolveApiQuotaKey, fetchImpl }, 100, 'glm', 'api-key');
    expect(probe.windows).toBeNull();
    expect(probe.hint).toBe('no-credential');
    expect(resolveApiQuotaKey).toHaveBeenCalledWith({ adapterId: 'claude', accountId: 'missing-account', usageProviderId: 'glm', authMode: 'api-key' });
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it('never falls back to the flattened generic key list for a declared route', async () => {
    const resolveGenericApiKeyCandidates = vi.fn(() => ['fixture-foreign-key']);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' }));
    expect((await fetchLiveProviderWindows('aider', undefined, { resolveGenericApiKeyCandidates, fetchImpl }, 100, 'glm', 'api-key')).windows).toBeNull();
    expect(resolveGenericApiKeyCandidates.mock.calls.length + fetchImpl.mock.calls.length).toBe(0);
  });
  it('preserves the declared provider of a native OpenCode key for quota routing', async () => {
    nativeOpenCode.mockReturnValueOnce([{ providerId: 'zai', key: 'opaque-provider-owned-key' }]);
    const origins: string[] = [];
    await fetchLiveProviderWindows('opencode', undefined, {
      fetchImpl: async (url) => {
        origins.push(new URL(url).hostname);
        return { ok: false, status: 403, json: async () => ({}), text: async () => '' };
      },
    });
    expect(origins).toEqual(['api.z.ai']);
  });
  it('never reads native OpenCode keys for an account-bound quota row', async () => {
    nativeOpenCode.mockClear();
    const result = await fetchLiveProviderWindows('opencode', 'saved-account', {
      resolveGenericApiKeyCandidates: () => [],
      fetchImpl: vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' })),
    });
    expect(result.windows).toBeNull();
    expect(result.hint).toBe('no-credential');
    expect(nativeOpenCode).not.toHaveBeenCalled();
  });
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
    expect(claude.windows?.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.1);

    const codex = await fetchLiveProviderWindows('codex', undefined, {
      resolveCodexAuthCandidates: () => [
        { accessToken: 'codex-tok', accountId: 'a' },
      ],
      fetchImpl,
    });
    expect(codex.windows?.find((w) => w.kind === 'weekly')?.usedRatio).toBe(0.15);

    const glm = await fetchLiveProviderWindows('glm', undefined, {
      resolveGlmApiKeyCandidates: () => ['bad-key', 'glm-key'],
      fetchImpl,
    });
    expect(glm.windows?.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.05);
    expect(glm.windows?.find((w) => w.kind === 'weekly')?.usedRatio).toBe(0.25);
  });

  it('returns null for grok/agy/longcat without inventing %', async () => {
    const failFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    }));
    // Credencial existe mas o provider falhou → 'unavailable' (não 'no-credential').
    for (const probe of [
      await fetchLiveProviderWindows('grok', undefined, {
        resolveGrokToken: () => 'jwt',
        fetchImpl: failFetch,
      }),
      await fetchLiveProviderWindows('agy', undefined, {
        resolveGeminiToken: () => 'gat',
        resolveGeminiOauthCreds: () => ({ accessToken: 'gat' }),
        fetchImpl: failFetch,
      }),
      await fetchLiveProviderWindows('longcat', undefined, {
        resolveLongcatApiKey: () => 'longcat-key-value-here',
        fetchImpl: failFetch,
      }),
    ]) {
      expect(probe.windows).toBeNull();
      expect(probe.hint).toBe('unavailable');
    }
  });

  it('kimi: refreshes an expired OAuth access token in memory (allowRefresh on the live path)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'live-refreshed-at',
            expires_in: 900,
          }),
          text: async () => '',
        };
      }
      if (String(url).includes('/usages')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            usage: { limit: '100', used: '10', remaining: '90' },
            limits: [],
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });

    const w = await fetchLiveProviderWindows('kimi', undefined, {
      resolveKimiOauthCreds: () => ({
        accessToken: 'expired-at',
        refreshToken: 'valid-rt',
        expiresAt: 1,
      }),
      fetchImpl: fetchImpl as never,
    });

    // Antes: allowRefresh:false devolvia null com token expirado, mesmo com
    // refresh válido — a conta aparecia vazia com consumo real.
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://auth.kimi.com/api/oauth/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(w.windows?.some((x) => x.kind === 'weekly')).toBe(true);
  });

  it('kimi: refresh rejeitado (400/401) vira auth-expired, não «unavailable»', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_grant' }),
          text: async () => '',
        };
      }
      // Access antigo também rejeitado.
      return {
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => '',
      };
    });

    const probe = await fetchLiveProviderWindows('kimi', undefined, {
      resolveKimiOauthCreds: () => ({
        accessToken: 'expired-at',
        refreshToken: 'dead-rt',
        expiresAt: 1,
      }),
      fetchImpl: fetchImpl as never,
    });
    expect(probe.windows).toBeNull();
    expect(probe.hint).toBe('auth-expired');
  });

  it('grok: 401 do billing vira auth-expired (grant morto, não rede)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Invalid or expired credentials' }),
      text: async () => '',
    }));
    const probe = await fetchLiveProviderWindows('grok', undefined, {
      resolveGrokToken: () => 'dead-jwt',
      fetchImpl: fetchImpl as never,
    });
    expect(probe.windows).toBeNull();
    expect(probe.hint).toBe('auth-expired');
  });

  it('claude: cai no /usage do CLI quando o OAuth falha (row CLI nativo)', async () => {
    const failFetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => '',
    }));
    const probe = await fetchLiveProviderWindows('claude', undefined, {
      resolveClaudeToken: () => 'stale-token',
      claudeCliUsage: async () => ({
        windows: [
          {
            kind: 'session',
            label: 'Sessão',
            usedRatio: 0.38,
            source: 'provider-api',
            confidence: 'medium',
          },
        ],
      }),
      fetchImpl: failFetch,
    });
    expect(probe.windows?.find((x) => x.kind === 'session')?.usedRatio).toBe(0.38);
  });

  it('claude: account row NÃO herda a leitura única do CLI', async () => {
    const failFetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => '',
    }));
    const cliUsage = vi.fn(async () => ({
      windows: [
        {
          kind: 'session',
          label: 'Sessão',
          usedRatio: 0.38,
          source: 'provider-api',
          confidence: 'medium',
        } satisfies QuotaWindow,
      ],
    }));
    const probe = await fetchLiveProviderWindows('claude', 'acct-1', {
      resolveClaudeToken: () => null,
      claudeCliUsage: cliUsage,
      fetchImpl: failFetch,
    });
    expect(probe.windows).toBeNull();
    expect(cliUsage).not.toHaveBeenCalled();
  });

  it('claude: account row usa a cascata por conta quando o OAuth falha', async () => {
    const failFetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => '',
    }));
    const accountUsage = vi.fn(async () => ({
      windows: [
        {
          kind: 'weekly',
          label: 'Semanal',
          usedRatio: 0.73,
          source: 'provider-api',
          confidence: 'medium',
        } satisfies QuotaWindow,
      ],
      hint: 'unavailable' as const,
    }));
    const cliUsage = vi.fn();
    const probe = await fetchLiveProviderWindows('claude', 'acct-1', {
      resolveClaudeToken: () => null,
      claudeAccountUsage: accountUsage,
      claudeCliUsage: cliUsage,
      fetchImpl: failFetch,
    });
    expect(probe.windows?.[0]?.usedRatio).toBe(0.73);
    expect(accountUsage).toHaveBeenCalledWith('acct-1');
    expect(cliUsage).not.toHaveBeenCalled();
  });

  it('claude: account row propaga o hint da cascata por conta', async () => {
    const probe = await fetchLiveProviderWindows('claude', 'acct-1', {
      resolveClaudeToken: () => null,
      claudeAccountUsage: async () => ({
        windows: null,
        hint: 'auth-expired' as const,
      }),
      claudeCliUsage: vi.fn(),
    });
    expect(probe.windows).toBeNull();
    expect(probe.hint).toBe('auth-expired');
  });

  it('claude: linha nativa propaga auth-expired do probe CLI', async () => {
    const probe = await fetchLiveProviderWindows('claude', undefined, {
      resolveClaudeToken: () => null,
      claudeCliUsage: async () => ({
        windows: null,
        failure: 'auth-expired' as const,
      }),
    });
    expect(probe.windows).toBeNull();
    expect(probe.hint).toBe('auth-expired');
  });

  it('claude: linha nativa — 401 no endpoint OAuth marca auth-expired', async () => {
    const fetch401 = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '',
    }));
    const probe = await fetchLiveProviderWindows('claude', undefined, {
      resolveClaudeToken: () => 'dead-token',
      fetchImpl: fetch401,
      // `/usage` sai quieto com credencial morta (só tabela de custo) —
      // o 401 do endpoint é quem denuncia o grant morto.
      claudeCliUsage: async () => ({
        windows: null,
        failure: 'unavailable' as const,
      }),
    });
    expect(probe.windows).toBeNull();
    expect(probe.hint).toBe('auth-expired');
  });

  it('claude: linha nativa — sem token mas com sessão prévia = auth-expired', async () => {
    const probe = await fetchLiveProviderWindows('claude', undefined, {
      resolveClaudeToken: () => null,
      claudeNativeSession: () => true,
      claudeCliUsage: async () => ({
        windows: null,
        failure: 'unavailable' as const,
      }),
    });
    expect(probe.windows).toBeNull();
    expect(probe.hint).toBe('auth-expired');
  });

  it('claude: linha nativa — sem token e sem sessão prévia = no-credential', async () => {
    const probe = await fetchLiveProviderWindows('claude', undefined, {
      resolveClaudeToken: () => null,
      claudeNativeSession: () => false,
      claudeCliUsage: async () => ({
        windows: null,
        failure: 'unavailable' as const,
      }),
    });
    expect(probe.windows).toBeNull();
    expect(probe.hint).toBe('no-credential');
  });

  it('claude: linha nativa propaga cli-missing do probe CLI', async () => {
    const probe = await fetchLiveProviderWindows('claude', undefined, {
      resolveClaudeToken: () => null,
      claudeCliUsage: async () => ({
        windows: null,
        failure: 'cli-missing' as const,
      }),
    });
    expect(probe.windows).toBeNull();
    expect(probe.hint).toBe('cli-missing');
  });

  it('devin: GetUserStatus via credentials.toml → janelas reais', async () => {
    const LIVE = {
      userStatus: {
        planStatus: {
          dailyQuotaRemainingPercent: '95.5',
          dailyQuotaResetAtUnix: '1757563200',
          weeklyQuotaRemainingPercent: '80',
          weeklyQuotaResetAtUnix: '1757995200',
        },
      },
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => LIVE,
      text: async () => JSON.stringify(LIVE),
    }));
    const w = await fetchLiveProviderWindows('devin', undefined, {
      resolveDevinApiKey: () => 'wc-key',
      fetchImpl: fetchImpl as never,
    });
    expect(w.windows?.find((x) => x.kind === 'weekly')?.usedRatio).toBeCloseTo(0.2, 4);
  });

  it('cursor-agent: sem sessão local (editor/keychain) → null honesto', async () => {
    // Nesta máquina não há state.vscdb do editor nem item de keychain do
    // cursor-agent — o probe tem de devolver null, nunca inventar janela.
    const probe = await fetchLiveProviderWindows('cursor-agent', undefined, {
      fetchImpl: async () => {
        throw new Error('sem sessão local não deve haver fetch');
      },
    } as never);
    expect(probe.windows).toBeNull();
  });

  it('agy: refresca access expirado no caminho live (refresh Google não rota o grant)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'agy-fresh-at',
            expires_in: 3600,
          }),
          text: async (): Promise<string> => '',
        };
      }
      if (String(url).includes('cloudcode-pa')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            buckets: [
              {
                remainingFraction: 0.75,
                tokenType: 'REQUESTS',
                resetTime: '2026-09-21T00:00:00Z',
              },
            ],
          }),
          text: async (): Promise<string> => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async (): Promise<string> => '' };
    });
    const w = await fetchLiveProviderWindows('agy', undefined, {
      resolveGeminiOauthCreds: () => ({
        accessToken: 'expired-at',
        refreshToken: 'valid-rt',
        expiryDate: 1,
      }),
      fetchImpl: fetchImpl as never,
    });
    expect(
      fetchImpl,
    ).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(w.windows?.some((x) => x.usedRatio !== null)).toBe(true);
  });

  it('returns no-credential when resolver missing or token null', async () => {
    const claude = await fetchLiveProviderWindows('claude', undefined, {});
    expect(claude.windows).toBeNull();
    expect(claude.hint).toBe('no-credential');
    const glm = await fetchLiveProviderWindows('glm', undefined, {
      resolveGlmApiKey: () => null,
    });
    expect(glm.windows).toBeNull();
    expect(glm.hint).toBe('no-credential');
  });
});

describe('parseKimiUsage', () => {
  it.each([0, 0.5, 1, 50, 100])('interprets the explicit percent field %s on a 0–100 scale', (percent) => {
    expect(parseKimiUsage({ five_hour_usage_percent: percent })[0]?.usedRatio).toBe(percent / 100);
  });
  it('maps known percent fields', () => {
    const w = parseKimiUsage({
      five_hour_usage_percent: 30,
      weekly_usage_percent: 55,
    });
    expect(w.find((x) => x.kind === 'hours')?.usedRatio).toBe(0.3);
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBe(0.55);
  });
});
