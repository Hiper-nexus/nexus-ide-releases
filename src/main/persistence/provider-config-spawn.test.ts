import mimoRaw from '../../adapters/builtin/mimo-code.json';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { PROVIDER_CHANNELS } from '../../shared/provider-settings-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnDeps = vi.hoisted(() => ({
  resolvedClaudeBin: '/usr/local/bin/claude' as string | null,
  trustedHandlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  confirmInstall: vi.fn(async () => ({ response: 1 })),
  downloadInstaller: vi.fn(async () => ({ ok: true, text: async () => '#!/bin/bash\nexit 0\n' })),
  systemIdleTime: vi.fn(() => 0),
  rescanBinaries: vi.fn(async () => []),
  execFile: vi.fn<(...args: unknown[]) => ChildProcess>(),
  providersFile: { version: 3, providers: {
    claude: { upstream: 'glm' }, opencode: { upstream: 'glm' }, aider: { upstream: 'glm' },
  } } as { version: number; providers: Record<string, Record<string, unknown>> },
  prepareAccount: vi.fn(),
  runtimeKey: vi.fn<() => string | null>(() => 'sk-global-other-account'),
  hasSecret: vi.fn(() => false),
  hasCachedSecret: vi.fn(() => false),
  getSecret: vi.fn<() => string | null>(() => null),
  setKey: vi.fn(() => ({ ok: true })),
  getAccount: vi.fn(),
  launcherKey: vi.fn<(providerId: string) => string | null>(() => null),
  subscriptionAuthed: vi.fn<
    (adapterId: string, model?: string) => boolean
  >(() => true),
  subscriptionStatusAuthed: vi.fn<
    (adapterId: string, model?: string) => boolean
  >(() => true),
  subscriptionStatusUnknown: vi.fn(() => false),
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
  pickAvailableForFailover: vi.fn(),
  hasFailoverCredential: vi.fn((_account?: unknown) => true),
  blockedForScope: vi.fn((_accountId?: string, _now?: number) => false),
  quotaSnapshot: vi.fn<() => { entries: Array<Record<string, unknown>> } | null>(
    () => null,
  ),
  ensureSubscriptionActive: vi.fn(() => true),
  activeClaudeAuthEnv: vi.fn<() => Record<string, string> | null>(() => ({
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-active',
  })),
  verifyClaudeAccount: vi.fn<(_id: string, onVerified?: (blob: string) => void) => Promise<'match' | 'mismatch' | 'auth-expired' | 'unavailable'>>(
    async (_id, onVerified) => { onVerified?.('verified-claude-blob'); return 'match'; },
  ),
}));

vi.mock('node:os', async (importOriginal) => {
  const mock = { ...(await importOriginal<typeof import('node:os')>()), homedir: () => '/fixture-quota-home' };
  return { ...mock, default: mock };
});
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: spawnDeps.execFile,
}));
vi.mock('node:fs', async (importOriginal) => {
  const mock = {
    ...(await importOriginal<typeof import('node:fs')>()),
    readFileSync: () => JSON.stringify(spawnDeps.providersFile),
    writeFileSync: vi.fn(), mkdirSync: vi.fn(), chmodSync: vi.fn(),
  };
  return { ...mock, default: mock };
});

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
      'opencode/nemotron-3-ultra-free',
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

const qwenAdapter = {
  ...kimiAdapter,
  id: 'qwen',
  label: 'Qwen Code',
  bin: 'qwen',
  auth: {
    method: 'api_key',
    envVarFallback: 'BAILIAN_TOKEN_PLAN_API_KEY',
    loginHint: 'settings/env auth',
  },
  env: {
    passthrough: [
      'BAILIAN_TOKEN_PLAN_API_KEY',
      'DASHSCOPE_API_KEY',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
    ],
  },
};

const claudeHostAdapter = (id: string, extra: string[]) => ({
  ...kimiAdapter,
  id,
  label: id,
  bin: 'claude',
  auth: { method: 'api_key', envVarFallback: 'ANTHROPIC_AUTH_TOKEN' },
  env: { passthrough: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', ...extra] },
});

const museAdapter = {
  ...kimiAdapter,
  id: 'muse', label: 'Muse Code', bin: 'muse',
  auth: { method: 'file', loginHint: 'muse login' },
  env: { passthrough: [] },
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
  powerMonitor: { getSystemIdleTime: spawnDeps.systemIdleTime },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showMessageBox: spawnDeps.confirmInstall },
  net: { fetch: spawnDeps.downloadInstaller },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../security/trusted-ipc', async (original) => ({
  ...(await original<typeof import('../security/trusted-ipc')>()),
  handleTrusted: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
    spawnDeps.trustedHandlers.set(channel, handler);
  },
}));

