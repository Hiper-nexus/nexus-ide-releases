import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnDeps = vi.hoisted(() => ({
  prepareAccount: vi.fn(),
  runtimeKey: vi.fn<() => string | null>(() => 'sk-global-other-account'),
  subscriptionAuthed: vi.fn(() => true),
  resolveAuthStrategy: vi.fn(() => ({
    strategy: 'subscription',
    injectKey: false,
    suppressKeyEnv: true,
  })),
  listAccounts: vi.fn((): Array<Record<string, unknown>> => []),
  getActiveAccount: vi.fn(),
  ensureSubscriptionActive: vi.fn(() => true),
  activeClaudeAuthEnv: vi.fn<() => Record<string, string> | null>(() => ({
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-active',
  })),
}));

const claudeAdapter = {
  id: 'claude',
  kind: 'cli-pty' as const,
  label: 'Claude',
  bin: 'claude',
  install: { command: 'npm install claude' },
  auth: { method: 'oauth', loginHint: 'claude /login' },
  env: {
    passthrough: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
  },
};

const kimiAdapter = {
  id: 'kimi',
  kind: 'cli-pty' as const,
  label: 'Kimi',
  bin: 'kimi',
  install: { command: 'npm install -g @moonshot-ai/kimi-code' },
  auth: {
    method: 'api_key',
    envVarFallback: 'KIMI_MODEL_API_KEY',
    loginHint: 'kimi login',
  },
  env: {
    passthrough: [
      'KIMI_MODEL_NAME',
      'KIMI_MODEL_API_KEY',
      'KIMI_MODEL_BASE_URL',
    ],
  },
  models: {
    flag: '--model',
    list: ['kimi-code/kimi-for-coding'],
    default: 'kimi-code/kimi-for-coding',
  },
};

const ompAdapter = {
  ...claudeAdapter,
  id: 'omp',
  label: 'Oh My Pi',
  bin: 'omp',
  install: { command: 'brew install can1357/tap/omp' },
  auth: { method: 'oauth', loginHint: 'omp auth-broker login' },
  env: { passthrough: [] },
};

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: (id: string) =>
    id === 'claude'
      ? claudeAdapter
      : id === 'kimi'
        ? kimiAdapter
        : id === 'omp'
          ? ompAdapter
          : null,
  isBinResolvable: () => true,
  getAdapterResolvedBin: (id: string) =>
    id === 'claude'
      ? '/usr/local/bin/claude'
      : id === 'kimi'
        ? '/Users/test/.kimi-code/bin/kimi'
        : id === 'omp'
          ? '/usr/local/bin/omp'
          : null,
  resolveAdapterBinary: (id: string) =>
    id === 'claude'
      ? '/usr/local/bin/claude'
      : id === 'kimi'
        ? '/Users/test/.kimi-code/bin/kimi'
        : id === 'omp'
          ? '/usr/local/bin/omp'
          : null,
  rescanAdapterBinaries: vi.fn(() => []),
  listAdapters: () => [claudeAdapter, kimiAdapter, ompAdapter],
  notifyAdaptersChanged: vi.fn(),
  primaryKeyEnvVar: (adapter: typeof claudeAdapter | typeof kimiAdapter) =>
    'envVarFallback' in adapter.auth
      ? adapter.auth.envVarFallback
      : null,
}));

// Unit tests use synthetic absolute paths that do not exist on disk.
vi.mock('../path-resolver', () => ({
  revalidateExecutable: (binPath: string) =>
    typeof binPath === 'string' &&
    (binPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(binPath)),
}));

vi.mock('../adapters/control-args', () => ({
  availableEfforts: () => [],
  availablePermissionModes: () => [],
  buildControlArgs: () => [],
  defaultPermissionMode: () => '',
  supportsVerbose: () => false,
}));

vi.mock('../adapters/custom-models', () => ({
  addCustomModel: vi.fn(),
  getCustomModels: () => [],
  removeCustomModel: vi.fn(),
}));

vi.mock('./secrets-store', () => ({
  getKey: spawnDeps.runtimeKey,
  hasCachedSecret: () => false,
  hasSecret: () => false,
  isSecureStorageAvailable: () => true,
  maskedKey: () => null,
  setKey: vi.fn(),
}));

