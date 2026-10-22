import { describe, expect, it, vi } from 'vitest';
import {
  claudeAccessTokenExpired,
  claudeBlobIsRenewable,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_REFRESH_SKEW_MS,
  CLAUDE_REFRESH_TIMEOUT_MS,
  claudeBlobIsExpiredUnhealable,
  claudeBlobNeedsRefresh,
  forceRefreshClaudeOauthBlob,
  refreshClaudeOauthBlob,
} from './claude-oauth-refresh';

const NOW = 1_700_000_000_000;

function blob(oauth: Record<string, unknown>): string {
  return JSON.stringify({ claudeAiOauth: oauth });
}

describe('claudeBlobNeedsRefresh', () => {
  it('pede refresh quando o access token está expirado (caso de campo: 401 no respawn)', () => {
    const value = blob({
      accessToken: 'stale',
      refreshToken: 'refresh-1',
      expiresAt: NOW - 1000,
    });
    expect(claudeBlobNeedsRefresh(value, NOW)).toEqual({ refreshToken: 'refresh-1' });
  });

  it('pede refresh dentro da janela de folga e sem expiresAt', () => {
    expect(
      claudeBlobNeedsRefresh(
        blob({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + CLAUDE_REFRESH_SKEW_MS - 1 }),
        NOW,
      ),
    ).not.toBeNull();
    expect(
      claudeBlobNeedsRefresh(blob({ accessToken: 'a', refreshToken: 'r' }), NOW),
    ).not.toBeNull();
  });

  it('não pede refresh com token ainda válido ou sem refresh token', () => {
    expect(
      claudeBlobNeedsRefresh(
        blob({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 2 * CLAUDE_REFRESH_SKEW_MS }),
        NOW,
      ),
    ).toBeNull();
    expect(
      claudeBlobNeedsRefresh(blob({ accessToken: 'a', expiresAt: NOW - 1 }), NOW),
    ).toBeNull();
    expect(claudeBlobNeedsRefresh('not json', NOW)).toBeNull();
  });
});

describe('claudeBlobIsExpiredUnhealable (F-511)', () => {
  it('vencido sem refresh = 401 garantido: verdadeiro', () => {
    expect(
      claudeBlobIsExpiredUnhealable(
        blob({ accessToken: 'stale', expiresAt: NOW - 1000 }),
        NOW,
      ),
    ).toBe(true);
  });

  it('vencido COM refresh = curável pelo sweeper/failover: falso', () => {
    expect(
      claudeBlobIsExpiredUnhealable(
        blob({ accessToken: 'stale', refreshToken: 'r', expiresAt: NOW - 1000 }),
        NOW,
      ),
    ).toBe(false);
  });

  it('fresco sem refresh: falso (presença continua valendo)', () => {
    expect(
      claudeBlobIsExpiredUnhealable(
        blob({ accessToken: 'a', expiresAt: NOW + 2 * CLAUDE_REFRESH_SKEW_MS }),
        NOW,
      ),
    ).toBe(false);
  });

  it('sem expiresAt confiável não há juízo: falso', () => {
    expect(
      claudeBlobIsExpiredUnhealable(blob({ accessToken: 'a' }), NOW),
    ).toBe(false);
    expect(claudeBlobIsExpiredUnhealable('not json', NOW)).toBe(false);
  });
});