vi.mock('../adapters/adapter-registry', () => ({
  isBuiltinAdapter: (id: string) => id === 'claude',
  getAdapter: (id: string) =>
    id === 'mimo-code'
      ? mimoRaw
      : id === 'claude'
      ? claudeAdapter
      : id === 'kimi'
        ? kimiAdapter
      : id === 'glm'
        ? claudeHostAdapter('glm', ['ZAI_API_KEY'])
      : id === 'deepseek'
        ? claudeHostAdapter('deepseek', ['DEEPSEEK_API_KEY'])
      : id === 'muse'
        ? museAdapter
      : id === 'opencode'
        ? opencodeAdapter
        : id === 'aider'
          ? { ...opencodeAdapter, id: 'aider', bin: 'aider' }
        : id === 'grok'
          ? { ...kimiAdapter, id: 'grok', bin: 'grok', env: { passthrough: ['XAI_API_KEY'] } }
        : id === 'agy'
          ? agyAdapter
        : id === 'qwen'
          ? qwenAdapter
        : id === 'local-agent'
            ? credentiallessAdapter
          : null,
  isBinResolvable: () => true,
  getAdapterResolvedBin: (id: string) =>
    id === 'mimo-code' ? '/usr/local/bin/mimo' : id === 'claude'
      ? spawnDeps.resolvedClaudeBin
      : id === 'kimi'
        ? '/Users/test/.kimi-code/bin/kimi'
      : id === 'muse'
        ? '/usr/local/bin/muse'
      : id === 'opencode'
        ? '/opt/homebrew/bin/opencode'
        : id === 'agy'
          ? '/opt/homebrew/bin/agy'
        : id === 'local-agent'
          ? '/usr/local/bin/local-agent'
        : null,
  resolveAdapterBinary: (id: string) =>
    id === 'mimo-code' ? '/usr/local/bin/mimo' : id === 'claude'
      ? spawnDeps.resolvedClaudeBin
      : id === 'kimi'
        ? '/Users/test/.kimi-code/bin/kimi'
      : id === 'muse'
        ? '/usr/local/bin/muse'
      : id === 'opencode'
        ? '/opt/homebrew/bin/opencode'
        : id === 'agy'
          ? '/opt/homebrew/bin/agy'
        : id === 'local-agent'
          ? '/usr/local/bin/local-agent'
        : null,
  rescanAdapterBinaries: spawnDeps.rescanBinaries,
  listAdapters: () => [
    claudeAdapter,
    mimoRaw,
    kimiAdapter,
    museAdapter,
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
  realUserHome: () => '/fixture-quota-home',
  revalidateExecutable: (binPath: string) =>
    typeof binPath === 'string' &&
    (binPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(binPath)),
  resolveCliBinary: (runner: string) =>
    runner === '/usr/local/bin/claude'
      ? { binPath: runner }
      : runner === 'npm'
      ? { binPath: 'C:\\Program Files\\nodejs\\npm.cmd' }
      : runner === 'bash'
      ? { binPath: '/bin/bash' }
      : null,
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

vi.mock('./secrets-store', async importOriginal => ({
  ...await importOriginal<typeof import('./secrets-store')>(),
  getKey: spawnDeps.runtimeKey,
  hasCachedSecret: spawnDeps.hasCachedSecret,
  getSecret: spawnDeps.getSecret,
  hasSecret: spawnDeps.hasSecret,
  isSecureStorageAvailable: () => true,
  maskedKey: () => null,
  setKey: spawnDeps.setKey,
  listSecretKeys: () => [],
  setSecret: vi.fn(() => ({ ok: true })),
  vaultState: () => 'unknown',
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
  subscriptionAuthStatusIsUnknown: spawnDeps.subscriptionStatusUnknown,
  refreshAgySubscriptionAuthCache: spawnDeps.refreshAgyAuth,
  refreshClaudeSubscriptionAuthCache: vi.fn(async () => ({
    value: true,
    cacheUpdated: false,
  })),
  refreshOpenClaudeSubscriptionAuthCache: vi.fn(async () => ({
    value: true,
    cacheUpdated: false,
  })),
  resolveAuthStrategy: spawnDeps.resolveAuthStrategy,
}));

vi.mock('./account-store', () => ({
  activeClaudeAuthEnv: spawnDeps.activeClaudeAuthEnv,
  accountKey: () => 'sk-active-other-account',
  agyKeyringSlotAccount: () => agyActivation.slotOwner(),
  fileSubscriptionAuthEnv: () => ({ GEMINI_CLI_HOME: '/managed/agy-slot' }),
  ensureSubscriptionActive: spawnDeps.ensureSubscriptionActive,
  getActiveAccount: spawnDeps.getActiveAccount,
  getAccount: spawnDeps.getAccount,
  listAccounts: spawnDeps.listAccounts,
  pickAvailableForFailover: spawnDeps.pickAvailableForFailover,
  accountHasFailoverCredential: spawnDeps.hasFailoverCredential,
  isAccountBlockedForScope: spawnDeps.blockedForScope,
  prepareAccountForSpawn: spawnDeps.prepareAccount,
  verifyManagedClaudeAccountForSpawn: spawnDeps.verifyClaudeAccount,
}));

vi.mock('../quota/quota-service', () => ({
  requireQuotaService: () => ({ lastSnapshot: spawnDeps.quotaSnapshot }),
}));

const agyActivation = vi.hoisted(() => ({
  activate: vi.fn(async (_accountId: string) => ({ ok: true as const, switched: false })),
  slotOwner: vi.fn((): unknown => null),
}));
vi.mock('./agy-keyring-activation', () => ({
  activateAgyAccountForSpawn: agyActivation.activate,
}));

const qwenSettingsProbe = vi.hoisted(() => ({
  hasCredential: vi.fn<() => boolean>(() => false),
}));
vi.mock('../adapters/qwen-settings', () => ({
  qwenSettingsHasCredential: qwenSettingsProbe.hasCredential,
}));

import {
  acquireCliSpawnPermit,
  startCliAutoUpdate,
  effectiveDefaultModel,
  listProviderSettings,
  prepareProviderSpawn,
  prepareProviderSpawnAuthoritative,
  providerAuthStrategyAuthoritativeAsync,
  providerAuthStrategy,
  providerReadiness,
  initializeProviderConfigStore,
  registerProviderIpc,
  resolveRunnerPath,
  resolveQuotaApiKey,
  resolveRuntimeApiKey,
  hasRuntimeKey,
} from './provider-config-store';
import { fetchLiveProviderWindows } from '../quota/provider-live-usage';

describe('background CLI maintenance during pane startup', () => {
  let stop: (() => void) | undefined;
  let finishUpdate: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    spawnDeps.systemIdleTime.mockReturnValue(120);
    spawnDeps.rescanBinaries.mockReset().mockResolvedValue([]);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ enabled: true, checkedAt: {} }));
    vi.spyOn(fs, 'realpathSync').mockReturnValue('/fixture-quota-home/.local/share/claude/versions/1');
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    finishUpdate = undefined;
    spawnDeps.execFile.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const callback = args.at(-1) as (error: null, stdout: string) => void;
      if (argv[0] === 'update') finishUpdate = () => callback(null, '');
      else callback(null, '1.0.0');
      return {} as ChildProcess;
    });
  });

  afterEach(async () => {
    stop?.();
    finishUpdate?.();
    await vi.advanceTimersByTimeAsync(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('leaves launchers available while the operator is active, then updates when idle', async () => {
    spawnDeps.systemIdleTime.mockReturnValue(0);
    stop = startCliAutoUpdate('/fixture-quota-home', () => false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeUndefined();
    const release = await acquireCliSpawnPermit('claude');
    release();

    spawnDeps.systemIdleTime.mockReturnValue(120);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeTypeOf('function');
  });

  it.each(['discovery', 'version'])('defers installation if the operator returns during %s', async (phase) => {
    if (phase === 'discovery') {
      spawnDeps.rescanBinaries.mockImplementationOnce(async () => {
        spawnDeps.systemIdleTime.mockReturnValue(0);
        return [];
      });
    } else {
      spawnDeps.execFile.mockImplementationOnce((...args: unknown[]) => {
        spawnDeps.systemIdleTime.mockReturnValue(0);
        (args.at(-1) as (error: null, stdout: string) => void)(null, '1.0.0');
        return {} as ChildProcess;
      });
    }
    stop = startCliAutoUpdate('/fixture-quota-home', () => false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeUndefined();
  });

  it('releases a waiting pane after updating its launcher without awaiting unrelated CLI discovery', async () => {
    let finishDiscovery!: () => void;
    spawnDeps.rescanBinaries.mockResolvedValueOnce([]).mockImplementationOnce(() =>
      new Promise<never[]>((resolve) => { finishDiscovery = () => resolve([]); }),
    );
    stop = startCliAutoUpdate('/fixture-quota-home', () => false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeTypeOf('function');
    let release: (() => void) | undefined;
    const pending = acquireCliSpawnPermit('claude').then((permit) => { release = permit; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toBeUndefined(); // The installer must still exclude spawns.
      finishUpdate!();
      await vi.advanceTimersByTimeAsync(0);
      expect(finishDiscovery).toBeTypeOf('function');
      expect(release).toBeTypeOf('function');
    } finally {
      finishDiscovery?.();
      await pending;
      release?.();
    }
  });
});

describe('prepareProviderSpawn with a pane-pinned account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnDeps.runtimeKey.mockReturnValue('sk-global-other-account');
    spawnDeps.getSecret.mockReturnValue(null);
    spawnDeps.hasSecret.mockReturnValue(false);
    spawnDeps.launcherKey.mockReturnValue(null);
    spawnDeps.subscriptionAuthed.mockReturnValue(true);
    spawnDeps.subscriptionStatusAuthed.mockReturnValue(true);
    spawnDeps.subscriptionStatusUnknown.mockReturnValue(false);
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
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account: null });
    spawnDeps.hasFailoverCredential.mockReturnValue(true);
    spawnDeps.blockedForScope.mockReturnValue(false);
    spawnDeps.quotaSnapshot.mockReturnValue(null);
    spawnDeps.ensureSubscriptionActive.mockReturnValue(true);
    spawnDeps.activeClaudeAuthEnv.mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-active',
    });
  });

  it('keeps MiMo Token Plan readiness model-aware through the public provider settings', () => {
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.hasSecret.mockReturnValue(false);
    spawnDeps.subscriptionAuthed.mockImplementation((adapterId, model) => adapterId === 'mimo-code' && !model?.endsWith('ultraspeed'));
    spawnDeps.resolveAuthStrategy.mockImplementation(input => ({ strategy: input.subscriptionAuthed ? 'subscription' : 'login-needed', injectKey:false, suppressKeyEnv:true }));
    const provider = listProviderSettings().find(p => p.adapterId === 'mimo-code');
    expect(provider?.authReadyModels).toContain('xiaomi/mimo-v2.6-pro');
    expect(provider?.authReadyModels).toContain('xiaomi/mimo-v2.6-flash');
    expect(provider?.authReadyModels).not.toContain('xiaomi/mimo-v2.6-pro-ultraspeed');
  });

  it('checks the effective MiMo default when no model override was provided', () => {
    const original = mimoRaw.models.default;
    mimoRaw.models.default = 'xiaomi/mimo-v2.6-pro-ultraspeed';
    spawnDeps.subscriptionAuthed.mockImplementation((_id, model) => !model?.endsWith('ultraspeed'));
    spawnDeps.resolveAuthStrategy.mockImplementation(input => ({ strategy: input.subscriptionAuthed ? 'subscription' : 'login-needed', injectKey:false, suppressKeyEnv:true }));
    try {
      expect(providerAuthStrategy('mimo-code')).toBe('login-needed');
      expect(spawnDeps.subscriptionAuthed).toHaveBeenCalledWith('mimo-code', 'xiaomi/mimo-v2.6-pro-ultraspeed');
    } finally {
      mimoRaw.models.default = original;
    }
  });

  it.each(['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-pro-ultraspeed'])('enforces the exact saved MiMo Token Plan when spawning %s', (model) => {
    const account = { id:'mimo-plan', adapterId:'mimo-code', label:'Plan', mode:'subscription', createdAt:1 };
    spawnDeps.prepareAccount.mockReturnValueOnce({ ok:true, account, authEnv:{MIMOCODE_HOME:'/private/mimo-plan'} });
    spawnDeps.getSecret.mockReturnValue(JSON.stringify({xiaomi:{type:'api',key:'tp-fixture',metadata:{uid:'a',base_url:'https://token-plan-sgp.xiaomimimo.com/v1'}}}));
    const result = prepareProviderSpawn('mimo-code', { accountId:account.id, model });
    expect(result.ok).toBe(!model.endsWith('ultraspeed'));
    if (result.ok) expect(result.overrides.keyEnv).toEqual({MIMOCODE_HOME:'/private/mimo-plan'});
    else expect(result.error).toContain('UltraSpeed');
  });

  it('keeps unverified display state separate from the fail-closed spawn strategy', () => {
    spawnDeps.subscriptionStatusAuthed.mockReturnValue(false);
    spawnDeps.subscriptionStatusUnknown.mockReturnValue(true);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'login-needed', injectKey: false, suppressKeyEnv: false,
    });
    expect(listProviderSettings({ nonBlockingAuth: true }).find((p) => p.adapterId === 'claude'))
      .toMatchObject({ authStrategy: 'login-needed', authState: 'unknown' });
    spawnDeps.subscriptionStatusUnknown.mockReturnValue(false);
    expect(listProviderSettings({ nonBlockingAuth: true }).find((p) => p.adapterId === 'claude'))
      .toMatchObject({ authStrategy: 'login-needed', authState: 'missing' });
  });

  it('lets an explicitly chosen Muse try its native Keychain without claiming authenticated or injecting credentials', () => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.subscriptionStatusAuthed.mockReturnValue(false);
    spawnDeps.subscriptionStatusUnknown.mockReturnValue(true);
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'login-needed', injectKey: false, suppressKeyEnv: false,
    });
    spawnDeps.listAccounts.mockReturnValue([{ id: 'old-account' }]);

    expect(prepareProviderSpawn('muse', { allowNativeAuthAttempt: true, isolatedHome: false }))
      .toMatchObject({ ok: true, overrides: { binPath: '/usr/local/bin/muse', keyEnv: {}, suppressEnv: [] } });
    expect(spawnDeps.pickAvailableForFailover).not.toHaveBeenCalled();
    expect(spawnDeps.ensureSubscriptionActive).not.toHaveBeenCalled();
    expect(listProviderSettings({ nonBlockingAuth: true }).find((p) => p.adapterId === 'muse'))
      .toMatchObject({ authState: 'unknown', authStrategy: 'login-needed' });
    expect(providerReadiness('muse').ready).toBe(false);
  });

  it.each([
    ['muse', false, false, true],
    ['muse', true, true, true],
    ['muse', true, false, false],
    ['kimi', true, false, true],
  ])('keeps native-auth attempts bounded: %s explicit=%s isolated=%s unknown=%s', (id, explicit, isolated, unknown) => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.subscriptionStatusUnknown.mockReturnValue(unknown);
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'login-needed', injectKey: false, suppressKeyEnv: false,
    });
    expect(prepareProviderSpawn(id, { allowNativeAuthAttempt: explicit, isolatedHome: isolated }).ok).toBe(false);
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
        model: 'opencode/nemotron-3-ultra-free',
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
        accountChoice: expect.objectContaining({ source: 'legacy' }),
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

  it('uses the selected managed Claude account without falling back to the native login', () => {
    const account = { id: 'acct-b', adapterId: 'claude', label: 'Conta B', mode: 'subscription', upstream: 'anthropic', createdAt: 1 };
    spawnDeps.listAccounts.mockReturnValue([account]);
    spawnDeps.getActiveAccount.mockReturnValue(account);
    spawnDeps.getAccount.mockReturnValue(account);
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account });
    spawnDeps.prepareAccount.mockReturnValueOnce({ ok: true, account,
      authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/accounts/claude/b' } });

    expect(prepareProviderSpawn('claude')).toMatchObject({
      ok: true, overrides: { selectedAccountId: 'acct-b',
        keyEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/accounts/claude/b' },
      },
    });
    expect(spawnDeps.prepareAccount).toHaveBeenCalledWith('claude', 'acct-b', undefined, { isolatedHome: false });
    expect(spawnDeps.activeClaudeAuthEnv).not.toHaveBeenCalled();
  });

  describe('F-235: exclusão de contas com pane Claude vivo na missão', () => {
    const acctA = { id: 'acct-a', adapterId: 'claude', label: 'Conta A',
      mode: 'subscription', upstream: 'anthropic', email: 'a@example.com', createdAt: 1 };
    const acctB = { id: 'acct-b', adapterId: 'claude', label: 'Conta B',
      mode: 'subscription', upstream: 'anthropic', email: 'b@example.com', createdAt: 2 };

    beforeEach(() => {
      spawnDeps.listAccounts.mockReturnValue([acctA, acctB]);
      spawnDeps.getActiveAccount.mockReturnValue(acctA);
      spawnDeps.getAccount.mockImplementation((id: string) =>
        [acctA, acctB].find((a) => a.id === id) ?? null);
    });

    it('excluindo a conta A entre A+B com credencial, a escolha cai em B', async () => {
      // O pick honra excludeIds (F-676) — o mock espelha a filtragem real.
      spawnDeps.pickAvailableForFailover.mockImplementation(
        (_adapterId: string, _excludeId: string | null, _now: number,
          _scores: unknown, options?: { excludeIds?: ReadonlySet<string> }) => ({
          account: [acctA, acctB].find((a) => !options?.excludeIds?.has(a.id)) ?? null,
        }));
      spawnDeps.prepareAccount.mockReturnValue({ ok: true, account: acctB,
        authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/accounts/claude/b' } });

      await expect(prepareProviderSpawnAuthoritative('claude', {
        excludeAccountIds: ['acct-a'],
      })).resolves.toMatchObject({
        ok: true,
        overrides: { selectedAccountId: 'acct-b' },
      });
      expect(spawnDeps.pickAvailableForFailover).toHaveBeenCalledWith(
        'claude', null, expect.any(Number), undefined,
        { excludeIds: new Set(['acct-a']) },
      );
    });

    it('excluindo A e B, o spawn falha com claude_accounts_in_use — nunca active-fallback', async () => {
      spawnDeps.pickAvailableForFailover.mockReturnValue({ account: null });

      await expect(prepareProviderSpawnAuthoritative('claude', {
        excludeAccountIds: ['acct-a', 'acct-b'],
      })).resolves.toEqual({
        ok: false,
        error: expect.stringContaining('claude_accounts_in_use'),
      });
      // Sem fallback para a conta ativa: dois panes nunca dividem uma conta.
      expect(spawnDeps.prepareAccount).not.toHaveBeenCalled();
    });

    it('sem excludeAccountIds a conta ativa permanece (comportamento atual)', () => {
      spawnDeps.pickAvailableForFailover.mockReturnValue({ account: acctA });
      spawnDeps.prepareAccount.mockReturnValue({ ok: true, account: acctA,
        authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/accounts/claude/a' } });

      expect(prepareProviderSpawn('claude')).toMatchObject({
        ok: true, overrides: { selectedAccountId: 'acct-a' },
      });
      expect(spawnDeps.pickAvailableForFailover).toHaveBeenCalledWith(
        'claude', null, expect.any(Number), undefined,
      );
    });
  });

  it('refuses to launch a Claude pane when its scoped credential belongs to another account', async () => {
    const account = { id: 'acct-b', adapterId: 'claude', label: 'Conta B',
      mode: 'subscription', upstream: 'anthropic', email: 'b@example.com', createdAt: 1 };
    spawnDeps.listAccounts.mockReturnValue([account]);
    spawnDeps.getActiveAccount.mockReturnValue(account);
    spawnDeps.getAccount.mockReturnValue(account);
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account });
    spawnDeps.prepareAccount.mockReturnValue({ ok: true, account,
      authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/accounts/claude/b' } });
    spawnDeps.verifyClaudeAccount.mockResolvedValueOnce('mismatch');
    await expect(prepareProviderSpawnAuthoritative('claude', { accountId: account.id }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('outra conta Claude') });
    expect(spawnDeps.prepareAccount).not.toHaveBeenCalled();
  });

  it('checks the automatically selected Claude account before preparing its credential', async () => {
    const account = { id: 'acct-auto', adapterId: 'claude', label: 'Conta Auto',
      mode: 'subscription', upstream: 'anthropic', email: 'auto@example.com', createdAt: 1 };
    spawnDeps.listAccounts.mockReturnValue([account]);
    spawnDeps.getActiveAccount.mockReturnValue(account);
    spawnDeps.getAccount.mockReturnValue(account);
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account });
    spawnDeps.verifyClaudeAccount.mockResolvedValueOnce('mismatch');

    await expect(prepareProviderSpawnAuthoritative('claude'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('outra conta Claude') });
    expect(spawnDeps.prepareAccount).not.toHaveBeenCalled();
  });

  it('accepts the same Claude account after a verified refresh replaces its metadata object', async () => {
    const account = { id: 'acct-b', adapterId: 'claude', label: 'Conta B',
      mode: 'subscription', upstream: 'anthropic', email: 'b@example.com', createdAt: 1 };
    spawnDeps.listAccounts.mockReturnValue([account]);
    spawnDeps.getAccount.mockReturnValueOnce(account).mockReturnValueOnce({ ...account, lastError: 'credential refreshed' });
    spawnDeps.prepareAccount.mockReturnValue({ ok: true, account,
      authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/accounts/claude/b' } });

    await expect(prepareProviderSpawnAuthoritative('claude', { accountId: account.id }))
      .resolves.toMatchObject({ ok: true });
    expect(spawnDeps.prepareAccount).toHaveBeenCalledOnce();
  });

  it('fails visibly when the selected Claude account cannot be prepared instead of opening another login', () => {
    const account = { id: 'acct-b', adapterId: 'claude', label: 'Conta B', mode: 'subscription', upstream: 'anthropic', createdAt: 1 };
    spawnDeps.listAccounts.mockReturnValue([account]);
    spawnDeps.getActiveAccount.mockReturnValue(account);
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account });
    spawnDeps.prepareAccount.mockReturnValueOnce({ ok: false, error: 'Conta B precisa de login' });
    expect(prepareProviderSpawn('claude')).toEqual({ ok: false, error: 'Conta B precisa de login' });
    expect(spawnDeps.activeClaudeAuthEnv).not.toHaveBeenCalled();
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
        accountChoice: expect.objectContaining({ source: 'legacy' }),
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

  it('conta AGY de assinatura vai para a vaga do keyring antes do spawn (F-677)', async () => {
    const account = {
      id: 'agy-b', adapterId: 'agy', label: 'AGY B', mode: 'subscription' as const,
      upstream: 'agy', createdAt: 2,
    };
    spawnDeps.getAccount.mockReturnValue(account);
    spawnDeps.prepareAccount.mockReturnValue({ ok: true, account, apiKey: null, authEnv: {} });
    agyActivation.activate.mockClear();
    const ok = await prepareProviderSpawnAuthoritative('agy', { accountId: 'agy-b' });
    expect(ok).toMatchObject({ ok: true });
    expect(agyActivation.activate).toHaveBeenCalledWith('agy-b');

    agyActivation.activate.mockResolvedValueOnce({ ok: false, error: 'vaga recusada' } as never);
    await expect(prepareProviderSpawnAuthoritative('agy', { accountId: 'agy-b' }))
      .resolves.toEqual({ ok: false, error: 'vaga recusada' });

    // Conta por chave de API não mexe na vaga.
    const apiKey = { ...account, id: 'agy-key', mode: 'api-key' as const };
    spawnDeps.getAccount.mockReturnValue(apiKey);
    spawnDeps.prepareAccount.mockReturnValue({ ok: true, account: apiKey, apiKey: 'k', authEnv: {} });
    agyActivation.activate.mockClear();
    await prepareProviderSpawnAuthoritative('agy', { accountId: 'agy-key' });
    expect(agyActivation.activate).not.toHaveBeenCalled();
  });

  it('Windows: pane AGY sem conta fixada nasce na dona da vaga; se ela esgotou, na irmã (F-677)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      spawnDeps.hasSecret.mockReturnValue(true);
      const owner = {
        id: 'agy-slot', adapterId: 'agy', label: 'Vaga', mode: 'subscription' as const,
        upstream: 'agy', createdAt: 1,
      };
      spawnDeps.listAccounts.mockReturnValue([owner]);
      spawnDeps.getAccount.mockReturnValue(owner);
      agyActivation.slotOwner.mockReturnValue(owner);
      spawnDeps.blockedForScope.mockReturnValue(false);
      const free = await prepareProviderSpawnAuthoritative('agy', { model: 'gemini-3.6-flash-high' });
      expect(free.ok ? null : free.error).toBeNull();
      expect(free).toMatchObject({ ok: true, overrides: { selectedAccountId: 'agy-slot', accountChoice: { source: 'native' } } });

      spawnDeps.blockedForScope.mockReturnValue(true);
      spawnDeps.pickAvailableForFailover.mockReturnValue({ account: null, probe: false });
      const exhausted = await prepareProviderSpawnAuthoritative('agy', { model: 'gemini-3.6-flash-high' });
      expect(exhausted).toMatchObject({ ok: true });
      expect((exhausted as { overrides: { accountChoice: { source: string } } }).overrides.accountChoice.source)
        .not.toBe('native');
    } finally {
      Object.defineProperty(process, 'platform', platform);
      agyActivation.slotOwner.mockReturnValue(null);
    }
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
        selectedAccountId: 'acct-selected',
        suppressEnv: [],
        accountChoice: expect.objectContaining({
          source: 'pinned',
          account: { label: 'Se•••ed', mode: 'api_key' },
        }),
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
        selectedAccountId: 'acct-max',
        suppressEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
        accountChoice: expect.objectContaining({
          source: 'pinned',
          account: { label: 'Cl•••ax', mode: 'subscription' },
        }),
      },
    });
  });
});