vi.mock('../adapters/provider-test', () => ({ testProviderKey: vi.fn() }));

vi.mock('../adapters/launcher-provider-manager', () => ({
  buildProviderRoutingEnv: () => ({}),
  listUpstreamProviders: () => [],
  loadLauncherProviderKey: () => null,
}));

vi.mock('../adapters/model-catalog', () => ({
  loadModelCatalog: () => [],
  modelInfoForAdapter: () => [],
}));

vi.mock('../adapters/subscription-auth', () => ({
  hasSubscriptionAuth: spawnDeps.subscriptionAuthed,
  resolveAuthStrategy: spawnDeps.resolveAuthStrategy,
}));

vi.mock('./account-store', () => ({
  activeClaudeAuthEnv: spawnDeps.activeClaudeAuthEnv,
  accountKey: () => 'sk-active-other-account',
  ensureSubscriptionActive: spawnDeps.ensureSubscriptionActive,
  getActiveAccount: spawnDeps.getActiveAccount,
  listAccounts: spawnDeps.listAccounts,
  prepareAccountForSpawn: spawnDeps.prepareAccount,
}));

import {
  prepareProviderSpawn,
  providerReadiness,
} from './provider-config-store';

describe('prepareProviderSpawn with a pane-pinned account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnDeps.runtimeKey.mockReturnValue('sk-global-other-account');
    spawnDeps.subscriptionAuthed.mockReturnValue(true);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'subscription',
      injectKey: false,
      suppressKeyEnv: true,
    });
    spawnDeps.listAccounts.mockReturnValue([]);
    spawnDeps.getActiveAccount.mockReset();
    spawnDeps.ensureSubscriptionActive.mockReturnValue(true);
    spawnDeps.activeClaudeAuthEnv.mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-active',
    });
  });

  it('does not block OMP before its own multi-provider auth broker can start', () => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'login-needed',
      injectKey: false,
      suppressKeyEnv: false,
    });

    expect(providerReadiness('omp')).toEqual({ ready: true, reason: 'ready' });
    expect(prepareProviderSpawn('omp')).toMatchObject({ ok: true });
  });

  it('keeps the native Claude session authoritative for unpinned panes', () => {
    spawnDeps.listAccounts.mockReturnValueOnce([{
      id: 'acct-stale',
      adapterId: 'claude',
      label: 'Stale Claude Max',
      mode: 'subscription',
      upstream: 'anthropic',
      createdAt: 1,
    }]);
    spawnDeps.getActiveAccount.mockReturnValueOnce({
      id: 'acct-stale',
      adapterId: 'claude',
      label: 'Stale Claude Max',
      mode: 'subscription',
      upstream: 'anthropic',
      createdAt: 1,
    });

    const result = prepareProviderSpawn('claude');

    expect(result).toMatchObject({
      ok: true,
      overrides: {
        // HOME real: nenhum token env. O CLI usa e RENOVA a linhagem nativa;
        // um snapshot estático com precedência sobre o login expira em horas
        // (401 no respawn de failover).
        keyEnv: {},
        suppressEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
      },
    });
    expect(spawnDeps.getActiveAccount).not.toHaveBeenCalled();
    expect(spawnDeps.ensureSubscriptionActive).not.toHaveBeenCalled();
  });

  it('does not decrypt the global vault when native subscription auth wins', () => {
    const result = prepareProviderSpawn('claude');

    expect(result).toMatchObject({
      ok: true,
      overrides: {
        keyEnv: {},
        suppressEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
      },
    });
    expect(spawnDeps.runtimeKey).not.toHaveBeenCalled();
  });

  it('pane com HOME isolado recebe o token nativo — lá é a única ponte', () => {
    // Regressão do orquestrador mudo: pane gated roda em HOME efêmero, onde o
    // CLI não enxerga o login do Keychain. Sem token env ele abre
    // "Not logged in · Run /login" com a máquina autenticada (a identidade
    // projetada ainda escreve "Welcome back", mascarando a causa).
    const result = prepareProviderSpawn('claude', { isolatedHome: true });

    expect(result).toMatchObject({
      ok: true,
      overrides: {
        keyEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-active' },
        suppressEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
      },
    });
  });

  it('HOME isolado sem credencial nativa legível recusa o spawn com motivo', () => {
    // Fail-closed: recusar com motivo é melhor do que entregar um orquestrador
    // mudo em /login, que trava a missão sem explicar nada.
    spawnDeps.activeClaudeAuthEnv.mockReturnValue(null);

    const result = prepareProviderSpawn('claude', { isolatedHome: true });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected a refused claude spawn');
    expect(result.error).toMatch(/credencial nativa do Claude/i);
  });

  it('injects Kimi API credentials through the official transient-model env', () => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.runtimeKey.mockReturnValue('sk-kimi-selected');
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'api-key',
      injectKey: true,
      suppressKeyEnv: false,
    });

    const result = prepareProviderSpawn('kimi', {
      model: 'kimi-code/kimi-for-coding',
    });

    expect(result).toEqual({
      ok: true,
      overrides: {
        binPath: '/Users/test/.kimi-code/bin/kimi',
        defaultModel: null,
        extraArgs: [],
        keyEnv: {
          KIMI_MODEL_API_KEY: 'sk-kimi-selected',
          KIMI_MODEL_NAME: 'kimi-for-coding',
        },
        suppressEnv: [],
      },
    });
  });

  it('keeps Kimi OAuth authoritative over every transient-model env', () => {
    const result = prepareProviderSpawn('kimi');

    expect(result).toMatchObject({
      ok: true,
      overrides: {
        keyEnv: {},
        suppressEnv: expect.arrayContaining([
          'KIMI_MODEL_NAME',
          'KIMI_MODEL_API_KEY',
          'KIMI_MODEL_BASE_URL',
          'KIMI_MODEL_THINKING_KEEP',
        ]),
      },
    });
  });

  it('returns the exact account error instead of passing through global auth', () => {
    spawnDeps.prepareAccount.mockReturnValueOnce({
      ok: false,
      error: 'selected subscription "Claude Max" could not be activated',
    });

    const result = prepareProviderSpawn('claude', {
      accountId: 'acct-selected',
    });

    expect(result).toEqual({
      ok: false,
      error: 'selected subscription "Claude Max" could not be activated',
    });
    expect(spawnDeps.prepareAccount).toHaveBeenCalledWith(
      'claude',
      'acct-selected',
      undefined,
      { isolatedHome: false },
    );
    expect(spawnDeps.resolveAuthStrategy).not.toHaveBeenCalled();
  });

  it('injects only the credential returned for the exact selected account', () => {
    const account = {
      id: 'acct-selected',
      adapterId: 'claude',
      label: 'Selected',
      mode: 'api-key' as const,
      upstream: 'anthropic',
      createdAt: 2,
    };
    spawnDeps.prepareAccount.mockReturnValueOnce({
      ok: true,
      account,
      apiKey: 'sk-exact-selected',
      authEnv: {},
    });

    const result = prepareProviderSpawn('claude', {
      accountId: account.id,
    });

    expect(result).toEqual({
      ok: true,
      overrides: {
        binPath: '/usr/local/bin/claude',
        defaultModel: null,
        extraArgs: [],
        keyEnv: { ANTHROPIC_API_KEY: 'sk-exact-selected' },
        suppressEnv: [],
      },
    });
  });

  it('injects a pinned subscription as process-scoped OAuth', () => {
    const account = {
      id: 'acct-max',
      adapterId: 'claude',
      label: 'Claude Max',
      mode: 'subscription' as const,
      upstream: 'anthropic',
      createdAt: 3,
    };
    spawnDeps.prepareAccount.mockReturnValueOnce({
      ok: true,
      account,
      apiKey: null,
      authEnv: {
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-account-max',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh-account-max',
      },
    });

    const result = prepareProviderSpawn('claude', { accountId: account.id });

    expect(result).toEqual({
      ok: true,
      overrides: {
        binPath: '/usr/local/bin/claude',
        defaultModel: null,
        extraArgs: [],
        keyEnv: {
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth-account-max',
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh-account-max',
        },
        suppressEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
      },
    });
  });
});