describe('refreshClaudeOauthBlob', () => {
  it('renova via token endpoint e preserva rotação + campos extras do blob', async () => {
    const fetchImpl = vi.fn(async (url: string, init: { body: string }) => {
      expect(url).toBe(CLAUDE_OAUTH_TOKEN_URL);
      const body = JSON.parse(init.body) as Record<string, string>;
      expect(body.grant_type).toBe('refresh_token');
      expect(body.refresh_token).toBe('refresh-1');
      expect(body.client_id).toBe(CLAUDE_CODE_CLIENT_ID);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'fresh-access',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        }),
      };
    });
    const original = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'stale',
        refreshToken: 'refresh-1',
        expiresAt: NOW - 1,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
      outroCampo: true,
    });
    const updated = await refreshClaudeOauthBlob(original, NOW, fetchImpl);
    expect(updated).not.toBeNull();
    const parsed = JSON.parse(updated!) as {
      claudeAiOauth: Record<string, unknown>;
      outroCampo: boolean;
    };
    expect(parsed.claudeAiOauth.accessToken).toBe('fresh-access');
    expect(parsed.claudeAiOauth.refreshToken).toBe('refresh-2');
    expect(parsed.claudeAiOauth.expiresAt).toBe(NOW + 3_600_000);
    expect(parsed.claudeAiOauth.scopes).toEqual(['user:inference']);
    expect(parsed.claudeAiOauth.subscriptionType).toBe('max');
    expect(parsed.outroCampo).toBe(true);
  });

  it('falha vira null (mantém blob antigo): HTTP erro, payload inválido, rede', async () => {
    const stale = blob({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW - 1 });
    expect(
      await refreshClaudeOauthBlob(stale, NOW, async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
      })),
    ).toBeNull();
    expect(
      await refreshClaudeOauthBlob(stale, NOW, async () => ({
        ok: true,
        status: 200,
        json: async () => ({ no_token: true }),
      })),
    ).toBeNull();
    expect(
      await refreshClaudeOauthBlob(stale, NOW, async () => {
        throw new Error('offline');
      }),
    ).toBeNull();
  });

  it('token ainda válido não dispara chamada nenhuma', async () => {
    const fetchImpl = vi.fn();
    const fresh = blob({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: NOW + 2 * CLAUDE_REFRESH_SKEW_MS,
    });
    expect(await refreshClaudeOauthBlob(fresh, NOW, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('401 força renovação mesmo quando expiresAt ainda diz que o token está válido', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'recovered-access',
        refresh_token: 'recovered-refresh',
        expires_in: 3600,
      }),
    }));
    const revoked = blob({
      accessToken: 'revoked-before-expiry',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 2 * CLAUDE_REFRESH_SKEW_MS,
    });

    const updated = await forceRefreshClaudeOauthBlob(revoked, NOW, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(updated!).claudeAiOauth).toMatchObject({
      accessToken: 'recovered-access',
      refreshToken: 'recovered-refresh',
    });
  });

  it('aborta refresh pendurado para liberar novas tentativas da conta', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        async (
          _url: string,
          init: { signal?: AbortSignal },
        ): Promise<never> =>
          new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      );
      const pending = forceRefreshClaudeOauthBlob(
        blob({
          accessToken: 'revoked',
          refreshToken: 'refresh-1',
          expiresAt: NOW + CLAUDE_REFRESH_SKEW_MS,
        }),
        NOW,
        fetchImpl,
      );

      await vi.advanceTimersByTimeAsync(CLAUDE_REFRESH_TIMEOUT_MS);

      await expect(pending).resolves.toBeNull();
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('mantém o timeout ativo enquanto o body da resposta é lido', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        async (_url: string, init: { signal?: AbortSignal }) => ({
          ok: true,
          status: 200,
          json: async (): Promise<never> =>
            new Promise((_, reject) => {
              init.signal?.addEventListener('abort', () => {
                reject(new Error('body aborted'));
              });
            }),
        }),
      );
      const pending = forceRefreshClaudeOauthBlob(
        blob({
          accessToken: 'revoked',
          refreshToken: 'refresh-1',
          expiresAt: NOW + CLAUDE_REFRESH_SKEW_MS,
        }),
        NOW,
        fetchImpl,
      );

      await vi.advanceTimersByTimeAsync(CLAUDE_REFRESH_TIMEOUT_MS);

      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('claudeBlobIsRenewable (F-1416)', () => {
  const now = Date.parse('2026-10-12T21:00:00Z');
  const blob = (oauth: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: oauth });
  it('access vencido com refresh no prazo é renovável — não é sessão expirada', () => {
    expect(claudeBlobIsRenewable(blob({ accessToken: 'a', expiresAt: now - 1, refreshToken: 'r', refreshTokenExpiresAt: now + 1 }), now)).toBe(true);
    expect(claudeBlobIsRenewable(blob({ accessToken: 'a', expiresAt: now - 1, refreshToken: 'r' }), now)).toBe(true);
  });
  it('sem refresh token, refresh vencido ou blob ilegível não é renovável', () => {
    expect(claudeBlobIsRenewable(blob({ accessToken: 'a', expiresAt: now - 1 }), now)).toBe(false);
    expect(claudeBlobIsRenewable(blob({ accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: now }), now)).toBe(false);
    expect(claudeBlobIsRenewable('not json', now)).toBe(false);
  });
});

describe('claudeAccessTokenExpired (F-1637)', () => {
  const blob = (expiresAt?: unknown) =>
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', ...(expiresAt === undefined ? {} : { expiresAt }) } });

  it('só o relógio vencido conta; sem expiresAt confiável não há juízo', () => {
    expect(claudeAccessTokenExpired(blob(1_000), 1_000)).toBe(true);
    expect(claudeAccessTokenExpired(blob(2_000), 1_000)).toBe(false);
    expect(claudeAccessTokenExpired(blob(), 1_000)).toBe(false);
    expect(claudeAccessTokenExpired(blob('1000'), 5_000)).toBe(false);
    expect(claudeAccessTokenExpired('not json', 5_000)).toBe(false);
  });
});