describe('Windows install runner resolution', () => {
  it('returns the absolute npm.cmd shim instead of the bare npm name', () => {
    expect(resolveRunnerPath('npm')).toBe('C:\\Program Files\\nodejs\\npm.cmd');
  });
});

describe('G3 — pane sem conta pinada nasce na conta com folga', () => {
  const kimiAccount = (id: string, label: string, createdAt: number) => ({
    id,
    adapterId: 'kimi',
    label,
    mode: 'api_key',
    upstream: 'anthropic',
    createdAt,
  });

  it('usa a irmã mais livre indicada pelo snapshot de quota no lugar da ativa', () => {
    spawnDeps.listAccounts.mockReturnValue([
      kimiAccount('kimi-a', 'Conta A', 1),
      kimiAccount('kimi-b', 'Conta B', 2),
    ]);
    spawnDeps.getActiveAccount.mockReturnValue(kimiAccount('kimi-a', 'Conta A', 1));
    spawnDeps.quotaSnapshot.mockReturnValue({
      entries: [
        {
          adapterId: 'kimi',
          accountId: 'kimi-a',
          windows: [{ usedRatio: 0.98 }],
        },
        {
          adapterId: 'kimi',
          accountId: 'kimi-b',
          windows: [{ usedRatio: 0.1 }],
        },
      ],
    } as never);
    // O pick real (chooseAccount + blocos) devolveria a irmã; aqui provamos o
    // contrato do spawn: o que o pick devolve é o que o pane usa.
    spawnDeps.pickAvailableForFailover.mockImplementation(
      (_adapter: string, exclude: string | null, _now: number, scores?: Map<string, number>) => {
        const freer =
          scores && (scores.get('kimi-b') ?? 0) > (scores.get('kimi-a') ?? 0)
            ? kimiAccount('kimi-b', 'Conta B', 2)
            : null;
        return { account: freer ?? (exclude ? null : kimiAccount('kimi-a', 'Conta A', 1)) };
      },
    );

    const result = prepareProviderSpawn('kimi');

    // api_key path: keyEnv vem do vault da conta escolhida (accountKey mock).
    expect(result).toMatchObject({ ok: true });
    expect(spawnDeps.pickAvailableForFailover).toHaveBeenCalledWith(
      'kimi',
      null,
      expect.any(Number),
      expect.any(Map),
    );
    const scores = spawnDeps.pickAvailableForFailover.mock.calls[0]?.[3] as Map<
      string,
      number
    >;
    expect(scores.get('kimi-b')).toBeGreaterThan(scores.get('kimi-a') ?? 0);
  });

  it('quota fora do ar abre na ativa e nunca bloqueia o spawn', () => {
    spawnDeps.quotaSnapshot.mockImplementation(() => {
      throw new Error('quota service not initialized');
    });
    spawnDeps.listAccounts.mockReturnValue([kimiAccount('kimi-a', 'Conta A', 1)]);
    spawnDeps.getActiveAccount.mockReturnValue(kimiAccount('kimi-a', 'Conta A', 1));
    spawnDeps.pickAvailableForFailover.mockReturnValue({
      account: kimiAccount('kimi-a', 'Conta A', 1),
    });

    expect(prepareProviderSpawn('kimi')).toMatchObject({ ok: true });
  });

  it('nada livre com credencial cai no caminho legado sem recusar o pane', () => {
    spawnDeps.listAccounts.mockReturnValue([
      kimiAccount('kimi-a', 'Conta A', 1),
      kimiAccount('kimi-b', 'Conta B', 2),
    ]);
    spawnDeps.getActiveAccount.mockReturnValue(null);
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account: null });

    // Sem conta e sem pick: o store resolve pelo providers.conf (runtimeKey).
    expect(prepareProviderSpawn('kimi')).toMatchObject({ ok: true });
  });
});

