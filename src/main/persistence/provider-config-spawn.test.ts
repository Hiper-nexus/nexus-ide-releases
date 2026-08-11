import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnDeps = vi.hoisted(() => ({
  prepareAccount: vi.fn(),
  runtimeKey: vi.fn<() => string | null>(() => 'sk-global-other-account'),
  hasSecret: vi.fn(() => false),
  launcherKey: vi.fn<(providerId: string) => string | null>(() => null),
  subscriptionAuthed: vi.fn<
    (adapterId: string, model?: string) => boolean
  >(() => true),
  subscriptionStatusAuthed: vi.fn<
    (adapterId: string, model?: string) => boolean
  >(() => true),
  refreshAgyAuth: vi.fn(async () => ({
    value: true,
    cacheUpdated: true,
  })),
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
  spawn: {
    interactive: ['claude'],
    headless: [],
    ptyRequired: true,
    extraArgs: [],
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
  spawn: {
    interactive: ['kimi'],
    headless: [],
    ptyRequired: true,
    extraArgs: [],
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
  spawn: {
    interactive: ['opencode'],
    headless: [],
    ptyRequired: true,
    extraArgs: [],
  },
};

const agyAdapter = {
  ...kimiAdapter,
  id: 'agy',
  label: 'Antigravity',
  bin: 'agy',
  install: { command: 'npm install -g @google/antigravity' },
  auth: {
    method: 'oauth',
    loginHint: 'agy login',
  },
  env: {
    passthrough: ['ANTHROPIC_API_KEY', 'AGY_API_KEY'],
  },
  models: {
    flag: '--model',
    list: ['gemini-3.6-flash-high'],
    default: 'gemini-3.6-flash-high',
  },
  spawn: {
    interactive: ['agy'],
    headless: [],
    ptyRequired: true,
    extraArgs: [],
  },
};

const credentiallessAdapter = {
  ...kimiAdapter,
  id: 'local-agent',
  label: 'Local Agent',
  bin: 'local-agent',
  auth: {
    method: 'none',
  },
  env: {
    passthrough: ['LOCAL_AGENT_OPTION'],
  },
  models: {
    flag: '--model',
    list: ['local/default'],
    default: 'local/default',
  },
  spawn: {
    interactive: ['local-agent'],
    headless: [],
    ptyRequired: true,
    extraArgs: [],
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
      : id === 'opencode'
        ? opencodeAdapter
        : id === 'agy'
          ? agyAdapter
        : id === 'local-agent'
            ? credentiallessAdapter
          : null,
  isBinResolvable: () => true,
  getAdapterResolvedBin: (id: string) =>
    id === 'claude'
      ? '/usr/local/bin/claude'
      : id === 'kimi'
        ? '/Users/test/.kimi-code/bin/kimi'
      : id === 'opencode'
        ? '/opt/homebrew/bin/opencode'
        : id === 'agy'
          ? '/opt/homebrew/bin/agy'
        : id === 'local-agent'
          ? '/usr/local/bin/local-agent'
        : null,
  resolveAdapterBinary: (id: string) =>
    id === 'claude'
      ? '/usr/local/bin/claude'
      : id === 'kimi'
        ? '/Users/test/.kimi-code/bin/kimi'
      : id === 'opencode'
        ? '/opt/homebrew/bin/opencode'
        : id === 'agy'
          ? '/opt/homebrew/bin/agy'
        : id === 'local-agent'
          ? '/usr/local/bin/local-agent'
        : null,
  rescanAdapterBinaries: vi.fn(() => []),
  listAdapters: () => [
    claudeAdapter,
    kimiAdapter,
    opencodeAdapter,
    agyAdapter,
    credentiallessAdapter,
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
  hasSecret: spawnDeps.hasSecret,
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
  refreshAgySubscriptionAuthCache: spawnDeps.refreshAgyAuth,
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
  prepareProviderSpawnAuthoritative,
  providerAuthStrategyAuthoritativeAsync,
  providerReadiness,
} from './provider-config-store';

describe('prepareProviderSpawn with a pane-pinned account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnDeps.runtimeKey.mockReturnValue('sk-global-other-account');
    spawnDeps.hasSecret.mockReturnValue(false);
    spawnDeps.launcherKey.mockReturnValue(null);
    spawnDeps.subscriptionAuthed.mockReturnValue(true);
    spawnDeps.subscriptionStatusAuthed.mockReturnValue(true);
    spawnDeps.refreshAgyAuth.mockResolvedValue({
      value: true,
      cacheUpdated: true,
    });
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

  it('spawns auth.method none without login, key injection or env suppression', () => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.resolveAuthStrategy.mockImplementation((input) =>
      input.authMethod === 'none'
        ? {
            strategy: 'credentialless',
            injectKey: false,
            suppressKeyEnv: false,
          }
        : {
            strategy: 'login-needed',
            injectKey: false,
            suppressKeyEnv: false,
          },
    );

    expect(providerReadiness('local-agent')).toEqual({
      ready: true,
      reason: 'ready',
    });
    expect(prepareProviderSpawn('local-agent')).toEqual({
      ok: true,
      overrides: {
        binPath: '/usr/local/bin/local-agent',
        defaultModel: null,
        extraArgs: [],
        keyEnv: {},
        suppressEnv: [],
      },
    });
    expect(spawnDeps.resolveAuthStrategy).toHaveBeenCalledWith(
      expect.objectContaining({ authMethod: 'none' }),
    );
  });

  it('builds provider snapshots exclusively from the non-blocking auth status path', () => {
    vi.clearAllMocks();
    listProviderSettings({ nonBlockingAuth: true });

    expect(spawnDeps.subscriptionStatusAuthed).toHaveBeenCalled();
    expect(spawnDeps.subscriptionAuthed).not.toHaveBeenCalled();
  });

  it('consumes the AGY auth proof warmed before spawn without synchronous Keychain access', () => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.subscriptionStatusAuthed.mockReturnValue(true);
    spawnDeps.resolveAuthStrategy.mockImplementation((input) =>
      input.subscriptionAuthed
        ? {
            strategy: 'subscription',
            injectKey: false,
            suppressKeyEnv: true,
          }
        : {
            strategy: 'login-needed',
            injectKey: false,
            suppressKeyEnv: false,
          },
    );

    expect(
      prepareProviderSpawn('agy', {
        model: 'gemini-3.6-flash-high',
      }),
    ).toMatchObject({
      ok: true,
      overrides: {
        binPath: '/opt/homebrew/bin/agy',
        keyEnv: {},
      },
    });
    expect(spawnDeps.subscriptionStatusAuthed).toHaveBeenCalledWith('agy');
    expect(spawnDeps.subscriptionAuthed).not.toHaveBeenCalled();
  });

  it('revalidates AGY auth asynchronously for the autonomous spawn boundary', async () => {
    spawnDeps.resolveAuthStrategy.mockImplementation((input) =>
      input.subscriptionAuthed
        ? {
            strategy: 'subscription',
            injectKey: false,
            suppressKeyEnv: true,
          }
        : {
            strategy: 'login-needed',
            injectKey: false,
            suppressKeyEnv: false,
          },
    );

    await expect(
      providerAuthStrategyAuthoritativeAsync(
        'agy',
        'gemini-3.6-flash-high',
      ),
    ).resolves.toBe('subscription');
    expect(spawnDeps.refreshAgyAuth).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      { authoritative: true },
    );
  });

  it('prepares AGY from the authoritative auth proof without decrypting the vault', async () => {
    spawnDeps.subscriptionStatusAuthed.mockReturnValue(false);
    spawnDeps.runtimeKey.mockClear();
    spawnDeps.resolveAuthStrategy.mockImplementation((input) =>
      input.subscriptionAuthed
        ? {
            strategy: 'subscription',
            injectKey: false,
            suppressKeyEnv: true,
          }
        : {
            strategy: 'login-needed',
            injectKey: false,
            suppressKeyEnv: false,
          },
    );

    await expect(
      prepareProviderSpawnAuthoritative('agy', {
        model: 'gemini-3.6-flash-high',
      }),
    ).resolves.toMatchObject({
      ok: true,
      overrides: {
        binPath: '/opt/homebrew/bin/agy',
        keyEnv: {},
      },
    });
    expect(spawnDeps.refreshAgyAuth).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      { authoritative: true },
    );
    expect(spawnDeps.runtimeKey).not.toHaveBeenCalled();
  });

  it.each(['api_key', 'subscription'] as const)(
    'keeps an authoritative AGY subscription ahead of a stale implicit %s account',
    async (mode) => {
      spawnDeps.hasSecret.mockReturnValue(true);
      spawnDeps.listAccounts.mockReturnValue([
        {
          id: `agy-stale-${mode}`,
          adapterId: 'agy',
          label: 'Stale AGY credential',
          mode,
          upstream: 'anthropic',
          createdAt: 1,
        },
      ]);
      spawnDeps.getActiveAccount.mockReturnValue({
        id: `agy-stale-${mode}`,
        adapterId: 'agy',
        label: 'Stale AGY credential',
        mode,
        upstream: 'anthropic',
        createdAt: 1,
      });

      await expect(
        prepareProviderSpawnAuthoritative('agy', {
          model: 'gemini-3.6-flash-high',
        }),
      ).resolves.toMatchObject({
        ok: true,
        overrides: {
          keyEnv: {},
          suppressEnv: ['ANTHROPIC_API_KEY', 'AGY_API_KEY'],
        },
      });
      expect(spawnDeps.getActiveAccount).not.toHaveBeenCalled();
      expect(spawnDeps.ensureSubscriptionActive).not.toHaveBeenCalled();
      expect(spawnDeps.runtimeKey).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the authoritative AGY Keychain proof is unavailable', async () => {
    spawnDeps.hasSecret.mockReturnValue(true);
    spawnDeps.refreshAgyAuth.mockRejectedValueOnce(
      new Error('simulated Keychain outage'),
    );

    await expect(
      prepareProviderSpawnAuthoritative('agy', {
        model: 'gemini-3.6-flash-high',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('sessão nativa do AGY'),
    });
    expect(spawnDeps.runtimeKey).not.toHaveBeenCalled();
  });

  it('uses the API-key fallback only after an authoritative AGY absence', async () => {
    spawnDeps.hasSecret.mockReturnValue(true);
    spawnDeps.refreshAgyAuth.mockResolvedValueOnce({
      value: false,
      cacheUpdated: false,
    });
    spawnDeps.resolveAuthStrategy.mockImplementation((input) =>
      input.subscriptionAuthed
        ? {
            strategy: 'subscription',
            injectKey: false,
            suppressKeyEnv: true,
          }
        : input.hasStoredKey
          ? {
              strategy: 'api-key',
              injectKey: true,
              suppressKeyEnv: false,
            }
          : {
              strategy: 'login-needed',
              injectKey: false,
              suppressKeyEnv: false,
            },
    );

    await expect(
      prepareProviderSpawnAuthoritative('agy', {
        model: 'gemini-3.6-flash-high',
      }),
    ).resolves.toMatchObject({
      ok: true,
      overrides: {
        keyEnv: { ANTHROPIC_API_KEY: 'sk-global-other-account' },
        suppressEnv: [],
      },
    });
    expect(spawnDeps.runtimeKey).toHaveBeenCalledWith('agy');
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

  it('preserves a non-AGY active account when native subscription auth also exists', () => {
    spawnDeps.listAccounts.mockReturnValue([
      {
        id: 'kimi-managed-key',
        adapterId: 'kimi',
        label: 'Managed Kimi key',
        mode: 'api_key',
        upstream: 'anthropic',
        createdAt: 1,
      },
    ]);
    spawnDeps.getActiveAccount.mockReturnValue({
      id: 'kimi-managed-key',
      adapterId: 'kimi',
      label: 'Managed Kimi key',
      mode: 'api_key',
      upstream: 'anthropic',
      createdAt: 1,
    });

    expect(prepareProviderSpawn('kimi')).toMatchObject({
      ok: true,
      overrides: {
        keyEnv: {
          KIMI_MODEL_API_KEY: 'sk-active-other-account',
        },
        suppressEnv: [],
      },
    });
    expect(spawnDeps.getActiveAccount).toHaveBeenCalledWith('kimi');
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
