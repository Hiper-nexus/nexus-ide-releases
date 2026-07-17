import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_REFRESH_SKEW_MS,
  claudeBlobNeedsRefresh,
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
});