describe('default salvo aposentado do OpenCode (atualização com config antiga)', () => {
  it('migra o default salvo antes da checagem de credencial — sem login continua pronto', async () => {
    vi.clearAllMocks();
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.subscriptionStatusAuthed.mockReturnValue(false);
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.hasSecret.mockReturnValue(false);
    spawnDeps.listAccounts.mockReturnValue([]);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'login-needed', injectKey: false, suppressKeyEnv: false,
    });
    const previous = spawnDeps.providersFile;
    spawnDeps.providersFile = { version: 3, providers: {
      opencode: { defaultModel: 'opencode/deepseek-v4-flash-free' },
    } };
    try {
      vi.resetModules();
      const store = await import('./provider-config-store');
      store.initializeProviderConfigStore();
      expect(store.providerReadiness('opencode')).toEqual({ ready: true, reason: 'ready' });
      expect(store.prepareProviderSpawn('opencode', {})).toMatchObject({
        ok: true,
        overrides: { defaultModel: 'opencode/big-pickle', keyEnv: {} },
      });
    } finally {
      spawnDeps.providersFile = previous;
      vi.resetModules();
    }
  });
});

describe('G9 — modelo salvo desconhecido não desce para o pane', () => {
  it('default salvo fora da lista viva cai no default do adapter no spawn', () => {
    spawnDeps.hasSecret.mockReturnValue(true);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'api_key',
      injectKey: true,
      suppressKeyEnv: false,
    });

    // Sem providers.json configurado o cfg.defaultModel vem vazio; o contrato
    // relevante aqui é o helper puro: slug morto → default do adapter.
    const known = ['gemini-3.7-flash-high', 'gemini-3.6-flash-low'];
    expect(
      effectiveDefaultModel('agy', 'gemini-9-turbo', known, 'gemini-3.7-flash-high'),
    ).toBe('gemini-3.7-flash-high');
    expect(
      effectiveDefaultModel('agy', 'gemini-3.6-flash-low', known, 'gemini-3.7-flash-high'),
    ).toBe('gemini-3.6-flash-low');
    expect(
      effectiveDefaultModel('agy', '', known, 'gemini-3.7-flash-high'),
    ).toBe('gemini-3.7-flash-high');
  });
});

