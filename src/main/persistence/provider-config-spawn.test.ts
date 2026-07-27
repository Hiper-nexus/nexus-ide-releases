import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnDeps = vi.hoisted(() => ({
  prepareAccount: vi.fn(),
  runtimeKey: vi.fn<() => string | null>(() => 'sk-global-other-account'),
  launcherKey: vi.fn<(providerId: string) => string | null>(() => null),
  subscriptionAuthed: vi.fn<
    (adapterId: string, model?: string) => boolean
  >(() => true),
  subscriptionStatusAuthed: vi.fn<
    (adapterId: string, model?: string) => boolean
  >(() => true),
  resolveAuthStrategy: vi.fn<
    (input: {
      authMethod: string;
      hasStoredKey: boolean;
      subscriptionAuthed: boolean;
    }) => {
      strategy: string;
      injectKey: boolean;
      suppressKeyEnv: boolean;
    }
  >(() => ({
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
  models: {
    flag: '--model',
    list: ['claude-sonnet'],
    default: 'claude-sonnet',
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
  models: {
    flag: '--model',
    list: [
      'anthropic/claude-sonnet-4-6',
      'openai-codex/gpt-5.5',
      'zai/glm-5',
    ],
    default: 'anthropic/claude-sonnet-4-6',
  },
};

const opencodeAdapter = {
  ...kimiAdapter,
  id: 'opencode',
  label: 'OpenCode',
  bin: 'opencode',
  install: { command: 'brew install anomalyco/tap/opencode' },
  auth: {
    method: 'api_key',
    envVarFallback: 'ANTHROPIC_API_KEY',
    loginHint: 'opencode auth login',
  },
  env: {
    passthrough: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  },
  models: {
    flag: '--model',
    list: [
      'opencode/big-pickle',
      'opencode/north-mini-code-free',
      'openrouter/openai/gpt-5',
    ],
    default: 'opencode/big-pickle',
  },
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
          : id === 'opencode'
            ? opencodeAdapter
          : null,
  isBinResolvable: () => true,
  getAdapterResolvedBin: (id: string) =>
    id === 'claude'
      ? '/usr/local/bin/claude'
      : id === 'kimi'
        ? '/Users/test/.kimi-code/bin/kimi'
      : id === 'omp'
        ? '/usr/local/bin/omp'
        : id === 'opencode'
          ? '/opt/homebrew/bin/opencode'
        : null,
  resolveAdapterBinary: (id: string) =>
    id === 'claude'
      ? '/usr/local/bin/claude'
      : id === 'kimi'
        ? '/Users/test/.kimi-code/bin/kimi'
      : id === 'omp'
        ? '/usr/local/bin/omp'
        : id === 'opencode'
          ? '/opt/homebrew/bin/opencode'
        : null,
  rescanAdapterBinaries: vi.fn(() => []),
  listAdapters: () => [
    claudeAdapter,
    kimiAdapter,
    ompAdapter,
    opencodeAdapter,
  ],
  notifyAdaptersChanged: vi.fn(),
  primaryKeyEnvVar: (adapter: { auth: { envVarFallback?: string } }) =>
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
  loadLauncherProviderKey: spawnDeps.launcherKey,
}));

vi.mock('../adapters/model-catalog', () => ({
  loadModelCatalog: () => [],
  modelInfoForAdapter: () => [],
}));

vi.mock('../adapters/subscription-auth', () => ({
  hasSubscriptionAuth: spawnDeps.subscriptionAuthed,
  hasSubscriptionAuthForStatus: spawnDeps.subscriptionStatusAuthed,
  refreshClaudeSubscriptionAuthCache: vi.fn(async () => ({
    value: true,
    cacheUpdated: false,
  })),
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
  listProviderSettings,
  prepareProviderSpawn,
  providerAuthStrategy,
  providerReadiness,
} from './provider-config-store';

describe('prepareProviderSpawn with a pane-pinned account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnDeps.runtimeKey.mockReturnValue('sk-global-other-account');
    spawnDeps.launcherKey.mockReturnValue(null);
    spawnDeps.subscriptionAuthed.mockReturnValue(true);
    spawnDeps.subscriptionStatusAuthed.mockReturnValue(true);
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

  it('blocks login-needed OMP before any pane or RPC worker can start', () => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'login-needed',
      injectKey: false,
      suppressKeyEnv: false,
    });

    expect(providerAuthStrategy('omp')).toBe('login-needed');
    expect(providerReadiness('omp')).toMatchObject({ ready: false });
    expect(prepareProviderSpawn('omp')).toMatchObject({ ok: false });
  });

  it('scopes OMP readiness to the exact selected provider/model', () => {
    spawnDeps.subscriptionAuthed.mockImplementation(
      (_adapterId: string, model?: string) =>
        model === 'openai-codex/gpt-5.5',
    );
    spawnDeps.resolveAuthStrategy.mockImplementation(
      ({ subscriptionAuthed, hasStoredKey }) => ({
        strategy: subscriptionAuthed
          ? 'subscription'
          : hasStoredKey
            ? 'api-key'
            : 'login-needed',
        injectKey: !subscriptionAuthed && hasStoredKey,
        suppressKeyEnv: subscriptionAuthed,
      }),
    );

    expect(
      providerReadiness('omp', 'openai-codex/gpt-5.5'),
    ).toMatchObject({ ready: true });
    expect(
      providerReadiness('omp', 'anthropic/claude-sonnet-4-6'),
    ).toMatchObject({ ready: false });
    expect(spawnDeps.subscriptionAuthed).toHaveBeenCalledWith(
      'omp',
      'openai-codex/gpt-5.5',
    );
  });

  it('injects only the selected OMP provider key family', () => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.launcherKey.mockImplementation((providerId: string) =>
      providerId === 'glm' ? 'selected-provider-key' : null,
    );
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'api-key',
      injectKey: true,
      suppressKeyEnv: false,
    });

    const result = prepareProviderSpawn('omp', { model: 'zai/glm-5' });

    expect(result).toMatchObject({
      ok: true,
      overrides: {
        keyEnv: {
          ZAI_API_KEY: 'selected-provider-key',
        },
      },
    });
    if (!result.ok) throw new Error('expected an OMP spawn');
    expect(result.overrides.keyEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(result.overrides.keyEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect(result.overrides.keyEnv).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(spawnDeps.launcherKey).toHaveBeenCalledWith('glm');
    expect(spawnDeps.launcherKey).not.toHaveBeenCalledWith('anthropic');
  });

  it('allows credentialless OpenCode only for an exact pinned first-party free model', () => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.subscriptionStatusAuthed.mockReturnValue(false);
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'login-needed',
      injectKey: false,
      suppressKeyEnv: false,
    });

    expect(providerReadiness('opencode')).toEqual({
      ready: true,
      reason: 'ready',
    });
    expect(
      listProviderSettings().find(
        (provider) => provider.adapterId === 'opencode',
      )?.authStrategy,
    ).toBe('login-needed');
    expect(
      prepareProviderSpawn('opencode', {
        model: 'opencode/north-mini-code-free',
      }),
    ).toMatchObject({
      ok: true,
      overrides: {
        binPath: '/opt/homebrew/bin/opencode',
        keyEnv: {},
        suppressEnv: [],
      },
    });
  });

  it('builds provider snapshots exclusively from the non-blocking auth status path', () => {
    vi.clearAllMocks();
    listProviderSettings({ nonBlockingAuth: true });

    expect(spawnDeps.subscriptionStatusAuthed).toHaveBeenCalled();
    expect(spawnDeps.subscriptionAuthed).not.toHaveBeenCalled();
  });

  it.each([
    'openrouter/openai/gpt-5',
    'opencode/unreviewed-free',
    'other/opencode/big-pickle',
  ])(
    'keeps unauthenticated OpenCode blocked for non-allowlisted model %s',
    (model) => {
      spawnDeps.subscriptionAuthed.mockReturnValue(false);
      spawnDeps.runtimeKey.mockReturnValue(null);
      spawnDeps.resolveAuthStrategy.mockReturnValue({
        strategy: 'login-needed',
        injectKey: false,
        suppressKeyEnv: false,
      });

      expect(providerReadiness('opencode', model)).toMatchObject({
        ready: false,
      });
      expect(prepareProviderSpawn('opencode', { model })).toMatchObject({
        ok: false,
      });
    },
  );

  it('does not activate a stale implicit OpenCode account for a credentialless model', () => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'login-needed',
      injectKey: false,
      suppressKeyEnv: false,
    });
    spawnDeps.listAccounts.mockReturnValue([
      {
        id: 'stale-opencode',
        adapterId: 'opencode',
        label: 'Stale OpenCode',
        mode: 'subscription',
        upstream: 'anthropic',
        createdAt: 1,
      },
    ]);
    spawnDeps.getActiveAccount.mockReturnValue({
      id: 'stale-opencode',
      adapterId: 'opencode',
      label: 'Stale OpenCode',
      mode: 'subscription',
      upstream: 'anthropic',
      createdAt: 1,
    });

    expect(
      prepareProviderSpawn('opencode', {
        model: 'opencode/big-pickle',
      }),
    ).toMatchObject({
      ok: true,
      overrides: { keyEnv: {}, suppressEnv: [] },
    });
    expect(spawnDeps.getActiveAccount).not.toHaveBeenCalled();
    expect(spawnDeps.ensureSubscriptionActive).not.toHaveBeenCalled();
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
