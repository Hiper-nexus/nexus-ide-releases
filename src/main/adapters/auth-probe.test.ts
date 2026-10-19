import { describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  claude: vi.fn(
    async (): Promise<{
      value: boolean;
      cacheUpdated: boolean;
      credential?: string;
    }> => ({ value: true, cacheUpdated: true }),
  ),
  openclaude: vi.fn(async () => ({ value: true, cacheUpdated: true })),
  changed: vi.fn(),
  // F-1485: sessão Grok além da janela de renovação da própria CLI.
  grokExpired: false,
  grokHasKey: false,
  warmGrok: vi.fn(),
  kimiReadiness: 'missing' as 'missing' | 'present',
  // F-1580: a sonda real lê ~/.gemini da máquina; o teste decide o motivo.
  agyUnreadable: vi.fn((): string | null => null),
  filePresent: new Map<string, boolean>([
    ['codex', true],
    ['grok', true],
    ['agy', true],
  ]),
  identity: vi.fn((adapterId: string) => {
    const identities: Record<string, { email?: string; fingerprint: string; revision?: string }> = {
      codex: { email: 'codex@example.test', fingerprint: 'codex-fingerprint', revision: 'codex-revision' },
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
  grokHasNoRenewableSession: () => authMocks.grokExpired,
  warmGrokAccountCredentialCache: authMocks.warmGrok,
  listProviderSettings: () => [
    { adapterId: 'claude', installed: true, hasKey: false },
    { adapterId: 'codex', installed: true, hasKey: false },
    { adapterId: 'agy', installed: true, hasKey: false },
    { adapterId: 'openclaude', installed: true, hasKey: false },
    { adapterId: 'muse', installed: true, hasKey: false },
    { adapterId: 'grok', installed: true, hasKey: authMocks.grokHasKey },
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
    agyWindowsUnreadableSessionReason: authMocks.agyUnreadable,
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
  it('no Windows, sobra de outro formato em ~/.gemini não conta como sessão AGY (F-1580)', async () => {
    authMocks.agyUnreadable.mockReturnValueOnce('A sessão do AGY não está no Gerenciador de Credenciais do Windows…');
    const result = await probeAdapterAuth();
    expect(result.find((entry) => entry.adapterId === 'agy')).toMatchObject({
      state: 'missing',
      detail: expect.stringContaining('Gerenciador de Credenciais do Windows'),
    });
    expect(result.find((entry) => entry.adapterId === 'agy')?.sessionFingerprint).toBeUndefined();
  });

  it('shares refreshed Claude proof with snapshots and recognizes OpenClaude native auth', async () => {
    const result = await probeAdapterAuth();
    expect(result.find((entry) => entry.adapterId === 'openclaude')?.state).toBe('ok');
    expect(authMocks.claude).toHaveBeenCalled();
    expect(authMocks.changed).toHaveBeenCalled();
  });

  it('exposes an opaque Claude fingerprint so same-email re-login is provable', async () => {
    const credential = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'new-access-after-login',
        refreshToken: 'new-refresh-after-login',
      },
    });
    authMocks.claude.mockResolvedValueOnce({
      value: true,
      cacheUpdated: true,
      credential,
    });

    const result = await probeAdapterAuth();
    const claude = result.find((entry) => entry.adapterId === 'claude');

    expect(claude).toMatchObject({
      state: 'ok',
      detail: expect.stringContaining('retornoja@gmail.com'),
      sessionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(claude?.sessionFingerprint).not.toContain('new-access');
    expect(claude?.sessionFingerprint).not.toContain('new-refresh');
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

  it('F-1485: auth.json do Grok além da janela de renovação é missing, não ok', async () => {
    // Sem isto a lista Atenção nunca mostra o cartão (ela exige authState
    // 'missing'), e o operador fica sem o botão "Entrar" que já existe.
    authMocks.grokExpired = true;
    try {
      const result = await probeAdapterAuth();
      const grok = result.find((entry) => entry.adapterId === 'grok');
      expect(grok?.state).toBe('missing');
      expect(grok?.detail).toContain('Entrar');
      expect(grok?.detail).toContain('Contas de IA');
      // O cofre é aquecido ANTES da checagem síncrona, senão o veto de cofre
      // frio esconde a expiração (fo o loop de 7 spawns recusados).
      expect(authMocks.warmGrok).toHaveBeenCalled();
    } finally {
      authMocks.grokExpired = false;
      authMocks.warmGrok.mockClear();
    }
  });

  it('F-1485: API key no cofre cobre o Grok mesmo com a sessão OAuth vencida', async () => {
    // `grokSpawnUsesOAuth` é falso com chave injetada: o spawn nem passa pelo
    // gate, então a sonda não pode pedir login de quem tem chave.
    authMocks.grokExpired = true;
    authMocks.grokHasKey = true;
    try {
      const result = await probeAdapterAuth();
      expect(result.find((entry) => entry.adapterId === 'grok')).toMatchObject({
        state: 'ok',
        detail: 'API key no cofre',
      });
    } finally {
      authMocks.grokExpired = false;
      authMocks.grokHasKey = false;
    }
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
      sessionRevision: 'codex-revision',
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