describe('main-owned quota credential resolution', () => {
  beforeAll(() => initializeProviderConfigStore());
  beforeEach(() => {
    vi.clearAllMocks();
    spawnDeps.getAccount.mockReturnValue(null);
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.getSecret.mockReturnValue(null);
    spawnDeps.hasSecret.mockReturnValue(false);
    spawnDeps.hasCachedSecret.mockReturnValue(false);
    spawnDeps.launcherKey.mockImplementation((id) => id === 'glm' ? 'fixture-glm-owned-opaque' : null);
    spawnDeps.resolveAuthStrategy.mockReturnValue({ strategy: 'api-key', injectKey: true, suppressKeyEnv: false });
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fixture-longcat-owned-opaque');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.longcat.chat/anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['claude', 'aider', 'opencode'])('resolves the configured %s→GLM launcher key before unrelated environment keys', (adapterId) => {
    expect(resolveQuotaApiKey({ adapterId, usageProviderId: 'glm', authMode: 'api-key' }))
      .toBe('fixture-glm-owned-opaque');
  });

  it.each(['claude', 'aider', 'opencode'])('sends only the canonical %s→GLM credential through the live quota path', async (adapterId) => {
    const requests: Array<{ host: string; usesOwnedKey: boolean }> = [];
    await fetchLiveProviderWindows(adapterId, undefined, {
      resolveApiQuotaKey: resolveQuotaApiKey,
      fetchImpl: async (url, init) => {
        requests.push({ host: new URL(url).hostname, usesOwnedKey: init?.headers?.Authorization === 'fixture-glm-owned-opaque' });
        return { ok: false, status: 403, json: async () => ({}), text: async () => '' };
      },
    }, 100, 'glm', 'api-key');
    expect(requests).toEqual([{ host: 'api.z.ai', usesOwnedKey: true }]);
  });

  it('rejects an ambiguous generic environment credential when no configured upstream key exists', () => {
    spawnDeps.launcherKey.mockReturnValue(null);
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-longcat-owned-opaque');
    expect(resolveQuotaApiKey({ adapterId: 'claude', usageProviderId: 'glm', authMode: 'api-key' })).toBeNull();
  });

  it('does not fall past an encrypted owner key that is still cold', () => {
    spawnDeps.hasSecret.mockReturnValue(true);
    expect(resolveQuotaApiKey({ adapterId: 'claude', usageProviderId: 'glm', authMode: 'api-key' })).toBeNull();
    expect(spawnDeps.runtimeKey.mock.calls.length).toBe(0);
  });

  it('rejects a stale destination or auth mode instead of retargeting a credential', () => {
    expect(resolveQuotaApiKey({ adapterId: 'claude', usageProviderId: 'longcat', authMode: 'api-key' })).toBeNull();
    expect(resolveQuotaApiKey({ adapterId: 'claude', usageProviderId: 'glm', authMode: 'subscription' })).toBeNull();
  });

  it('does not fall back to the global upstream for a missing pinned key', () => {
    spawnDeps.getAccount.mockReturnValue({ id: 'saved', adapterId: 'claude', mode: 'api-key', upstream: 'glm' });
    expect(resolveQuotaApiKey({ adapterId: 'claude', accountId: 'saved', usageProviderId: 'glm', authMode: 'api-key' })).toBeNull();
    expect(spawnDeps.launcherKey.mock.calls.length).toBe(0);
  });

  it('reads only the exact pinned key after validating owner and upstream', () => {
    spawnDeps.getAccount.mockReturnValue({ id: 'saved', adapterId: 'claude', mode: 'api-key', upstream: 'glm' });
    spawnDeps.hasCachedSecret.mockReturnValue(true);
    spawnDeps.getSecret.mockReturnValue('fixture-pinned-owned-key');
    expect(resolveQuotaApiKey({ adapterId: 'claude', accountId: 'saved', usageProviderId: 'glm', authMode: 'api-key' }))
      .toBe('fixture-pinned-owned-key');
    expect(spawnDeps.getSecret).toHaveBeenCalledWith('acctkey:saved');
    expect(spawnDeps.launcherKey.mock.calls.length).toBe(0);
    expect(resolveQuotaApiKey({ adapterId: 'grok', accountId: 'saved', usageProviderId: 'glm', authMode: 'api-key' })).toBeNull();
  });

  it('rejects an incompatible routed account and an absent adapter before reading its key', () => {
    spawnDeps.getAccount.mockReturnValue({ id: 'saved', adapterId: 'grok', mode: 'api-key', upstream: 'longcat' });
    expect(resolveQuotaApiKey({ adapterId: 'grok', accountId: 'saved', usageProviderId: 'grok', authMode: 'api-key' })).toBeNull();
    expect(resolveQuotaApiKey({ adapterId: 'missing', accountId: 'saved', usageProviderId: 'longcat', authMode: 'api-key' })).toBeNull();
    expect(spawnDeps.getSecret.mock.calls.length).toBe(0);
  });
});

