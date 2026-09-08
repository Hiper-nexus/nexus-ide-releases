import { describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  claude: vi.fn(async () => ({ value: true, cacheUpdated: true })),
  openclaude: vi.fn(async () => ({ value: true, cacheUpdated: true })),
  changed: vi.fn(),
  kimiReadiness: 'missing' as 'missing' | 'present',
  filePresent: new Map<string, boolean>([
    ['codex', true],
    ['grok', true],
    ['agy', true],
  ]),
  identity: vi.fn((adapterId: string) => {
    const identities: Record<string, { email?: string; fingerprint: string }> = {
      codex: { email: 'codex@example.test', fingerprint: 'codex-fingerprint' },
      grok: { email: 'grok@example.test', fingerprint: 'grok-fingerprint' },
      agy: { email: 'agy@example.test', fingerprint: 'agy-fingerprint' },
      kimi: { fingerprint: 'kimi-fingerprint' },
      opencode: { fingerprint: 'opencode-fingerprint' },
    };
    return identities[adapterId] ?? {};
  }),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../persistence/provider-config-store', () => ({
  notifyProviderAuthChanged: authMocks.changed,
  listProviderSettings: () => [
    { adapterId: 'claude', installed: true, hasKey: false },
    { adapterId: 'codex', installed: true, hasKey: false },
    { adapterId: 'agy', installed: true, hasKey: false },
    { adapterId: 'openclaude', installed: true, hasKey: false },
    { adapterId: 'muse', installed: true, hasKey: false },
    { adapterId: 'grok', installed: true, hasKey: false },
    { adapterId: 'kimi', installed: true, hasKey: false },
    { adapterId: 'opencode', installed: true, hasKey: false },
    { adapterId: 'aider', installed: true, hasKey: true },
    { adapterId: 'glm', installed: true, hasKey: false, keyEnvVar: 'ANTHROPIC_AUTH_TOKEN' },
    { adapterId: 'longcat', installed: true, hasKey: false, keyEnvVar: 'ANTHROPIC_AUTH_TOKEN' },
  ],
}));

vi.mock('./subscription-auth', () => ({
  hasSubscriptionAuth: (adapterId: string) => adapterId === 'grok',
  detectSubscriptionAuth: (adapterId: string) =>
    adapterId === 'grok' || adapterId === 'claude',
  claudeOauthEmail: () => 'retornoja@gmail.com',
  refreshClaudeSubscriptionAuthCache: authMocks.claude,
  refreshOpenClaudeSubscriptionAuthCache: authMocks.openclaude,
  subscriptionAuthStatusIsUnknown: (id: string) => id === 'muse',
  refreshAgySubscriptionAuthCache: async () => ({
    value: true,
    cacheUpdated: true,
  }),
}));

vi.mock('./managed-credentials', async () => {
  const actual = await vi.importActual<typeof import('./managed-credentials')>(
    './managed-credentials',
  );
  return {
    ...actual,
    hasNativeFileAuth: (adapterId: string) =>
      authMocks.filePresent.get(adapterId) === true,
    nativeAuthIdentity: authMocks.identity,
  };
});

// A sonda do Kimi executa `kimi provider list --json` de verdade. Sem este
// mock o teste passava a depender de a máquina de quem roda estar deslogada:
// depois do fix de 0.68.4 (o JSON de mapa do CLI 0.38 é reconhecido), uma
// máquina COM kimi logado devolvia `ok` e o caso quebrava sozinho.
vi.mock('./kimi-seat-probe', () => ({
  refreshKimiSeatReadiness: async () => authMocks.kimiReadiness,
}));

import { probeAdapterAuth } from './auth-probe';

describe('probeAdapterAuth provider-specific diagnostics', () => {
  it('shares refreshed Claude proof with snapshots and recognizes OpenClaude native auth', async () => {
    const result = await probeAdapterAuth();
    expect(result.find((entry) => entry.adapterId === 'openclaude')?.state).toBe('ok');
    expect(authMocks.claude).toHaveBeenCalled();
    expect(authMocks.changed).toHaveBeenCalled();
  });

  it('does not ask a Keychain-backed Muse session to log in without checking it', async () => {
    const result = await probeAdapterAuth();
    expect(result.find((entry) => entry.adapterId === 'muse')).toMatchObject({
      state: 'unknown', detail: expect.stringContaining('Keychain'),
    });
  });

  it('reports an inaccessible credential authority as unknown without failing all providers', async () => {
    authMocks.claude.mockRejectedValueOnce(new Error('Keychain unavailable'));
    const result = await probeAdapterAuth();
    expect(result.find((entry) => entry.adapterId === 'claude')?.state).toBe('unknown');
    expect(result.find((entry) => entry.adapterId === 'grok')?.state).toBe('ok');
  });
  it('reports current login commands and treats Aider as API-key-only', async () => {
    const result = await probeAdapterAuth();
    const byId = Object.fromEntries(result.map((entry) => [entry.adapterId, entry]));

    expect(byId.claude).toMatchObject({
      state: 'ok',
      detail: expect.stringContaining('retornoja@gmail.com'),
    });
    expect(byId.codex).toMatchObject({
      state: 'ok',
      detail: expect.stringContaining('codex@example.test'),
      sessionFingerprint: 'codex-fingerprint',
    });
    expect(byId.grok).toMatchObject({
      state: 'ok',
      detail: expect.stringContaining('grok@example.test'),
      sessionFingerprint: 'grok-fingerprint',
    });
    expect(byId.agy).toMatchObject({
      state: 'ok',
      detail: expect.stringContaining('agy@example.test'),
      sessionFingerprint: 'agy-fingerprint',
    });
    expect(byId.kimi).toMatchObject({
      state: 'missing',
      detail: expect.stringContaining('kimi login'),
    });
    expect(byId.opencode).toMatchObject({
      state: 'missing',
      detail: expect.stringContaining('opencode auth login'),
    });
    expect(byId.aider).toEqual({
      adapterId: 'aider',
      state: 'ok',
      detail: 'API key no cofre',
    });
    expect(byId.glm).toEqual({
      adapterId: 'glm',
      state: 'missing',
      detail: 'precisa colar a chave desta CLI',
    });
    expect(byId.longcat).toEqual({
      adapterId: 'longcat',
      state: 'missing',
      detail: 'precisa colar a chave desta CLI',
    });
  });

  it('does not treat a present-but-unusable Codex auth file as a session', async () => {
    authMocks.filePresent.set('codex', false);
    try {
      const result = await probeAdapterAuth();
      expect(result.find((entry) => entry.adapterId === 'codex')).toEqual({
        adapterId: 'codex',
        state: 'missing',
        detail: 'sem sessão — rode `codex login`',
      });
    } finally {
      authMocks.filePresent.set('codex', true);
    }
  });

  it('exposes an opaque fingerprint when a live session has no email claim', async () => {
    authMocks.kimiReadiness = 'present';
    try {
      const result = await probeAdapterAuth();
      expect(result.find((entry) => entry.adapterId === 'kimi')).toEqual({
        adapterId: 'kimi',
        state: 'ok',
        detail: 'sessão Kimi Code OAuth (provider list, source=oauth)',
        sessionFingerprint: 'kimi-fingerprint',
      });
    } finally {
      authMocks.kimiReadiness = 'missing';
    }
  });
});