describe('generic Anthropic env token is host-gated (F-236 rework)', () => {
  beforeAll(() => initializeProviderConfigStore());
  beforeEach(() => {
    vi.clearAllMocks();
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.hasSecret.mockReturnValue(false);
    spawnDeps.hasCachedSecret.mockReturnValue(false);
    spawnDeps.launcherKey.mockReturnValue(null);
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    vi.stubEnv('ZAI_API_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('LONGCAT_API_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('glm rejects a bare ANTHROPIC_AUTH_TOKEN without ANTHROPIC_BASE_URL', () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fixture-generic-token');
    expect(resolveRuntimeApiKey('glm')).toBeNull();
  });

  it('glm accepts ANTHROPIC_AUTH_TOKEN when BASE_URL points at api.z.ai', () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fixture-zai-token');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic');
    expect(resolveRuntimeApiKey('glm')).toBe('fixture-zai-token');
  });

  it('deepseek falls through a foreign ANTHROPIC_AUTH_TOKEN to DEEPSEEK_API_KEY', () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fixture-generic-token');
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-deepseek-key');
    expect(resolveRuntimeApiKey('deepseek')).toBe('fixture-deepseek-key');
  });

  it('deepseek rejects a z.ai-scoped ANTHROPIC_AUTH_TOKEN', () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fixture-zai-token');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic');
    expect(resolveRuntimeApiKey('deepseek')).toBeNull();
  });

  it('claude still accepts a bare ANTHROPIC_API_KEY (native host, no gate)', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-claude-key');
    expect(resolveRuntimeApiKey('claude')).toBe('fixture-claude-key');
  });
});

describe('generic OpenAI env key is host-gated for qwen (F-238)', () => {
  beforeAll(() => initializeProviderConfigStore());
  beforeEach(() => {
    vi.clearAllMocks();
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.hasSecret.mockReturnValue(false);
    spawnDeps.hasCachedSecret.mockReturnValue(false);
    spawnDeps.launcherKey.mockReturnValue(null);
    qwenSettingsProbe.hasCredential.mockReturnValue(false);
    vi.stubEnv('BAILIAN_TOKEN_PLAN_API_KEY', '');
    vi.stubEnv('DASHSCOPE_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_BASE_URL', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('qwen rejects a bare OPENAI_API_KEY without OPENAI_BASE_URL', () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-openai-key');
    expect(resolveRuntimeApiKey('qwen')).toBeNull();
  });

  it('qwen rejects OPENAI_API_KEY pointed at api.openai.com', () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-openai-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1');
    expect(resolveRuntimeApiKey('qwen')).toBeNull();
  });

  it('qwen accepts OPENAI_API_KEY when OPENAI_BASE_URL is *.aliyuncs.com', () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-bailian-key');
    vi.stubEnv(
      'OPENAI_BASE_URL',
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    );
    expect(resolveRuntimeApiKey('qwen')).toBe('fixture-bailian-key');
  });

  it('qwen accepts its own BAILIAN/DASHSCOPE env vars without a host gate', () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'fixture-dashscope-key');
    expect(resolveRuntimeApiKey('qwen')).toBe('fixture-dashscope-key');
  });

  it('qwen has no runtime key when nothing is configured', () => {
    expect(hasRuntimeKey('qwen')).toBe(false);
  });

  it('credential living only in ~/.qwen/settings.json counts as present', () => {
    qwenSettingsProbe.hasCredential.mockReturnValue(true);
    expect(hasRuntimeKey('qwen')).toBe(true);
    // ...mas nunca é copiada para o env do spawn.
    expect(resolveRuntimeApiKey('qwen')).toBeNull();
  });
});

describe('Recibo da escolha de conta (overrides.accountChoice)', () => {
  const kimiAccount = (id: string, label: string, createdAt: number) => ({
    id,
    adapterId: 'kimi',
    label,
    mode: 'api_key' as const,
    upstream: 'anthropic',
    createdAt,
  });
  const quotaEntries = (entries: Array<Record<string, unknown>>) =>
    ({ entries }) as never;

  beforeEach(() => {
    // O beforeEach do describe original tem escopo próprio — reancora os
    // mocks que este bloco lê.
    spawnDeps.quotaSnapshot.mockReturnValue(null);
    spawnDeps.blockedForScope.mockReturnValue(false);
    spawnDeps.hasFailoverCredential.mockReturnValue(true);
    spawnDeps.listAccounts.mockReturnValue([]);
    spawnDeps.getActiveAccount.mockReturnValue(null);
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account: null });
  });

  it('pinned: a conta do chamador vence e as irmãs viram alternativas', () => {
    const account = kimiAccount('kimi-p', 'pinada@corp.com', 1);
    spawnDeps.prepareAccount.mockReturnValueOnce({
      ok: true,
      account,
      apiKey: 'sk-pinned',
      authEnv: {},
    });
    spawnDeps.listAccounts.mockReturnValue([
      account,
      kimiAccount('kimi-x', 'irma@corp.com', 2),
    ]);
    spawnDeps.blockedForScope.mockImplementation(
      (id?: string) => id === 'kimi-x',
    );

    const result = prepareProviderSpawn('kimi', { accountId: 'kimi-p' });

    expect(result).toMatchObject({ ok: true });
    const receipt = (result as { overrides: { accountChoice?: unknown } })
      .overrides.accountChoice as {
      source: string;
      account: { label: string; mode: string };
      alternatives: Array<{ label: string; skipped: string }>;
    };
    expect(receipt.source).toBe('pinned');
    expect(receipt.account.label).toBe('p•••@c•••.com');
    expect(receipt.alternatives).toEqual([
      expect.objectContaining({
        label: 'i•••@c•••.com',
        skipped: 'cooldown',
      }),
    ]);
  });

  it('headroom-rule: a irmã mais livre do snapshot vence a ativa', () => {
    spawnDeps.listAccounts.mockReturnValue([
      kimiAccount('kimi-a', 'ana@corp.com', 1),
      kimiAccount('kimi-b', 'bia@corp.com', 2),
    ]);
    spawnDeps.getActiveAccount.mockReturnValue(
      kimiAccount('kimi-a', 'ana@corp.com', 1),
    );
    spawnDeps.quotaSnapshot.mockReturnValue(
      quotaEntries([
        {
          adapterId: 'kimi',
          accountId: 'kimi-a',
          windows: [{ label: 'Sessão', usedRatio: 0.98, resetsAt: 111 }],
        },
        {
          adapterId: 'kimi',
          accountId: 'kimi-b',
          windows: [{ label: 'Sessão', usedRatio: 0.1, resetsAt: 222 }],
        },
      ]),
    );
    spawnDeps.pickAvailableForFailover.mockReturnValue({
      account: kimiAccount('kimi-b', 'bia@corp.com', 2),
    });

    const result = prepareProviderSpawn('kimi');

    expect(result).toMatchObject({ ok: true });
    const receipt = (result as { overrides: { accountChoice?: unknown } })
      .overrides.accountChoice as {
      source: string;
      account: { label: string };
      headroom: { usedPct: number; window: string; resetsAt: number };
      alternatives: Array<{ label: string; skipped: string }>;
    };
    expect(receipt.source).toBe('headroom-rule');
    expect(receipt.account.label).toBe('b•••@c•••.com');
    expect(receipt.headroom).toMatchObject({
      usedPct: 10,
      window: 'Sessão',
      resetsAt: 222,
    });
    expect(receipt.alternatives).toEqual([
      expect.objectContaining({
        label: 'a•••@c•••.com',
        skipped: 'less-headroom',
      }),
    ]);
  });

  it('active: sem medição a ativa continua e o recibo diz isso', () => {
    spawnDeps.listAccounts.mockReturnValue([
      kimiAccount('kimi-a', 'ana@corp.com', 1),
    ]);
    spawnDeps.getActiveAccount.mockReturnValue(
      kimiAccount('kimi-a', 'ana@corp.com', 1),
    );
    spawnDeps.pickAvailableForFailover.mockReturnValue({
      account: kimiAccount('kimi-a', 'ana@corp.com', 1),
    });

    const result = prepareProviderSpawn('kimi');

    const receipt = (result as { overrides: { accountChoice?: unknown } })
      .overrides.accountChoice as {
      source: string;
      headroom: unknown;
    };
    expect(receipt.source).toBe('active');
    expect(receipt.headroom).toBeNull();
  });

  it('active-fallback: tudo bloqueado cai na ativa com o aviso no recibo', () => {
    spawnDeps.listAccounts.mockReturnValue([
      kimiAccount('kimi-a', 'ana@corp.com', 1),
      kimiAccount('kimi-b', 'bia@corp.com', 2),
    ]);
    spawnDeps.getActiveAccount.mockReturnValue(
      kimiAccount('kimi-a', 'ana@corp.com', 1),
    );
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account: null });
    spawnDeps.blockedForScope.mockReturnValue(true);

    const result = prepareProviderSpawn('kimi');

    const receipt = (result as { overrides: { accountChoice?: unknown } })
      .overrides.accountChoice as {
      source: string;
      note?: string;
      alternatives: Array<{ skipped: string }>;
    };
    expect(receipt.source).toBe('active-fallback');
    expect(receipt.note).toContain('nenhuma conta livre');
    expect(receipt.alternatives[0]?.skipped).toBe('cooldown');
  });

  it('native: claude sem pin fica na linhagem nativa', () => {
    const result = prepareProviderSpawn('claude');

    const receipt = (result as { overrides: { accountChoice?: unknown } })
      .overrides.accountChoice as { source: string; account: unknown };
    expect(receipt.source).toBe('native');
    expect(receipt.account).toBeNull();
    expect(spawnDeps.pickAvailableForFailover).not.toHaveBeenCalled();
  });

  it('legacy: adapter sem contas cai no caminho providers.conf', () => {
    spawnDeps.listAccounts.mockReturnValue([]);
    spawnDeps.getActiveAccount.mockReturnValue(null);

    const result = prepareProviderSpawn('kimi');

    const receipt = (result as { overrides: { accountChoice?: unknown } })
      .overrides.accountChoice as { source: string };
    expect(receipt.source).toBe('legacy');
  });
});

describe('effectiveDefaultModel — preferência antiga do Kimi (smoke 28/09)', () => {
  it('kimi-k2.7 guardado vira o alias "K2.7 Coding" do config.toml, nunca o id cru', () => {
    const known = ['kimi-code/k3', 'kimi-code/kimi-for-coding', 'kimi-code/kimi-for-coding-highspeed'];
    expect(effectiveDefaultModel('kimi', 'kimi-k2.7', known, 'kimi-code/k3'))
      .toBe('kimi-code/kimi-for-coding');
    expect(effectiveDefaultModel('kimi', 'kimi-k2-turbo', known, 'kimi-code/k3'))
      .toBe('kimi-code/kimi-for-coding-highspeed');
    // Id que nem migra nem existe: default do adapter (preferência mantida no arquivo).
    expect(effectiveDefaultModel('kimi', 'kimi-k9', known, 'kimi-code/k3')).toBe('kimi-code/k3');
  });
});

describe('F-210: instalação de Claude verifica e reutiliza o binário real', () => {
  const install = () => spawnDeps.trustedHandlers.get(PROVIDER_CHANNELS.installCli)!({}, { adapterId: 'claude', mode: 'install' });
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    spawnDeps.resolvedClaudeBin = '/usr/local/bin/claude';
    spawnDeps.confirmInstall.mockClear();
    spawnDeps.downloadInstaller.mockClear();
    spawnDeps.rescanBinaries.mockReset().mockResolvedValue([]);
    spawnDeps.execFile.mockReset().mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: null, stdout: string) => void)(null, '4.12.7 (Claude Code)');
      return {} as ChildProcess;
    });
    registerProviderIpc();
  });
  afterEach(() => {
    spawnDeps.resolvedClaudeBin = '/usr/local/bin/claude';
    vi.restoreAllMocks();
  });
  it('CLI existente validada não dispara instalador nem sobrescreve launcher', async () => {
    await expect(install()).resolves.toMatchObject({ ok: true, changed: false, version: '4.12.7 (Claude Code)' });
    expect(spawnDeps.execFile).toHaveBeenCalledOnce();
    expect(spawnDeps.execFile.mock.calls[0]?.slice(0, 2)).toEqual(['/usr/local/bin/claude', ['--version']]);
    expect(spawnDeps.confirmInstall).not.toHaveBeenCalled();
    expect(spawnDeps.downloadInstaller).not.toHaveBeenCalled();
  });
  it('instalador exit 0 sem binário encontrado não anuncia sucesso', async () => {
    spawnDeps.resolvedClaudeBin = null;
    await expect(install()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('não conseguiu verificar') });
    expect(spawnDeps.downloadInstaller).toHaveBeenCalledWith('https://claude.ai/install.sh');
    expect(spawnDeps.execFile.mock.calls[0]?.[0]).toBe('/bin/bash');
  });
  it('instalação nativa é reexaminada e sua versão comprovada antes do sucesso', async () => {
    spawnDeps.resolvedClaudeBin = null;
    spawnDeps.execFile.mockImplementation((...args: unknown[]) => {
      if (args[0] === '/bin/bash') spawnDeps.resolvedClaudeBin = '/fixture-quota-home/.local/share/claude/versions/4.12.7';
      (args.at(-1) as (error: null, stdout: string) => void)(null, '4.12.7 (Claude Code)');
      return {} as ChildProcess;
    });
    await expect(install()).resolves.toMatchObject({ ok: true, version: '4.12.7 (Claude Code)' });
    expect(spawnDeps.execFile.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      '/fixture-quota-home/.local/share/claude/versions/4.12.7', ['--version'],
    ]);
  });
});

describe('N1: fronteira IPC de keys de providers', () => {
  beforeEach(() => { registerProviderIpc(); spawnDeps.setKey.mockClear(); });
  it.each(['auth:account', 'auth:license-seal-key', 'auth:session', 'unknown-provider'])
  ('recusa escrita e exclusão de %s antes de tocar o cofre', adapterId => {
    const handler = spawnDeps.trustedHandlers.get(PROVIDER_CHANNELS.setKey)!;
    expect(handler({}, { adapterId, key: 'forged' })).toMatchObject({ ok: false });
    expect(handler({}, { adapterId, key: '' })).toMatchObject({ ok: false });
    expect(spawnDeps.setKey).not.toHaveBeenCalled();
  });
  it('mantém escrita e exclusão de provider registrado', () => {
    const handler = spawnDeps.trustedHandlers.get(PROVIDER_CHANNELS.setKey)!;
    expect(handler({}, { adapterId: 'claude', key: 'key-test' })).toEqual({ ok: true });
    expect(handler({}, { adapterId: 'claude', key: '' })).toEqual({ ok: true });
    expect(spawnDeps.setKey.mock.calls).toEqual([['claude', 'key-test'], ['claude', '']]);
  });
});
