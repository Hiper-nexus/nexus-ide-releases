import fsp from 'node:fs/promises';
import fs from 'node:fs';
import * as periodicFileRead from '../redline/redline-safe-read';
import mimoRaw from '../../adapters/builtin/mimo-code.json';
import museRaw from '../../adapters/builtin/muse.json';
import type { ChildProcess } from 'node:child_process';
import { PROVIDER_CHANNELS } from '../../shared/provider-settings-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnDeps = vi.hoisted(() => ({
  resolvedClaudeBin: '/usr/local/bin/claude' as string | null,
  /** F-1397: adapters elegíveis para candidato de atualização (mutável por teste). */
  builtinIds: new Set<string>(['claude']),
  /** C5: brew resolvível só nos testes que pedem (null = sem Homebrew). */
  brewBin: null as string | null,
  /** C5: espião do execFileSync — o Main nunca pode bloquear num `brew info`. */
  execFileSync: vi.fn(),
  trustedHandlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  confirmInstall: vi.fn(async (..._args: unknown[]) => ({ response: 1 })),
  windows: [] as unknown[],
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
  verifyClaudeAccount: vi.fn<(_id: string, onVerified?: (blob: string) => void) => Promise<'match' | 'renewable' | 'mismatch' | 'auth-expired' | 'auth-unproven' | 'unavailable'>>(
    async (_id, onVerified) => { onVerified?.('verified-claude-blob'); return 'match'; },
  ),
  resolveCliBinary: vi.fn((runner: string): { binPath: string } | null =>
    runner === '/usr/local/bin/claude'
      ? { binPath: runner }
      : runner === 'npm'
      ? { binPath: 'C:\\Program Files\\nodejs\\npm.cmd' }
      : runner === 'bash'
      ? { binPath: '/bin/bash' }
      : (runner === 'brew' || runner === spawnDeps.brewBin) && spawnDeps.brewBin
      ? { binPath: spawnDeps.brewBin }
      : null,
  ),
  /** Avisos de instalação servidos pelo cache de descoberta (perf #9). */
  installationWarnings: new Map<string, string>(),
}));

vi.mock('node:os', async (importOriginal) => {
  const mock = { ...(await importOriginal<typeof import('node:os')>()), homedir: () => '/fixture-quota-home' };
  return { ...mock, default: mock };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // Espião que só registra; o brew do fixture nunca roda de verdade.
  const execFileSync = ((...args: Parameters<typeof actual.execFileSync>) => {
    spawnDeps.execFileSync(...args);
    if (spawnDeps.brewBin && args[0] === spawnDeps.brewBin) throw new Error('brew síncrono no Main');
    return actual.execFileSync(...args);
  }) as typeof actual.execFileSync;
  return { ...actual, execFile: spawnDeps.execFile, execFileSync };
});
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

const museAdapter = { ...kimiAdapter, ...museRaw };

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
  BrowserWindow: { getAllWindows: () => spawnDeps.windows, getFocusedWindow: () => null },
  dialog: { showMessageBox: spawnDeps.confirmInstall },
  net: { fetch: spawnDeps.downloadInstaller },
  ipcMain: { handle: vi.fn() },
  // C5: o handler do toggle grava a preferência em userData.
  app: { getPath: () => '/fixture-quota-home' },
}));

vi.mock('../security/trusted-ipc', async (original) => ({
  ...(await original<typeof import('../security/trusted-ipc')>()),
  handleTrusted: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
    spawnDeps.trustedHandlers.set(channel, handler);
  },
}));

vi.mock('../adapters/adapter-registry', () => ({
  isBuiltinAdapter: (id: string) => spawnDeps.builtinIds.has(id),
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
  getAdapterInstallationWarning: (id: string) =>
    spawnDeps.installationWarnings.get(id),
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
        : id === 'minimax-code'
          ? '/usr/local/bin/mcode'
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
    qwenAdapter,
  ],
  notifyAdaptersChanged: vi.fn(),
  primaryKeyEnvVar: (adapter: { auth: { envVarFallback?: string } }) =>
    'envVarFallback' in adapter.auth
      ? adapter.auth.envVarFallback
      : null,
}));

// Unit tests use synthetic absolute paths that do not exist on disk.
vi.mock('../path-resolver', () => ({
  cachedCliBinaryVersion: () => undefined,
  realUserHome: () => '/fixture-quota-home',
  revalidateExecutable: (binPath: string) =>
    typeof binPath === 'string' &&
    (binPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(binPath)),
  resolveCliBinary: spawnDeps.resolveCliBinary,
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
  loadLauncherProviderBaseUrl: () => null,
  upstreamAllowedForAdapter: () => true,
}));

vi.mock('../adapters/model-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/model-catalog')>()),
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
  readiness: 'unknown' as 'unknown' | 'present' | 'invalid-credential',
  // F-1567: o spawn lê o resumo do settings para resolver a base URL da
  // injeção; o padrão é "sem settings.json" para o teste ser hermético.
  summary: {
    hasCredential: false,
    baseUrl: null,
    authBaseUrl: null,
    tokenPlan: false,
    modelIds: [],
  } as unknown as import('../adapters/qwen-settings').QwenSettingsSummary,
}));
vi.mock('../adapters/qwen-readiness-cache', () => ({
  peekQwenReadiness: () => ({ state: qwenSettingsProbe.readiness }),
  requestQwenReadiness: vi.fn(async () => {}),
  invalidateQwenReadiness: vi.fn(),
  verifyQwenReadiness: vi.fn(async () => ({ state: qwenSettingsProbe.readiness })),
}));
vi.mock('../adapters/qwen-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/qwen-settings')>()),
  qwenSettingsHasCredential: qwenSettingsProbe.hasCredential,
  readQwenSettingsSummary: () => qwenSettingsProbe.summary,
}));

const minimaxRuntime = vi.hoisted(() => ({
  prepare: vi.fn(async (_binPath: string, _pathEnv?: string) => ({ kind: 'default' as const })),
}));
vi.mock('../adapters/minimax-node-runtime', () => ({
  prepareMinimaxNodeRuntime: minimaxRuntime.prepare,
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
  refreshBrewIndexIfDue,
  registerProviderIpc,
  resolveRunnerPath,
  runInstallRecipe,
  resolveQuotaApiKey,
  resolveRuntimeApiKey,
  hasRuntimeKey,
} from './provider-config-store';
import { fetchLiveProviderWindows } from '../quota/provider-live-usage';
import { parseAccountReloginRequest } from '../../shared/account-relogin';

function sheetHost(visible: boolean) {
  return { isDestroyed: () => false, isVisible: () => visible, isFocusable: () => true };
}

describe('background CLI maintenance during pane startup', () => {
  let stop: (() => void) | undefined;
  let finishUpdate: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnDeps.builtinIds.clear();
    spawnDeps.builtinIds.add('claude');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    spawnDeps.systemIdleTime.mockReturnValue(120);
    spawnDeps.rescanBinaries.mockReset().mockResolvedValue([]);
    spawnDeps.confirmInstall.mockClear();
    spawnDeps.windows = [];
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ enabled: true, checkedAt: {} }));
    vi.spyOn(fs, 'realpathSync').mockReturnValue('/fixture-quota-home/.local/share/claude/versions/1');
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
    vi.spyOn(fsp, 'realpath').mockResolvedValue('/fixture-quota-home/.local/share/claude/versions/1');
    vi.spyOn(fsp, 'access').mockResolvedValue(undefined);
    vi.spyOn(fsp, 'rename').mockResolvedValue(undefined);
    vi.spyOn(fsp, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fsp, 'writeFile').mockResolvedValue(undefined);
    vi.spyOn(fsp, 'rm').mockResolvedValue(undefined);
    // Sem disco real: o marcador de install interrompido (R3) e o registro do
    // brew update não existem — leitura real atrasaria o boot sob fake timers.
    vi.spyOn(fsp, 'readFile').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    vi.spyOn(periodicFileRead, 'readRegularFileCappedAsync').mockResolvedValue({ kind: 'text', stamp: 'fixture', text: JSON.stringify({ enabled: true, checkedAt: {} }) });
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
    const stopped = stop?.();
    finishUpdate?.();
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    vi.restoreAllMocks();
    spawnDeps.downloadInstaller.mockReset().mockImplementation(async () => ({ ok: true, text: async () => '#!/bin/bash\nexit 0\n' }));
    vi.useRealTimers();
  });

  it('runs automatic CLI maintenance on Linux', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    stop = startCliAutoUpdate('/fixture-quota-home', () => false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeTypeOf('function');
  });

  it('enables daily idle updates when no preference file exists', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    vi.spyOn(periodicFileRead, 'readRegularFileCappedAsync').mockResolvedValue({ kind: 'none', stamp: 'missing' });
    stop = startCliAutoUpdate('/fixture-quota-home', () => false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeTypeOf('function');
  });

  // F-1203: quem respondeu "Agora não" é perguntado de novo 7 dias depois, e
  // só com o sistema ocioso — o operador longe e o Nexus fora de foco. No macOS
  // um showMessageBox sem janela-mãe é NSAlert runModal e prendia a main thread
  // até alguém voltar.
  const declined = JSON.stringify({ enabled: false, askAgainAt: 1, checkedAt: {} });
  const declinedBefore = () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(declined);
    vi.spyOn(periodicFileRead, 'readRegularFileCappedAsync').mockResolvedValue({ kind: 'text', stamp: 'declined', text: declined });
  };

  it('asks the idle consent again as a sheet on the unfocused Nexus window', async () => {
    const win = sheetHost(false);
    spawnDeps.windows = [win];
    declinedBefore();
    stop = startCliAutoUpdate('/fixture-quota-home', () => false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnDeps.confirmInstall).toHaveBeenCalled();
    for (const call of spawnDeps.confirmInstall.mock.calls) expect(call[0]).toBe(win);
    expect(fsp.writeFile).toHaveBeenCalled();
  });

  it('without any window it neither freezes Main on a parentless alert nor records a decision', async () => {
    spawnDeps.windows = [];
    declinedBefore();
    stop = startCliAutoUpdate('/fixture-quota-home', () => false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnDeps.confirmInstall).not.toHaveBeenCalled();
    expect(fsp.writeFile).not.toHaveBeenCalled();
    expect(finishUpdate).toBeUndefined();
  });

  it.each([
    { kind: 'none', stamp: 'unreadable' },
    { kind: 'text', stamp: 'bad', text: '{' },
    { kind: 'text', stamp: 'off', text: JSON.stringify({ enabled: false, askAgainAt: Number.MAX_SAFE_INTEGER, checkedAt: {} }) },
  ] as const)('does not update with unreadable, corrupt, or explicitly disabled preferences: $stamp', async (read) => {
    vi.spyOn(periodicFileRead, 'readRegularFileCappedAsync').mockResolvedValue(read);
    stop = startCliAutoUpdate('/fixture-quota-home', () => false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeUndefined();
  });

  it('after the boot pass, the daily tick leaves launchers available while the operator is active, then updates when idle', async () => {
    spawnDeps.systemIdleTime.mockReturnValue(0);
    // F-1395: checada há 10 min — o boot pula; o tick diário espera ociosidade.
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ enabled: true, checkedAt: { claude: Date.now() - 10 * 60_000 } }));
    stop = startCliAutoUpdate('/fixture-quota-home', () => false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeUndefined();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeUndefined();
    const release = await acquireCliSpawnPermit('claude');
    release();

    spawnDeps.systemIdleTime.mockReturnValue(120);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeTypeOf('function');
  });

  describe('F-1395: no boot, analisar e atualizar todas as CLIs', () => {
    const checkedAgo = (ms: number) =>
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ enabled: true, checkedAt: { claude: Date.now() - ms } }));
    const npmClaude = '/fixture-quota-home/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js';

    it('(a) boot com checkedAt de 3 h e sistema NÃO ocioso atualiza sem esperar o tick de 60 s', async () => {
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finishUpdate).toBeTypeOf('function');
      // F-1397: instalação versionada (claude no versions/) não segura spawn —
      // o pane nasce já, no binário atual; outra CLI nunca foi presa.
      let kimi: (() => void) | undefined;
      void acquireCliSpawnPermit('kimi').then((release) => { kimi = release; });
      let claude: (() => void) | undefined;
      void acquireCliSpawnPermit('claude').then((release) => { claude = release; });
      await vi.advanceTimersByTimeAsync(0);
      expect(kimi).toBeTypeOf('function');
      expect(claude).toBeTypeOf('function');
      kimi!(); claude!();
      finishUpdate!();
      await vi.advanceTimersByTimeAsync(0);
      // Antes→depois chega ao snapshot da UI de provedores.
      expect(listProviderSettings().find((info) => info.adapterId === 'claude')?.cliAutoUpdate)
        .toMatchObject({ status: 'unchanged', fromVersion: '1.0.0', toVersion: '1.0.0' });
    });

    it('(d) a CLI checada há < 30 min não repete no boot', async () => {
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(10 * 60_000);
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(finishUpdate).toBeUndefined();
    });

    it('(c) instalação versionada atualiza com pane vivo', async () => {
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      stop = startCliAutoUpdate('/fixture-quota-home', () => true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finishUpdate).toBeTypeOf('function');
    });

    it('(c) npm com pane vivo espera e dispara quando o ÚLTIMO pane daquela CLI fecha', async () => {
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      vi.spyOn(fs, 'realpathSync').mockReturnValue(npmClaude);
      vi.spyOn(fsp, 'realpath').mockResolvedValue(npmClaude);
      let livePanes = 2;
      let paneExit!: (adapterId: string) => void;
      stop = startCliAutoUpdate('/fixture-quota-home', () => livePanes > 0, (listener) => {
        paneExit = listener;
        return () => undefined;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(finishUpdate).toBeUndefined();
      livePanes = 1;
      paneExit('claude');
      await vi.advanceTimersByTimeAsync(0);
      expect(finishUpdate).toBeUndefined();
      livePanes = 0;
      paneExit('claude');
      await vi.advanceTimersByTimeAsync(0);
      expect(finishUpdate).toBeTypeOf('function');
    });

    it('a falha da atualização chega ao snapshot com o motivo curto', async () => {
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      spawnDeps.execFile.mockImplementation((...args: unknown[]) => {
        const argv = args[1] as string[];
        const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
        if (argv[0] === 'update') callback(new Error('Command failed: claude update\nnetwork unreachable'), '');
        else callback(null, '1.0.0');
        return {} as ChildProcess;
      });
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(listProviderSettings().find((info) => info.adapterId === 'claude')?.cliAutoUpdate)
        .toMatchObject({ status: 'failed', fromVersion: '1.0.0', reason: 'install-failed' });
      warn.mockRestore();
    });

    it('B2: stderr com Bearer sintético grava motivo no trace sem vazar o token em texto claro', async () => {
      const traceModule = await import('../observability/main-trace');
      const traceSpy = vi.spyOn(traceModule, 'trace');
      try {
        spawnDeps.systemIdleTime.mockReturnValue(0);
        checkedAgo(3 * 60 * 60_000);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const secretBearer = 'Bearer synthetic-secret-token-abcdef1234567890';
        spawnDeps.execFile.mockImplementation((...args: unknown[]) => {
          const argv = args[1] as string[];
          const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
          if (argv[0] === 'update') {
            callback(new Error(`Command failed: claude update\nnpm ERR! 401 Unauthorized: ${secretBearer}`), '');
          } else {
            callback(null, '1.0.0');
          }
          return {} as ChildProcess;
        });
        stop = startCliAutoUpdate('/fixture-quota-home', () => false);
        await vi.advanceTimersByTimeAsync(5_000);
        warn.mockRestore();

        const cliUpdateCalls = traceSpy.mock.calls.filter((call) => (call[0] as { kind?: string })?.kind === 'cli-update');
        expect(cliUpdateCalls.length).toBeGreaterThan(0);
        const detail = (cliUpdateCalls[0]![0] as { detail?: string }).detail;
        expect(detail).toBeDefined();
        expect(detail).not.toContain('synthetic-secret-token-abcdef1234567890');
        expect(detail).toContain('[REDACTED]');
      } finally {
        traceSpy.mockRestore();
      }
    });

    it('B3: spawn preso por install no lugar é recusado no teto; o prazo de 120s do fetch libera o lease', async () => {
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // F-1397: instalação versionada (versions/) não prende spawn nem durante o
      // download; o prazo B3 só segura o spawn de instalação que troca no lugar.
      vi.spyOn(fs, 'realpathSync').mockReturnValue(npmClaude);
      vi.spyOn(fsp, 'realpath').mockResolvedValue(npmClaude);

      const cliAutoUpdateModule = await import('../adapters/cli-auto-update');
      vi.spyOn(cliAutoUpdateModule, 'selectAutomaticCliUpdateRecipe').mockReturnValue({
        kind: 'script',
        scriptUrl: 'https://cli.devin.ai/install.sh',
        runner: 'bash',
        runnerHint: 'instale o bash',
        automaticUpdate: true,
      });

      spawnDeps.downloadInstaller.mockImplementation(() => new Promise(() => {}));

      const traceModule = await import('../observability/main-trace');
      const traceSpy = vi.spyOn(traceModule, 'trace');

      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);

      let claudePermit: (() => void) | undefined;
      let refusal: unknown;
      void acquireCliSpawnPermit('claude').then(
        (release) => { claudePermit = release; },
        (error: unknown) => { refusal = error; },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(claudePermit).toBeUndefined();

      // Teto da espera: recusa com erro claro e trace; nunca nasce por cima da troca.
      await vi.advanceTimersByTimeAsync(cliAutoUpdateModule.CLI_SPAWN_PERMIT_TIMEOUT_MS);
      expect(claudePermit).toBeUndefined();
      expect(refusal).toBeInstanceOf(cliAutoUpdateModule.CliSpawnPermitTimeoutError);
      expect(traceSpy).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'cli-update', adapterId: 'claude', status: 'spawn-refused', phase: 'spawn-permit-timeout',
      }));
      traceSpy.mockRestore();

      // O prazo B3 do fetch libera o lease: o spawn seguinte da mesma CLI sai na hora.
      await vi.advanceTimersByTimeAsync(120_000);
      void acquireCliSpawnPermit('claude').then((release) => { claudePermit = release; });
      await vi.advanceTimersByTimeAsync(0);
      expect(claudePermit).toBeTypeOf('function');
      claudePermit!();

      expect(listProviderSettings().find((info) => info.adapterId === 'claude')?.cliAutoUpdate)
        .toMatchObject({ status: 'failed', reason: 'download-timeout' });

      warn.mockRestore();
    });

    // Interação F-1397 × B3: com instalação versionada o spawn nasce durante o
    // download pendente (o binário atual não é tocado), e o prazo de 120 s
    // continua encerrando a instalação e soltando o lease.
    it('B3 + F-1397: versionada com download pendente libera o spawn já e o prazo ainda encerra a instalação', async () => {
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cliAutoUpdateModule = await import('../adapters/cli-auto-update');
      vi.spyOn(cliAutoUpdateModule, 'selectAutomaticCliUpdateRecipe').mockReturnValue({
        kind: 'script',
        scriptUrl: 'https://claude.ai/install.sh',
        runner: 'bash',
        runnerHint: 'instale o bash',
        automaticUpdate: true,
      });
      spawnDeps.downloadInstaller.mockImplementation(() => new Promise(() => {}));
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((spawnDeps.downloadInstaller.mock.calls[0] as unknown[] | undefined)?.[0]).toBe('https://claude.ai/install.sh');

      const permit = await acquireCliSpawnPermit('claude');
      permit();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(listProviderSettings().find((info) => info.adapterId === 'claude')?.cliAutoUpdate)
        .toMatchObject({ status: 'failed', reason: 'download-timeout' });
      warn.mockRestore();
    });

    it('B3: stop resolve prontamente mesmo com download de script pendente', async () => {
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const cliAutoUpdateModule = await import('../adapters/cli-auto-update');
      vi.spyOn(cliAutoUpdateModule, 'selectAutomaticCliUpdateRecipe').mockReturnValue({
        kind: 'script',
        scriptUrl: 'https://cli.devin.ai/install.sh',
        runner: 'bash',
        runnerHint: 'instale o bash',
        automaticUpdate: true,
      });

      spawnDeps.downloadInstaller.mockImplementation(() => new Promise(() => {}));

      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);

      let stoppedResolved = false;
      const stopPromise = (stop as () => Promise<void>)().then(() => { stoppedResolved = true; });
      await vi.advanceTimersByTimeAsync(0);

      await expect(stopPromise).resolves.toBeUndefined();
      expect(stoppedResolved).toBe(true);

      warn.mockRestore();
    });
  });

  describe('F-1397: checagem barata de versão e spawn durante atualização', () => {
    const checkedAgo = (ms: number) =>
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ enabled: true, checkedAt: { claude: Date.now() - ms } }));
    /**
     * opencode pelo npm: a receita de update é `npm install -g --prefix`. O
     * caminho fica sob o home do fixture — o updater só aceita instalação
     * dentro do home do operador, e o claude continua candidato pelo
     * self-update com esse mesmo realpath.
     */
    const npmOpencode = '/fixture-quota-home/.npm-global/lib/node_modules/opencode-ai/bin/opencode.js';
    const npmInstall = ['install', '-g', '--prefix', '/fixture-quota-home/.npm-global', '--allow-scripts=opencode-ai', 'opencode-ai'];
    let installs: string[][];
    let viewReply: { error: Error | null; stdout: string };
    let viewOptions: Array<Record<string, unknown> | undefined>;

    /** Fixture npm: opencode vira candidato e o realpath aponta para o pacote. */
    const npmFixture = () => {
      spawnDeps.builtinIds.add('opencode');
      vi.spyOn(fs, 'realpathSync').mockReturnValue(npmOpencode);
      vi.spyOn(fsp, 'realpath').mockResolvedValue(npmOpencode);
      installs = [];
      viewOptions = [];
      viewReply = { error: null, stdout: '1.0.0\n' };
      spawnDeps.execFile.mockImplementation((...args: unknown[]) => {
        const argv = args[1] as string[];
        const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
        if (argv[0] === 'update' || argv[0] === 'install') {
          installs.push(argv);
          finishUpdate = () => callback(null, '');
        } else if (argv[0] === 'view') {
          viewOptions.push(args[2] as Record<string, unknown> | undefined);
          callback(viewReply.error, viewReply.stdout);
        } else callback(null, '1.0.0');
        return {} as ChildProcess;
      });
    };

    const opencodeSnapshot = () =>
      listProviderSettings().find((info) => info.adapterId === 'opencode')?.cliAutoUpdate;

    it('(a) npm em dia: nenhuma instalação, evento up-to-date', async () => {
      npmFixture();
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      finishUpdate!(); // o claude (self-update) termina e o passe segue
      await vi.advanceTimersByTimeAsync(0);
      // opencode (npm) NÃO reinstala em dia; o claude (self-update) pode rodar.
      expect(installs.filter((argv) => argv[0] === 'install')).toEqual([]);
      expect(opencodeSnapshot()).toMatchObject({ status: 'up-to-date', fromVersion: '1.0.0', toVersion: '1.0.0' });
      // A checagem é de leitura: proíbe o `brew update` implícito do Homebrew
      // (revisão F-1397) e roda com teto curto, não o de 15 min do install.
      expect(viewOptions.length).toBeGreaterThan(0);
      for (const options of viewOptions) {
        expect((options?.env as Record<string, string> | undefined)?.HOMEBREW_NO_AUTO_UPDATE).toBe('1');
        expect(options?.timeout).toBe(30_000);
        // Interação com B3: o stop do updater cancela a checagem em voo.
        expect(options?.signal).toBeInstanceOf(AbortSignal);
      }
    });

    it('(b) npm desatualizada: instala como hoje', async () => {
      npmFixture();
      viewReply.stdout = '2.0.0\n';
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      finishUpdate!(); // claude
      await vi.advanceTimersByTimeAsync(0);
      expect(installs).toContainEqual(npmInstall);
      finishUpdate!(); // install do opencode, rearmado pelo mock
      await vi.advanceTimersByTimeAsync(0);
      expect(opencodeSnapshot()).toMatchObject({ status: 'unchanged', toVersion: '1.0.0' });
    });

    it('(c) checagem falha: instala como hoje', async () => {
      npmFixture();
      viewReply.error = new Error('npm ERR! network');
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      finishUpdate!(); // claude
      await vi.advanceTimersByTimeAsync(0);
      expect(installs).toContainEqual(npmInstall);
    });

    it('(d) spawn do claude versionado em atualização nasce na hora', async () => {
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finishUpdate).toBeTypeOf('function');
      let claudeRelease: (() => void) | undefined;
      void acquireCliSpawnPermit('claude').then((release) => { claudeRelease = release; });
      await vi.advanceTimersByTimeAsync(0);
      expect(claudeRelease).toBeTypeOf('function');
      claudeRelease!();
      finishUpdate!();
      await vi.advanceTimersByTimeAsync(0);
      expect(listProviderSettings().find((info) => info.adapterId === 'claude')?.cliAutoUpdate)
        .toMatchObject({ status: 'unchanged' });
    });

    it('(d) spawn da CLI npm (troca no lugar) espera o install acabar', async () => {
      npmFixture();
      viewReply.stdout = '2.0.0\n';
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      finishUpdate!(); // claude
      await vi.advanceTimersByTimeAsync(0);
      expect(installs).toContainEqual(npmInstall);
      let opencodeRelease: (() => void) | undefined;
      void acquireCliSpawnPermit('opencode').then((release) => { opencodeRelease = release; });
      await vi.advanceTimersByTimeAsync(0);
      expect(opencodeRelease).toBeUndefined();
      finishUpdate!(); // install do opencode, rearmado pelo mock
      await vi.advanceTimersByTimeAsync(0);
      expect(opencodeRelease).toBeTypeOf('function');
      opencodeRelease!();
    });

    it('spawn em voo (permit preso) adia a CLI sem retentativa de 1 h', async () => {
      npmFixture();
      viewReply.stdout = '2.0.0\n';
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      // Pane ainda não registrado: o permit de spawn está preso.
      const releaseSpawn = await acquireCliSpawnPermit('opencode');
      // O resultado por CLI é compartilhado entre testes: compara por identidade.
      const baseline = opencodeSnapshot();
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      finishUpdate?.(); // claude
      await vi.advanceTimersByTimeAsync(0);
      // Não é falha: nenhum resultado novo para o opencode.
      expect(opencodeSnapshot()).toBe(baseline);
      releaseSpawn();
      spawnDeps.systemIdleTime.mockReturnValue(120); // o tique periódico pede ociosidade
      vi.setSystemTime(Date.now() + 61_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(installs).toContainEqual(npmInstall);
    });

    it('pane que abriu entre next() e run() dispara a atualização no fechamento, sem 1 h de castigo', async () => {
      npmFixture(); // claude deixa de ser versionado: o pane volta a bloqueá-lo
      spawnDeps.systemIdleTime.mockReturnValue(0);
      checkedAgo(3 * 60 * 60_000);
      let paneOpen = false;
      let liveCalls = 0;
      let paneExit!: (adapterId: string) => void;
      // 1ª leitura (next): sem pane; 2ª (guarda do run): pane abriu no meio.
      const live = () => (++liveCalls === 2 ? true : paneOpen);
      stop = startCliAutoUpdate('/fixture-quota-home', (id) => (id === 'claude' ? live() : paneOpen), (listener) => {
        paneExit = listener;
        return () => undefined;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finishUpdate).toBeUndefined(); // recusada com o pane aberto
      paneOpen = true;
      paneOpen = false;
      paneExit('claude');
      vi.setSystemTime(Date.now() + 61_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(finishUpdate).toBeTypeOf('function'); // repassou no fechamento
      finishUpdate!();
    });
  });

  // Índice do Homebrew: um `brew update` assíncrono antes do que decide a
  // instalação (manifesto relido e `brew outdated` no run), no máximo a cada
  // 6 h (tentativa persistida), só com enabled e alguma CLI do brew (M8), e
  // serializado com os outros brew que gravam (M8). Falha não trava a passada.
  describe('brew update antes do manifesto (índice do Homebrew)', () => {
    const brew = '/opt/homebrew/bin/brew';
    const caskRecipe = {
      kind: 'argv' as const,
      argv: [brew, 'upgrade', '--cask', 'claude-code'],
      runner: brew,
      runnerHint: 'instale o Homebrew',
      env: { SUDO_ASKPASS: '/usr/bin/false', HOMEBREW_NO_SUDO: '1', HOMEBREW_NO_AUTO_UPDATE: '1' },
    };
    let calls: string[][];
    let updateOptions: Record<string, unknown> | undefined;
    let updateError: Error | null;
    let outdatedReply: string;
    const brewFixture = async (lastAttemptAt: number | null, opts: { brewCandidate?: boolean } = {}) => {
      spawnDeps.brewBin = brew;
      calls = [];
      updateOptions = undefined;
      updateError = null;
      outdatedReply = JSON.stringify({ formulae: [], casks: [] });
      if (opts.brewCandidate !== false) {
        const cliAutoUpdateModule = await import('../adapters/cli-auto-update');
        vi.spyOn(cliAutoUpdateModule, 'selectAutomaticCliUpdateRecipe').mockReturnValue(caskRecipe);
      }
      vi.spyOn(fsp, 'readFile').mockImplementation((async (file: unknown) => {
        if (String(file).endsWith('brew-index-update.json')) {
          if (lastAttemptAt === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return JSON.stringify({ lastAttemptAt, ok: true });
        }
        return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      }) as never);
      spawnDeps.execFile.mockImplementation((...args: unknown[]) => {
        const argv = args[1] as string[];
        const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
        if (args[0] === brew) {
          calls.push(argv);
          if (argv[0] === 'update') {
            updateOptions = args[2] as Record<string, unknown>;
            callback(updateError, '');
          } else if (argv[0] === 'outdated') callback(null, outdatedReply);
          else callback(null, '');
        } else if (argv[0] === 'update') {
          calls.push(['claude', ...argv]);
          finishUpdate = () => callback(null, '');
        } else callback(null, '1.0.0');
        return {} as ChildProcess;
      });
    };
    afterEach(() => { spawnDeps.brewBin = null; });
    const brewUpdates = () => calls.filter((argv) => argv[0] === 'update');
    const checkedAgo = () =>
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ enabled: true, checkedAt: { claude: Date.now() - 3 * 60 * 60_000 } }));

    it('sem registro: UM brew update assíncrono antes do brew outdated, com timeout e signal', async () => {
      await brewFixture(null);
      checkedAgo();
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(brewUpdates()).toEqual([['update', '--quiet']]);
      expect(updateOptions?.timeout).toBe(120_000);
      expect(updateOptions?.signal).toBeInstanceOf(AbortSignal);
      const order = calls.map((argv) => argv[0]);
      expect(order.indexOf('update')).toBeLessThan(order.indexOf('outdated'));
      expect(order.indexOf('outdated')).toBeGreaterThan(-1);
      expect(fsp.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('brew-index-update.json'), expect.stringContaining('lastAttemptAt'), expect.anything());
    });

    it.each([
      ['1 h', 60 * 60_000, []],
      ['7 h', 7 * 60 * 60_000, [['update', '--quiet']]],
    ])('última tentativa há %s: limite de 6 h decide', async (_label, ago, expected) => {
      await brewFixture(Date.now() - (ago as number));
      checkedAgo();
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(brewUpdates()).toEqual(expected);
    });

    it('brew update falha: só loga e a passada segue com o índice local', async () => {
      await brewFixture(null);
      checkedAgo();
      updateError = new Error('Command failed: brew update\nfatal: unable to access');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(brewUpdates()).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('brew update falhou'), expect.any(String));
      expect(calls.map((argv) => argv[0])).toContain('outdated');
      warn.mockRestore();
    });

    it('M8: atualização automática desligada não roda brew update', async () => {
      await brewFixture(null);
      const off = JSON.stringify({ enabled: false, askAgainAt: Number.MAX_SAFE_INTEGER, checkedAt: {} });
      vi.spyOn(fs, 'readFileSync').mockReturnValue(off);
      vi.spyOn(periodicFileRead, 'readRegularFileCappedAsync').mockResolvedValue({ kind: 'text', stamp: 'off', text: off });
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(brewUpdates()).toEqual([]);
    });

    it('M8: nenhuma CLI do brew elegível não roda brew update', async () => {
      await brewFixture(null, { brewCandidate: false });
      checkedAgo();
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(brewUpdates()).toEqual([]);
      expect(finishUpdate).toBeTypeOf('function'); // o claude (self-update) segue
    });

  });

  // M8: as checagens só-leitura rodam sem o lease — o spawn da CLI não espera
  // ~40 s por um `npm view` que não grava nada.
  describe('M8: lease só quando há o que instalar', () => {
    const npmOpencode = '/fixture-quota-home/.npm-global/lib/node_modules/opencode-ai/bin/opencode.js';
    it('spawn da CLI npm durante a checagem de versão nasce na hora', async () => {
      spawnDeps.builtinIds.add('opencode');
      vi.spyOn(fs, 'realpathSync').mockReturnValue(npmOpencode);
      vi.spyOn(fsp, 'realpath').mockResolvedValue(npmOpencode);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ enabled: true, checkedAt: { claude: Date.now() } }));
      let replyView: ((stdout: string) => void) | undefined;
      const installs: string[][] = [];
      spawnDeps.execFile.mockImplementation((...args: unknown[]) => {
        const argv = args[1] as string[];
        const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
        if (argv[0] === 'view') replyView = (stdout) => callback(null, stdout);
        else if (argv[0] === 'install' || argv[0] === 'update') {
          installs.push(argv);
          finishUpdate = () => callback(null, '');
        } else callback(null, '1.0.0');
        return {} as ChildProcess;
      });
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(replyView).toBeTypeOf('function');
      let release: (() => void) | undefined;
      void acquireCliSpawnPermit('opencode').then((permit) => { release = permit; });
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toBeTypeOf('function'); // checagem só-leitura: sem lease
      release!();
      replyView!('2.0.0\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(installs.filter((argv) => argv[0] === 'install')).toHaveLength(1);
    });
  });

  // R3: fechar o app com um install em curso não mata o npm no meio nem deixa
  // órfão sem rastro: o stop espera um teto curto; estourado, mata o processo
  // e o marcador faz o próximo boot reinstalar.
  describe('R3: install em curso no encerramento', () => {
    const npmClaude = '/fixture-quota-home/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    let installOptions: Record<string, unknown> | undefined;
    const npmInstallFixture = () => {
      vi.spyOn(fs, 'realpathSync').mockReturnValue(npmClaude);
      vi.spyOn(fsp, 'realpath').mockResolvedValue(npmClaude);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ enabled: true, checkedAt: { claude: Date.now() - 3 * 60 * 60_000 } }));
      installOptions = undefined;
      spawnDeps.execFile.mockImplementation((...args: unknown[]) => {
        const argv = args[1] as string[];
        const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
        if (argv[0] === 'install' || argv[0] === 'update') {
          installOptions = args[2] as Record<string, unknown>;
          finishUpdate = () => callback(null, '');
          // Como o execFile real: o signal mata o processo e o callback vem com erro.
          (installOptions?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
            callback(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), ''));
        } else if (argv[0] === 'view') callback(null, '9.9.9\n');
        else callback(null, '1.0.0');
        return {} as ChildProcess;
      });
    };
    const markerWrites = () => vi.mocked(fsp.writeFile).mock.calls
      .filter((call) => String(call[0]).endsWith('cli-install-inflight.json'));
    const markerRemovals = () => vi.mocked(fsp.rm).mock.calls
      .filter((call) => String(call[0]).endsWith('cli-install-inflight.json'));

    it('stop espera o install terminar dentro do teto e limpa o marcador', async () => {
      npmInstallFixture();
      const running = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finishUpdate).toBeTypeOf('function');
      expect(markerWrites()).toHaveLength(1);
      let stopped = false;
      const stopping = running().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopped).toBe(false); // não abandona o npm no meio
      expect((installOptions?.signal as AbortSignal | undefined)?.aborted).toBe(false);
      finishUpdate!();
      finishUpdate = undefined;
      await vi.advanceTimersByTimeAsync(0);
      await stopping;
      expect(markerRemovals().length).toBeGreaterThan(0);
    });

    it('teto estourado: mata o processo do install e o marcador fica para o boot', async () => {
      npmInstallFixture();
      const running = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finishUpdate).toBeTypeOf('function');
      const stopping = running();
      await vi.advanceTimersByTimeAsync(15_000);
      expect((installOptions?.signal as AbortSignal | undefined)?.aborted).toBe(true);
      // O processo morto (mock não chama o callback) não segura o stop além do teto.
      await vi.advanceTimersByTimeAsync(2_000);
      await stopping;
      finishUpdate = undefined;
      expect(markerRemovals()).toEqual([]);
    });

    it('boot com marcador: a CLI interrompida reinstala já, mesmo checada há 10 min', async () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ enabled: true, checkedAt: { claude: Date.now() - 10 * 60_000 } }));
      vi.spyOn(fsp, 'readFile').mockImplementation((async (file: unknown) =>
        String(file).endsWith('cli-install-inflight.json')
          ? JSON.stringify({ adapterId: 'claude', startedAt: Date.now() - 60_000 })
          : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))) as never);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('instalação interrompida'));
      expect(finishUpdate).toBeTypeOf('function'); // sem o marcador, a de 10 min ficaria de fora
      warn.mockRestore();
    });

    it('Windows: o install por PowerShell também entra no teto do stop e no marcador', async () => {
      let psOptions: Record<string, unknown> | undefined;
      spawnDeps.execFile.mockImplementation((...args: unknown[]) => {
        psOptions = args[2] as Record<string, unknown>;
        (args.at(-1) as (error: null, stdout: string) => void)(null, '');
        return {} as ChildProcess;
      });
      const childSignal = new AbortController().signal;
      const onChildStart = vi.fn();
      await runInstallRecipe({
        kind: 'powershell-script', scriptUrl: 'https://static.devin.ai/cli/setup.ps1',
        runner: 'powershell', runnerHint: '',
      }, undefined, undefined, undefined, { childSignal, onChildStart });
      expect(spawnDeps.execFile.mock.calls.at(-1)?.[1]).toContain('-File');
      expect(onChildStart).toHaveBeenCalledOnce();
      expect(psOptions?.signal).toBe(childSignal);
      expect(psOptions?.shell).toBe(false);
    });
  });

  // F-1571: em 19/10 o `claude update` rodou `npm install -g` com o npm 12,
  // que bloqueou o postinstall e saiu com 0; o Claude virou um stub que sai
  // com 1 e todo pane morria no boot. A atualização nunca deixa a CLI pior.
  describe('F-1571: atualização que deixa a CLI sem responder', () => {
    const npmClaude = '/fixture-quota-home/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    const repairArgv = ['install', '-g', '--prefix', '/fixture-quota-home/.npm-global',
      '--allow-scripts=@anthropic-ai/claude-code', '@anthropic-ai/claude-code'];
    type Call = { argv: string[]; env?: Record<string, string | undefined> };
    let calls: Call[];
    let cli: 'answering' | 'stub' | 'repaired';
    let repairFixes: boolean;
    let updateFails: string | null;
    const claudeSnapshot = () => listProviderSettings().find((info) => info.adapterId === 'claude')?.cliAutoUpdate;
    const fixture = (options: { realPath?: string; checkedAt?: Record<string, number>; start?: 'answering' | 'stub' } = {}) => {
      const realPath = options.realPath ?? npmClaude;
      vi.spyOn(fs, 'realpathSync').mockReturnValue(realPath);
      vi.spyOn(fsp, 'realpath').mockResolvedValue(realPath);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
        enabled: true, checkedAt: options.checkedAt ?? { claude: Date.now() - 3 * 60 * 60_000 },
      }));
      calls = [];
      cli = options.start ?? 'answering';
      repairFixes = true;
      updateFails = null;
      spawnDeps.systemIdleTime.mockReturnValue(0);
      spawnDeps.execFile.mockImplementation((...args: unknown[]) => {
        const argv = args[1] as string[];
        const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
        calls.push({ argv, env: (args[2] as { env?: Record<string, string | undefined> } | undefined)?.env });
        if (argv[0] === 'update') {
          if (updateFails === 'network') {
            callback(new Error('Command failed: claude update\nnetwork unreachable'), '');
          } else {
            cli = 'stub';
            if (updateFails) callback(new Error(`Command failed: claude update\n${updateFails}`), '');
            else callback(null, 'Successfully updated from 1.0.0 to version 1.0.1');
          }
        } else if (argv[0] === 'install') {
          if (repairFixes) cli = 'repaired';
          callback(null, '');
        } else if (argv[0] === '--version') {
          if (cli === 'stub') callback(Object.assign(new Error('Command failed: claude --version'), { code: 1 }), '');
          else callback(null, cli === 'repaired' ? '1.0.1 (Claude Code)' : '1.0.0 (Claude Code)');
        } else callback(null, '');
        return {} as ChildProcess;
      });
    };
    const installs = () => calls.filter((call) => call.argv[0] === 'install');
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => warn.mockRestore());

    it('o claude update de uma instalação npm leva a liberação do postinstall no ambiente', async () => {
      fixture();
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls.find((call) => call.argv[0] === 'update')?.env)
        .toMatchObject({ npm_config_allow_scripts: '@anthropic-ai/claude-code' });
    });

    it('update "bem-sucedido" que deixa o stub reinstala pelo npm do mesmo prefixo, na hora', async () => {
      fixture();
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(installs().map((call) => call.argv)).toEqual([repairArgv]);
      expect(claudeSnapshot()).toMatchObject({
        status: 'updated', fromVersion: '1.0.0 (Claude Code)', toVersion: '1.0.1 (Claude Code)', reason: 'repaired',
      });
    });

    it('update que falha e deixa o stub também é reparado', async () => {
      fixture();
      updateFails = 'Update failed because the native binary for this platform was not downloaded.';
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(installs().map((call) => call.argv)).toEqual([repairArgv]);
      expect(claudeSnapshot()).toMatchObject({ status: 'updated', reason: 'repaired', toVersion: '1.0.1 (Claude Code)' });
    });

    it('update que falha com a CLI ainda respondendo não reinstala nada', async () => {
      fixture();
      updateFails = 'network';
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(installs()).toEqual([]);
      expect(claudeSnapshot()).toMatchObject({ status: 'failed', reason: 'install-failed' });
    });

    it('instalação sem reparo possível (nativa) registra que a atualização quebrou a CLI', async () => {
      fixture({ realPath: '/fixture-quota-home/.local/share/claude/versions/1' });
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(installs()).toEqual([]);
      expect(claudeSnapshot()).toMatchObject({ status: 'failed', fromVersion: '1.0.0 (Claude Code)', reason: 'broke-cli' });
    });

    it('CLI que já respondeu e hoje é stub é reinstalada uma vez por sessão, sem laço', async () => {
      fixture({ start: 'stub' });
      repairFixes = false;
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(installs().map((call) => call.argv)).toEqual([repairArgv]);
      expect(calls.some((call) => call.argv[0] === 'update')).toBe(false); // o stub não roda `claude update`
      expect(claudeSnapshot()).toMatchObject({ status: 'failed', reason: 'broke-cli' });
      spawnDeps.systemIdleTime.mockReturnValue(120);
      for (let hour = 0; hour < 26; hour++) await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(installs()).toHaveLength(1);
    });

    it('o reparo do stub que funciona deixa o painel com "reinstalada"', async () => {
      fixture({ start: 'stub' });
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(installs().map((call) => call.argv)).toEqual([repairArgv]);
      expect(claudeSnapshot()).toMatchObject({ status: 'updated', toVersion: '1.0.1 (Claude Code)', reason: 'repaired' });
      expect(claudeSnapshot()?.fromVersion).toBeUndefined();
    });

    it('CLI que nunca respondeu numa checagem não é reinstalada às cegas', async () => {
      fixture({ start: 'stub', checkedAt: {} });
      stop = startCliAutoUpdate('/fixture-quota-home', () => false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(installs()).toEqual([]);
      expect(calls.some((call) => call.argv[0] === 'update')).toBe(false);
    });
  });

  it.each(['discovery', 'version'])('the daily tick defers installation if the operator returns during %s', async (phase) => {
    // F-1395: o boot (checada há 10 min) pula; o tick diário segue cedendo ao operador.
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ enabled: true, checkedAt: { claude: Date.now() - 10 * 60_000 } }));
    stop = startCliAutoUpdate('/fixture-quota-home', () => false);
    await vi.advanceTimersByTimeAsync(5_000);
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
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
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finishUpdate).toBeUndefined();
  });

  it('releases a waiting pane after updating its launcher without awaiting unrelated CLI discovery', async () => {
    let finishDiscovery!: () => void;
    // F-1397: instalação que troca no lugar (npm) continua excluindo spawns.
    const npmClaudeLauncher = '/fixture-quota-home/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    vi.spyOn(fs, 'realpathSync').mockReturnValue(npmClaudeLauncher);
    vi.spyOn(fsp, 'realpath').mockResolvedValue(npmClaudeLauncher);
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

describe('F-789: o permit da CLI decide o Node do mcode antes do spawn', () => {
  beforeEach(() => {
    minimaxRuntime.prepare.mockReset().mockResolvedValue({ kind: 'default' });
  });

  it('o permit do minimax-code só libera depois da decisão; o de outra CLI não sonda', async () => {
    let finish!: () => void;
    minimaxRuntime.prepare.mockImplementationOnce(() =>
      new Promise((resolve) => { finish = () => resolve({ kind: 'default' }); }));
    let release: (() => void) | undefined;
    const pending = acquireCliSpawnPermit('minimax-code').then((permit) => { release = permit; });
    await vi.waitFor(() => {
      expect(minimaxRuntime.prepare).toHaveBeenCalledWith('/usr/local/bin/mcode', process.env.PATH ?? '');
    });
    expect(release).toBeUndefined();
    finish();
    await pending;
    expect(release).toBeTypeOf('function');
    release!();

    (await acquireCliSpawnPermit('claude'))();
    expect(minimaxRuntime.prepare).toHaveBeenCalledTimes(1);
  });

  it('erro na decisão nunca segura o permit', async () => {
    minimaxRuntime.prepare.mockRejectedValueOnce(new Error('sonda quebrou'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const release = await acquireCliSpawnPermit('minimax-code');
      expect(release).toBeTypeOf('function');
      release();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('caminho quente do PROVIDER_CHANNELS.list (perf #9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnDeps.installationWarnings.clear();
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.hasSecret.mockReturnValue(false);
    spawnDeps.hasCachedSecret.mockReturnValue(false);
    spawnDeps.getSecret.mockReturnValue(null);
    spawnDeps.launcherKey.mockReturnValue(null);
    spawnDeps.subscriptionAuthed.mockReturnValue(true);
    spawnDeps.subscriptionStatusAuthed.mockReturnValue(true);
    spawnDeps.subscriptionStatusUnknown.mockReturnValue(false);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'subscription',
      injectKey: false,
      suppressKeyEnv: true,
    });
    spawnDeps.listAccounts.mockReturnValue([]);
    spawnDeps.quotaSnapshot.mockReturnValue(null);
    spawnDeps.ensureSubscriptionActive.mockReturnValue(true);
  });

  it('decide a auth UMA vez por adapter, não uma vez por modelo', () => {
    listProviderSettings();
    for (const adapterId of ['claude', 'kimi', 'muse', 'opencode']) {
      const calls = spawnDeps.subscriptionAuthed.mock.calls.filter(
        ([id]) => id === adapterId,
      );
      expect(calls, adapterId).toHaveLength(1);
    }
    // AGY sempre sonda pela via de status (cache morno do Keychain).
    const agyCalls = spawnDeps.subscriptionStatusAuthed.mock.calls.filter(
      ([id]) => id === 'agy',
    );
    expect(agyCalls).toHaveLength(1);
  });

  it('mimo-code continua model-aware (produto/região por modelo)', () => {
    listProviderSettings();
    const mimoCalls = spawnDeps.subscriptionAuthed.mock.calls.filter(
      ([id]) => id === 'mimo-code',
    );
    // Um por modelo ofertado + o default efetivo.
    expect(mimoCalls.length).toBeGreaterThan(1);
  });

  it('lê o aviso de instalação do cache de descoberta, sem re-resolver o binário no PATH', () => {
    spawnDeps.installationWarnings.set(
      'claude',
      '2 instalações: 5.5.0 e 5.6.0; usando 5.6.0',
    );
    const list = listProviderSettings();
    expect(
      list.find((p) => p.adapterId === 'claude')?.cliInstallationWarning,
    ).toBe('2 instalações: 5.5.0 e 5.6.0; usando 5.6.0');
    expect(spawnDeps.resolveCliBinary).not.toHaveBeenCalled();
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

  it('injects the saved native Muse account key and suppresses inherited keys for OAuth', () => {
    const account = { id: 'muse-key', adapterId: 'muse', label: 'Meta API', mode: 'api-key', upstream: 'anthropic', createdAt: 1 };
    spawnDeps.prepareAccount.mockReturnValueOnce({ ok: true, account, apiKey: 'synthetic-meta-key', authEnv: {} });
    expect(prepareProviderSpawn('muse', { accountId: account.id })).toMatchObject({
      ok: true, overrides: { keyEnv: { META_API_KEY: 'synthetic-meta-key' }, suppressEnv: [] },
    });
    expect(prepareProviderSpawn('muse')).toMatchObject({
      ok: true, overrides: { keyEnv: {}, suppressEnv: ['META_API_KEY'] },
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

  it('F-1485: o pane direto do operador abre o Grok com a sessão vencida para aprovar o login; o resto segue barrado', () => {
    spawnDeps.subscriptionAuthed.mockReturnValue(false);
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.resolveAuthStrategy.mockReturnValue({
      strategy: 'login-needed', injectKey: false, suppressKeyEnv: false,
    });
    spawnDeps.listAccounts.mockReturnValue([]);
    expect(prepareProviderSpawn('grok', { allowNativeAuthAttempt: true })).toMatchObject({ ok: true });
    expect(prepareProviderSpawn('grok', {}).ok).toBe(false);
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

  it.each([false, true])('real Claude status provenance keeps API fallback and native subscription precedence (native=%s)', async native => {
    const actual = await vi.importActual<typeof import('../adapters/subscription-auth')>('../adapters/subscription-auth');
    spawnDeps.runtimeKey.mockReturnValue(null); // This fixture is API-env-only, not the unrelated vault key.
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-api-key'); vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:34567');
    const status = native ? { loggedIn: true, authMethod: 'claude.ai', apiKeySource: null } :
      { loggedIn: true, authMethod: 'oauth_token', apiKeySource: 'env-api-key' };
    spawnDeps.resolveAuthStrategy.mockImplementation(actual.resolveAuthStrategy);
    spawnDeps.subscriptionAuthed.mockImplementation(() => actual.claudeCliAuthStatusLoggedInSync(
      (() => JSON.stringify(status)) as unknown as typeof import('node:child_process').execFileSync, '/fixture/claude'));
    const result = prepareProviderSpawn('claude');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fixture preparation refused');
    if (native) {
      expect(result.overrides.suppressEnv).toContain('ANTHROPIC_API_KEY');
      expect(result.overrides.suppressEnv).toContain('ANTHROPIC_BASE_URL');
      expect(result.overrides.keyEnv).toEqual({}); // Native store stays in place (F-645).
    } else {
      expect(result.overrides.suppressEnv).toEqual([]);
      expect(result.overrides.keyEnv).toEqual({ ANTHROPIC_API_KEY: 'fixture-api-key' });
    }
    expect(process.env.ANTHROPIC_API_KEY).toBe('fixture-api-key');
    expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:34567');
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

  it('a conta ativa permanece quando há contas Claude (comportamento atual)', () => {
    const acctA = { id: 'acct-a', adapterId: 'claude', label: 'Conta A',
      mode: 'subscription', upstream: 'anthropic', email: 'a@example.com', createdAt: 1 };
    spawnDeps.listAccounts.mockReturnValue([acctA]);
    spawnDeps.getActiveAccount.mockReturnValue(acctA);
    spawnDeps.getAccount.mockReturnValue(acctA);
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account: acctA });
    spawnDeps.prepareAccount.mockReturnValue({ ok: true, account: acctA,
      authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/accounts/claude/a' } });

    expect(prepareProviderSpawn('claude')).toMatchObject({
      ok: true, overrides: { selectedAccountId: 'acct-a' },
    });
    expect(spawnDeps.pickAvailableForFailover).toHaveBeenCalledWith(
      'claude', null, expect.any(Number), undefined,
      expect.objectContaining({ drain: expect.objectContaining({ requireSource: 'provider-api', maxAgeMs: expect.any(Number) }), model: 'claude-sonnet' }),
    );
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

  // F-1637: o pane da conta em uso abre com o token que só o relógio venceu;
  // a recusa sobra para quando a conta precisa mesmo de login, e nomeia ela.
  it.each([
    ['renewable', true],
    ['auth-expired', false],
    ['auth-unproven', false],
  ] as const)('Claude identity %s: pane opens = %s', async (identity, opens) => {
    const account = { id: 'acct-b', adapterId: 'claude', label: 'conta b',
      mode: 'subscription', upstream: 'anthropic', email: 'b@example.com', createdAt: 1 };
    spawnDeps.listAccounts.mockReturnValue([account]);
    spawnDeps.getActiveAccount.mockReturnValue(account);
    spawnDeps.getAccount.mockReturnValue(account);
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account });
    spawnDeps.prepareAccount.mockReturnValue({ ok: true, account,
      authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/accounts/claude/b' } });
    spawnDeps.verifyClaudeAccount.mockImplementationOnce(async (_id, onVerified) => {
      onVerified?.('expired-renewable-blob');
      return identity;
    });

    const prepared = await prepareProviderSpawnAuthoritative('claude');
    if (opens) {
      expect(prepared).toMatchObject({ ok: true, overrides: { selectedAccountId: 'acct-b' } });
      // A credencial verificada é a que o materialize fixa (F-1401).
      expect(spawnDeps.prepareAccount.mock.calls.at(-1)?.[3])
        .toMatchObject({ expectedClaudeBlob: 'expired-renewable-blob' });
    } else if (identity === 'auth-expired') {
      expect(prepared).toMatchObject({ ok: false,
        error: expect.stringMatching(/“conta b” expirou — use «Entrar novamente» nessa conta/),
        // A conta CERTA chega ao cartão do pane: só id e rótulo, sem e-mail.
        relogin: { adapterId: 'claude', accountId: 'acct-b', accountLabel: 'conta b' } });
      expect(JSON.stringify(prepared)).not.toContain('b@example.com');
      expect(spawnDeps.prepareAccount).not.toHaveBeenCalled();
    } else {
      // Sem prova de sessão morta: recusa, mas nem diz "expirou" nem oferece o
      // login em um clique (revisão do PR #165).
      expect(prepared).toMatchObject({ ok: false,
        error: expect.stringMatching(/Não deu para confirmar a sessão de “conta b”/) });
      expect(prepared).not.toHaveProperty('relogin');
      expect(spawnDeps.prepareAccount).not.toHaveBeenCalled();
    }
  });

  it('rótulo de conta no limite de 128 caracteres ainda chega ao botão do pane', async () => {
    const label = 'c'.repeat(128);
    const account = { id: 'acct-long', adapterId: 'claude', label,
      mode: 'subscription', upstream: 'anthropic', email: 'l@example.com', createdAt: 1 };
    spawnDeps.listAccounts.mockReturnValue([account]);
    spawnDeps.getActiveAccount.mockReturnValue(account);
    spawnDeps.getAccount.mockReturnValue(account);
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account });
    spawnDeps.verifyClaudeAccount.mockResolvedValueOnce('auth-expired');

    const prepared = await prepareProviderSpawnAuthoritative('claude');
    expect(parseAccountReloginRequest((prepared as { relogin?: unknown }).relogin))
      .toMatchObject({ accountId: 'acct-long', accountLabel: label });
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

  describe('F-1401: credencial Claude girada no meio do spawn refaz verify+prepare', () => {
    // Mesma string que materializeManagedClaudeAuth lança quando o blob
    // materializado diverge do verificado (pane irmão renovou o token).
    const CREDENTIAL_CHANGED =
      'managed Claude credential changed after verified profile; retry spawn';
    const account = { id: 'acct-r', adapterId: 'claude', label: 'Conta R',
      mode: 'subscription', upstream: 'anthropic', email: 'r@example.com', createdAt: 1 };

    beforeEach(() => {
      spawnDeps.listAccounts.mockReturnValue([account]);
      spawnDeps.getActiveAccount.mockReturnValue(account);
      spawnDeps.getAccount.mockReturnValue(account);
    });

    it('revalida o perfil e tenta o prepare de novo quando a credencial girou', async () => {
      spawnDeps.prepareAccount
        .mockReturnValueOnce({ ok: false, error: CREDENTIAL_CHANGED })
        .mockReturnValue({ ok: true, account,
          authEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/accounts/claude/r' } });

      await expect(prepareProviderSpawnAuthoritative('claude', { accountId: account.id }))
        .resolves.toMatchObject({ ok: true });
      expect(spawnDeps.verifyClaudeAccount).toHaveBeenCalledTimes(2);
      expect(spawnDeps.prepareAccount).toHaveBeenCalledTimes(2);
    });

    it('não tenta de novo para outros erros do prepare', async () => {
      spawnDeps.prepareAccount.mockReturnValue({ ok: false, error: 'Conta R precisa de login' });

      await expect(prepareProviderSpawnAuthoritative('claude', { accountId: account.id }))
        .resolves.toMatchObject({ ok: false, error: 'Conta R precisa de login' });
      expect(spawnDeps.verifyClaudeAccount).toHaveBeenCalledTimes(1);
      expect(spawnDeps.prepareAccount).toHaveBeenCalledTimes(1);
    });

    it('esgota as tentativas e devolve o último erro', async () => {
      spawnDeps.prepareAccount.mockReturnValue({ ok: false, error: CREDENTIAL_CHANGED });

      await expect(prepareProviderSpawnAuthoritative('claude', { accountId: account.id }))
        .resolves.toMatchObject({ ok: false, error: CREDENTIAL_CHANGED });
      // 1 tentativa inicial + 2 retentativas, revalidando o perfil em cada uma.
      expect(spawnDeps.verifyClaudeAccount).toHaveBeenCalledTimes(3);
      expect(spawnDeps.prepareAccount).toHaveBeenCalledTimes(3);
    });
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

  it('Windows: a dona da vaga DRENANDO também cede, antes de esgotar (camada 1)', async () => {
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
      // 90% medido pelo provedor, leitura fresca: drenando, não esgotada.
      spawnDeps.quotaSnapshot.mockReturnValue({
        entries: [{
          adapterId: 'agy', accountId: 'agy-slot', updatedAt: Date.now(), onCooldown: false,
          windows: [{
            kind: 'hours', label: '5 Horas', usedRatio: 0.9,
            source: 'provider-api', confidence: 'high',
          }],
        }],
      } as never);
      spawnDeps.pickAvailableForFailover.mockReturnValue({ account: null, probe: false });

      const drained = await prepareProviderSpawnAuthoritative('agy', { model: 'gemini-3.6-flash-high' });
      expect(drained).toMatchObject({ ok: true });
      expect((drained as { overrides: { accountChoice: { source: string } } }).overrides.accountChoice.source)
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
    // F-995: além do escore, a regra recebe as janelas por conta.
    expect(spawnDeps.pickAvailableForFailover).toHaveBeenCalledWith(
      'kimi',
      null,
      expect.any(Number),
      expect.any(Map),
      expect.objectContaining({ quotaByAccountId: expect.any(Map), drain: expect.objectContaining({ requireSource: 'provider-api', maxAgeMs: expect.any(Number) }) }),
    );
    const scores = spawnDeps.pickAvailableForFailover.mock.calls[0]?.[3] as Map<
      string,
      number
    >;
    expect(scores.get('kimi-b')).toBeGreaterThan(scores.get('kimi-a') ?? 0);
  });

  it('drenagem: o recibo diz por que a conta mudou, com rótulo mascarado', () => {
    spawnDeps.listAccounts.mockReturnValue([
      kimiAccount('kimi-a', 'Conta A', 1),
      kimiAccount('kimi-b', 'Conta B', 2),
    ]);
    spawnDeps.getActiveAccount.mockReturnValue(kimiAccount('kimi-a', 'Conta A', 1));
    spawnDeps.pickAvailableForFailover.mockReturnValue({
      account: kimiAccount('kimi-b', 'Conta B', 2),
      probe: false,
      drained: true,
    });

    const result = prepareProviderSpawn('kimi');
    const receipt = (result as { overrides: { accountChoice?: { note?: string; account?: { label: string } } } })
      .overrides.accountChoice;
    expect(receipt?.note).toMatch(/limiar/i);
    expect(receipt?.account?.label).not.toBe('Conta B');
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
    qwenSettingsProbe.readiness = 'unknown';
    vi.stubEnv('BAILIAN_TOKEN_PLAN_API_KEY', '');
    vi.stubEnv('DASHSCOPE_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_BASE_URL', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); qwenSettingsProbe.readiness = 'unknown'; });

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

  it('opencode still accepts a bare OPENAI_API_KEY (the host gate is only for qwen)', () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-openai-key');
    expect(resolveRuntimeApiKey('opencode')).toBe('fixture-openai-key');
  });

  it('qwen accepts its own BAILIAN/DASHSCOPE env vars without a host gate', () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'fixture-dashscope-key');
    expect(resolveRuntimeApiKey('qwen')).toBe('fixture-dashscope-key');
  });

  it('qwen has no runtime key when nothing is configured', () => {
    expect(hasRuntimeKey('qwen')).toBe(false);
  });
  it('reports a rejected configured key and removes its models, while native and managed accounts remain eligible', () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'configured-key');
    spawnDeps.resolveAuthStrategy.mockReturnValue({ strategy: 'api-key', injectKey: true, suppressKeyEnv: false });
    spawnDeps.listAccounts.mockReturnValue([]);
    qwenSettingsProbe.readiness = 'invalid-credential';
    expect(providerReadiness('qwen')).toMatchObject({ ready: false, reason: expect.stringContaining('chave inválida') });
    expect(listProviderSettings().find(p => p.adapterId === 'qwen')).toMatchObject({ hasKey: true, authReadyModels: [], credentialReadiness: 'invalid-credential' });
    spawnDeps.listAccounts.mockReturnValue([{ id: 'managed-qwen' }]);
    expect(providerReadiness('qwen').ready).toBe(true);
    expect(listProviderSettings().find(p => p.adapterId === 'qwen')?.credentialReadiness).toBeUndefined();
    spawnDeps.listAccounts.mockReturnValue([]);
    spawnDeps.resolveAuthStrategy.mockReturnValue({ strategy: 'subscription', injectKey: false, suppressKeyEnv: true });
    expect(providerReadiness('qwen').ready).toBe(true);
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

  it('F-995: conta fixada não concorreu — a irmã livre aparece como "não comparada", nunca "menos folga"', () => {
    const pinned = kimiAccount('kimi-co', 'cobrancade@corp.com', 1);
    spawnDeps.prepareAccount.mockReturnValueOnce({
      ok: true,
      account: pinned,
      apiKey: 'sk-pinned',
      authEnv: {},
    });
    spawnDeps.listAccounts.mockReturnValue([
      pinned,
      kimiAccount('kimi-re', 'reno@corp.com', 2),
    ]);
    spawnDeps.quotaSnapshot.mockReturnValue(
      quotaEntries([
        {
          adapterId: 'kimi',
          accountId: 'kimi-co',
          windows: [
            { kind: 'hours', label: '5 Horas', usedRatio: null },
            { kind: 'weekly', label: 'Semanal', usedRatio: 0.19, resetsAt: 1_791_658_799_908 },
          ],
        },
        {
          adapterId: 'kimi',
          accountId: 'kimi-re',
          windows: [
            { kind: 'hours', label: '5 Horas', usedRatio: 0, resetsAt: 1_791_420_599_886 },
            { kind: 'weekly', label: 'Semanal', usedRatio: null },
          ],
        },
      ]),
    );

    const result = prepareProviderSpawn('kimi', { accountId: 'kimi-co' });

    const receipt = (result as { overrides: { accountChoice?: unknown } })
      .overrides.accountChoice as {
      source: string;
      headroom: { usedPct: number; window: string; resetsAt: number };
      alternatives: Array<{ label: string; skipped: string; window: string | null }>;
    };
    expect(receipt.source).toBe('pinned');
    // A janela que limita é a medida (Semanal), com o reset dela.
    expect(receipt.headroom).toMatchObject({ usedPct: 19, window: 'Semanal', resetsAt: 1_791_658_799_908 });
    expect(receipt.alternatives).toEqual([
      expect.objectContaining({ label: 'r•••@c•••.com', skipped: 'not-compared', window: '5 Horas' }),
    ]);
  });

  it('F-995: ativa mantida com irmã MAIS livre em janelas comparáveis — recibo diz "active-kept"', () => {
    const active = kimiAccount('kimi-a', 'ana@corp.com', 1);
    const sibling = kimiAccount('kimi-b', 'bia@corp.com', 2);
    spawnDeps.listAccounts.mockReturnValue([active, sibling]);
    spawnDeps.getActiveAccount.mockReturnValue(active);
    spawnDeps.quotaSnapshot.mockReturnValue(
      quotaEntries([
        {
          adapterId: 'kimi',
          accountId: 'kimi-a',
          windows: [{ kind: 'hours', label: '5 Horas', usedRatio: 0.6 }],
        },
        {
          adapterId: 'kimi',
          accountId: 'kimi-b',
          windows: [{ kind: 'hours', label: '5 Horas', usedRatio: 0.1 }],
        },
      ]),
    );
    spawnDeps.pickAvailableForFailover.mockReturnValue({ account: active });

    const result = prepareProviderSpawn('kimi');

    // A regra de folga recebe as janelas por conta, não só o escore escalar.
    expect(spawnDeps.pickAvailableForFailover).toHaveBeenCalledWith(
      'kimi', null, expect.any(Number), expect.any(Map),
      expect.objectContaining({ quotaByAccountId: expect.any(Map), drain: expect.objectContaining({ requireSource: 'provider-api', maxAgeMs: expect.any(Number) }) }),
    );
    const receipt = (result as { overrides: { accountChoice?: unknown } })
      .overrides.accountChoice as {
      source: string;
      alternatives: Array<{ label: string; skipped: string }>;
    };
    expect(receipt.source).toBe('active');
    expect(receipt.alternatives).toEqual([
      expect.objectContaining({ label: 'b•••@c•••.com', skipped: 'active-kept' }),
    ]);
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
    // C6: o download manual sempre leva o signal do prazo de 120 s.
    expect(spawnDeps.downloadInstaller).toHaveBeenCalledWith(
      'https://claude.ai/install.sh', { signal: expect.any(AbortSignal) });
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

// F-1571: o stub que o npm 12 deixou no lugar do Claude não roda `claude
// update` — o botão precisa reinstalar pelo npm, mostrando esse comando.
describe('F-1571: "Atualizar CLI" com o Claude npm sem responder', () => {
  const update = () => spawnDeps.trustedHandlers.get(PROVIDER_CHANNELS.installCli)!({}, { adapterId: 'claude', mode: 'update' });
  const npmClaude = '/fixture-quota-home/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js';
  const repairArgv = ['install', '-g', '--prefix', '/fixture-quota-home/.npm-global',
    '--allow-scripts=@anthropic-ai/claude-code', '@anthropic-ai/claude-code'];
  let cli: 'answering' | 'stub' | 'repaired';
  let argvs: string[][];
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    spawnDeps.resolvedClaudeBin = '/usr/local/bin/claude';
    spawnDeps.confirmInstall.mockClear();
    spawnDeps.rescanBinaries.mockReset().mockResolvedValue([]);
    vi.spyOn(fs, 'realpathSync').mockReturnValue(npmClaude);
    argvs = [];
    spawnDeps.execFile.mockReset().mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
      argvs.push(argv);
      if (argv[0] === 'update') cli = 'stub';
      if (argv[0] === 'install') cli = 'repaired';
      if (argv[0] === '--version' && cli === 'stub') callback(new Error('Command failed: claude --version'), '');
      else callback(null, cli === 'repaired' ? '1.0.1 (Claude Code)' : '1.0.0 (Claude Code)');
      return {} as ChildProcess;
    });
    registerProviderIpc();
  });
  afterEach(() => vi.restoreAllMocks());

  it('reinstala pelo npm do mesmo prefixo em vez de rodar o claude update no stub', async () => {
    cli = 'stub';
    await expect(update()).resolves.toMatchObject({ ok: true, version: '1.0.1 (Claude Code)' });
    expect(argvs.filter((argv) => argv[0] === 'install')).toEqual([repairArgv]);
    expect(argvs.some((argv) => argv[0] === 'update')).toBe(false);
    const detail = (spawnDeps.confirmInstall.mock.calls.at(-1)?.at(-1) as { detail?: string } | undefined)?.detail;
    expect(detail).toContain('--allow-scripts=@anthropic-ai/claude-code');
  });

  it('update que deixa a CLI sem responder diz ao operador que o próximo clique a reinstala', async () => {
    cli = 'answering';
    await expect(update()).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('Clique em "Atualizar CLI" de novo'),
    });
    expect(argvs.some((argv) => argv[0] === 'update')).toBe(true);
    expect(argvs.some((argv) => argv[0] === 'install')).toBe(false);
  });
});

// C6: na instalação manual (sem signal do updater) o prazo de 120 s precisa
// abortar o download de verdade — rejeitar a promise e deixar o fetch vivo
// mantinha a conexão aberta depois do "tempo esgotado".
describe('C6: prazo do download do instalador manual aborta o fetch', () => {
  const install = () => spawnDeps.trustedHandlers.get(PROVIDER_CHANNELS.installCli)!({}, { adapterId: 'claude', mode: 'install' });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    spawnDeps.resolvedClaudeBin = null;
    spawnDeps.rescanBinaries.mockReset().mockResolvedValue([]);
    registerProviderIpc();
  });
  afterEach(() => {
    spawnDeps.resolvedClaudeBin = '/usr/local/bin/claude';
    spawnDeps.downloadInstaller.mockReset().mockImplementation(async () => ({ ok: true, text: async () => '#!/bin/bash\nexit 0\n' }));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('download pendente: o prazo aborta o signal do net.fetch', async () => {
    let fetchSignal: AbortSignal | undefined;
    spawnDeps.downloadInstaller.mockImplementation(((_url: string, init?: { signal?: AbortSignal }) => {
      fetchSignal = init?.signal;
      return new Promise(() => {});
    }) as never);
    const result = install();
    await vi.advanceTimersByTimeAsync(0);
    expect((spawnDeps.downloadInstaller.mock.calls[0] as unknown[] | undefined)?.[0]).toBe('https://claude.ai/install.sh');
    expect(fetchSignal).toBeInstanceOf(AbortSignal);
    expect(fetchSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(fetchSignal?.aborted).toBe(true);
  });
});

// C5: ligar o toggle de atualização automática lê o manifesto de cada cask.
// O `brew info` síncrono (até 10 s por cask) congelava o Main; a descoberta
// do handler usa o caminho assíncrono, com o mesmo env de segurança (B1).
describe('C5: toggle de atualização automática não bloqueia o Main', () => {
  const caskClaude = '/opt/homebrew/Caskroom/claude-code/2.1.296/claude';
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    spawnDeps.builtinIds.clear();
    spawnDeps.builtinIds.add('claude');
    spawnDeps.brewBin = '/opt/homebrew/bin/brew';
    spawnDeps.resolvedClaudeBin = '/usr/local/bin/claude';
    spawnDeps.rescanBinaries.mockReset().mockResolvedValue([]);
    spawnDeps.confirmInstall.mockClear();
    spawnDeps.windows = [];
    vi.spyOn(fs, 'realpathSync').mockReturnValue(caskClaude);
    vi.spyOn(fsp, 'realpath').mockResolvedValue(caskClaude);
    spawnDeps.execFileSync.mockClear();
    spawnDeps.execFile.mockReset().mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error | null, stdout: string) => void)(null, '');
      return {} as ChildProcess;
    });
    registerProviderIpc();
  });
  afterEach(() => {
    spawnDeps.brewBin = null;
    vi.restoreAllMocks();
  });
  it('o manifesto do cask sai por execFile assíncrono, nunca execFileSync', async () => {
    const handler = spawnDeps.trustedHandlers.get(PROVIDER_CHANNELS.autoCliUpdates)!;
    await handler({}, { action: 'set', enabled: true });
    const brewSync = spawnDeps.execFileSync.mock.calls.filter((call) => call[0] === '/opt/homebrew/bin/brew');
    expect(brewSync).toEqual([]);
    expect(spawnDeps.execFile).toHaveBeenCalledWith(
      '/opt/homebrew/bin/brew',
      ['info', '--cask', '--json=v2', 'claude-code'],
      expect.objectContaining({
        env: expect.objectContaining({ HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_SUDO: '1' }),
      }),
      expect.any(Function),
    );
  });
});

// M8: um brew que grava por vez — o `brew install` do botão (e do
// provisionamento) espera o `brew update` do passe, sem "Another active
// Homebrew update process".
describe('M8: brew update e brew install serializados', () => {
  const brew = '/opt/homebrew/bin/brew';
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    spawnDeps.brewBin = brew;
    spawnDeps.resolvedClaudeBin = '/usr/local/bin/claude';
    spawnDeps.rescanBinaries.mockReset().mockResolvedValue([]);
    registerProviderIpc();
  });
  afterEach(() => {
    spawnDeps.brewBin = null;
    vi.restoreAllMocks();
  });
  it('install do botão só roda depois do brew update em curso', async () => {
    vi.spyOn(fsp, 'readFile').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    vi.spyOn(fsp, 'writeFile').mockResolvedValue(undefined);
    const calls: string[][] = [];
    let finishBrewUpdate: (() => void) | undefined;
    spawnDeps.execFile.mockReset().mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
      if (args[0] === brew) {
        calls.push(argv);
        if (argv[0] === 'update') finishBrewUpdate = () => callback(null, '');
        else callback(null, '');
      } else callback(null, '1.0.0');
      return {} as ChildProcess;
    });
    const refreshing = refreshBrewIndexIfDue('/fixture-quota-home', new AbortController().signal);
    await vi.waitFor(() => expect(finishBrewUpdate).toBeTypeOf('function'));
    const installing = spawnDeps.trustedHandlers.get(PROVIDER_CHANNELS.installCli)!({}, { adapterId: 'opencode', mode: 'install' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((argv) => argv[0] === 'install')).toEqual([]);
    finishBrewUpdate!();
    await refreshing;
    await installing;
    expect(calls.map((argv) => argv[0])).toEqual(['update', 'install']);
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

describe('F-1567: spawn do Qwen carrega o descritor de injeção do overlay', () => {
  const PLAN = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  const noSettings: import('../adapters/qwen-settings').QwenSettingsSummary = {
    hasCredential: false, baseUrl: null, authBaseUrl: null, tokenPlan: false, modelIds: [],
  };

  beforeAll(() => initializeProviderConfigStore());
  beforeEach(() => {
    vi.clearAllMocks();
    spawnDeps.runtimeKey.mockReturnValue(null);
    spawnDeps.hasSecret.mockReturnValue(false);
    spawnDeps.hasCachedSecret.mockReturnValue(false);
    spawnDeps.launcherKey.mockReturnValue(null);
    spawnDeps.listAccounts.mockReturnValue([]);
    qwenSettingsProbe.hasCredential.mockReturnValue(false);
    qwenSettingsProbe.readiness = 'unknown';
    qwenSettingsProbe.summary = noSettings;
    spawnDeps.resolveAuthStrategy.mockReturnValue({ strategy: 'api-key', injectKey: true, suppressKeyEnv: false });
    vi.stubEnv('BAILIAN_TOKEN_PLAN_API_KEY', '');
    vi.stubEnv('DASHSCOPE_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_BASE_URL', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); qwenSettingsProbe.readiness = 'unknown'; });

  it('chave sk-sp- do cofre: keyEnv aleatório por spawn + descritor com a URL exclusiva do plano', () => {
    spawnDeps.runtimeKey.mockReturnValue('sk-sp-fixture-cofre');
    const result = prepareProviderSpawn('qwen', { model: 'qwen3.8-max' });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.overrides.qwenSettingsInjection).toMatchObject({
      baseUrl: PLAN,
      tokenPlanKey: true,
    });
    const envKey = result.overrides.qwenSettingsInjection?.envKey;
    expect(envKey).toMatch(/^NEXUS_QWEN_KEY_[a-f0-9]{32}$/i);
    expect(result.overrides.keyEnv).toEqual({ [envKey!]: 'sk-sp-fixture-cofre' });
    expect(result.overrides.qwenSettingsInjection?.models).toContain('qwen3.8-max');
  });

  it('404 "Model not exist": no Token Plan o deepseek-flash vira deepseek-v4.1-flash-1017 e o catálogo gerado só tem o que o plano serve', () => {
    spawnDeps.runtimeKey.mockReturnValue('sk-sp-fixture-cofre');
    const result = prepareProviderSpawn('qwen', { model: 'deepseek-flash' });
    if (!result.ok) throw new Error('spawn falhou');
    expect(result.overrides.modelAliases).toMatchObject({
      'deepseek-flash': 'deepseek-v4.1-flash-1017',
      'deepseek-v4-flash': 'deepseek-v4.1-flash-1017',
    });
    const models = result.overrides.qwenSettingsInjection?.models ?? [];
    expect(models).toContain('deepseek-v4.1-flash-1017');
    expect(models).toContain('deepseek-v4-pro');
    expect(models).not.toContain('deepseek-flash');
  });

  it('o id completo pedido pela pessoa (deepseek-v4.1-flash-1017) passa como está e entra no catálogo gerado', () => {
    spawnDeps.runtimeKey.mockReturnValue('sk-sp-fixture-cofre');
    const result = prepareProviderSpawn('qwen', { model: 'deepseek-v4.1-flash-1017' });
    if (!result.ok) throw new Error('spawn falhou');
    expect(Object.keys(result.overrides.modelAliases ?? {})).not.toContain('deepseek-v4.1-flash-1017');
    expect(result.overrides.qwenSettingsInjection?.models).toContain('deepseek-v4.1-flash-1017');
  });

  it('fora do plano (DashScope padrão) o id não é trocado', () => {
    spawnDeps.runtimeKey.mockReturnValue('sk-fixture-padrao');
    const result = prepareProviderSpawn('qwen', { model: 'qwen3.8-max' });
    if (!result.ok) throw new Error('spawn falhou');
    expect(result.overrides.modelAliases).toBeUndefined();
  });

  it('N1: dois spawns não reutilizam o nome da variável do cofre', () => {
    spawnDeps.runtimeKey.mockReturnValue('sk-sp-fixture-cofre');
    const first = prepareProviderSpawn('qwen', {});
    const second = prepareProviderSpawn('qwen', {});
    if (!first.ok || !second.ok) throw new Error('spawn falhou');
    expect(first.overrides.qwenSettingsInjection?.envKey)
      .not.toBe(second.overrides.qwenSettingsInjection?.envKey);
  });

  it('chave padrão (sk-) com settings no dashscope-intl: a base do settings vence; sem settings, o padrão DashScope', () => {
    qwenSettingsProbe.summary = {
      hasCredential: true, baseUrl: null,
      authBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      tokenPlan: false, modelIds: [],
    } as never;
    spawnDeps.runtimeKey.mockReturnValue('sk-fixture-padrao');
    const withSettings = prepareProviderSpawn('qwen', {});
    if (!withSettings.ok) throw new Error('spawn falhou');
    expect(withSettings.overrides.qwenSettingsInjection).toMatchObject({
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      tokenPlanKey: false,
    });
    qwenSettingsProbe.summary = noSettings;
    const semSettings = prepareProviderSpawn('qwen', {});
    if (!semSettings.ok) throw new Error('spawn falhou');
    expect(semSettings.overrides.qwenSettingsInjection?.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  });

  it('A1: base URL do settings fora dos hosts conhecidos (http, userinfo, host qualquer) nunca vira destino da chave, e o descarte deixa rastro sem a URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    spawnDeps.runtimeKey.mockReturnValue('sk-sp-fixture-cofre');
    for (const url of [
      'http://attacker.test/v1',
      'https://attacker.test/v1',
      'https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1',
      'ftp://dashscope.aliyuncs.com/v1',
      'not a url',
    ]) {
      warn.mockClear();
      qwenSettingsProbe.summary = { ...noSettings, authBaseUrl: url };
      const result = prepareProviderSpawn('qwen', {});
      if (!result.ok) throw new Error('spawn falhou');
      expect(result.overrides.qwenSettingsInjection?.baseUrl).toBe(PLAN);
      // O rastro diz onde configurar o proxy e nunca repete a URL (pode ter token).
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain('Providers › Qwen › Avançado › Base URL da API');
      expect(line).not.toMatch(/user:pass|\/v1/);
    }
    warn.mockRestore();
    // Chave padrão: sem destino aproveitável, a CLI usa o padrão DashScope dela.
    spawnDeps.runtimeKey.mockReturnValue('sk-fixture-padrao');
    qwenSettingsProbe.summary = { ...noSettings, baseUrl: 'https://attacker.test/v1' };
    const standard = prepareProviderSpawn('qwen', {});
    if (!standard.ok) throw new Error('spawn falhou');
    expect(standard.overrides.qwenSettingsInjection?.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  });

  it('M5: URL regional válida do plano no settings (Token Plan de Pequim) não é sobrescrita pela de Singapura', () => {
    const PLAN_CN = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
    qwenSettingsProbe.summary = { ...noSettings, authBaseUrl: PLAN_CN };
    spawnDeps.runtimeKey.mockReturnValue('sk-sp-fixture-cofre');
    const result = prepareProviderSpawn('qwen', {});
    if (!result.ok) throw new Error('spawn falhou');
    expect(result.overrides.qwenSettingsInjection).toMatchObject({ baseUrl: PLAN_CN, tokenPlanKey: true });
  });

  it('URL do settings aproveitada (host conhecido) não gera rastro de descarte', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      qwenSettingsProbe.summary = {
        ...noSettings,
        authBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      };
      spawnDeps.runtimeKey.mockReturnValue('sk-fixture-padrao');
      const result = prepareProviderSpawn('qwen', {});
      if (!result.ok) throw new Error('spawn falhou');
      expect(result.overrides.qwenSettingsInjection?.baseUrl).toBe(
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  const dialogs = () =>
    spawnDeps.confirmInstall.mock.calls.map(
      (call) => call[0] as { type?: string; title?: string; message?: string; detail?: string },
    );

  it('a base URL de Providers › Qwen › Avançado vence o settings; a confirmação nativa fala de enviar a chave, não de FULL AUTO', async () => {
    spawnDeps.runtimeKey.mockReturnValue('sk-sp-fixture-cofre');
    const setConfig = spawnDeps.trustedHandlers.get('provider:setConfig')!;
    try {
      await setConfig(null, { adapterId: 'qwen', baseUrl: 'https://proxy.da.empresa.example/v1' });
      expect(spawnDeps.confirmInstall).toHaveBeenCalledTimes(1);
      const [confirm] = dialogs();
      expect(confirm!.type).toBe('warning');
      expect(confirm!.detail).toContain('Base URL da API: https://proxy.da.empresa.example/v1');
      expect(confirm!.detail).toMatch(/chave configurada deste provider passará a ser ENVIADA/);
      // O texto de FULL AUTO / execução é de permissão e binário, não de URL.
      expect(confirm!.detail).not.toMatch(/FULL AUTO|EXECUTAR|sandbox/);
      const result = prepareProviderSpawn('qwen', {});
      if (!result.ok) throw new Error('spawn falhou');
      expect(result.overrides.qwenSettingsInjection?.baseUrl).toBe('https://proxy.da.empresa.example/v1');
      // a listagem expõe o campo salvo para o renderer
      expect(listProviderSettings().find((p) => p.adapterId === 'qwen')?.baseUrl)
        .toBe('https://proxy.da.empresa.example/v1');
    } finally {
      spawnDeps.confirmInstall.mockClear();
      await setConfig(null, { adapterId: 'qwen', baseUrl: '' });
    }
  });

  it('a confirmação de permissão FULL AUTO segue falando de FULL AUTO e de execução', async () => {
    const setConfig = spawnDeps.trustedHandlers.get('provider:setConfig')!;
    try {
      await setConfig(null, { adapterId: 'qwen', permissionMode: 'yolo' });
      const [confirm] = dialogs();
      expect(confirm!.detail).toMatch(/FULL AUTO remove confirmações/);
      expect(confirm!.detail).toMatch(/EXECUTAR/);
      expect(confirm!.detail).not.toMatch(/ENVIADA/);
    } finally {
      spawnDeps.confirmInstall.mockClear();
      await setConfig(null, { adapterId: 'qwen', permissionMode: 'auto' });
      spawnDeps.confirmInstall.mockClear();
    }
  });

  it('a base URL salva sai normalizada (new URL().href): host minúsculo, porta padrão fora', async () => {
    const setConfig = spawnDeps.trustedHandlers.get('provider:setConfig')!;
    try {
      await setConfig(null, { adapterId: 'qwen', baseUrl: '  HTTPS://Proxy.Da.Empresa.Example:443/v1  ' });
      expect(listProviderSettings().find((p) => p.adapterId === 'qwen')?.baseUrl)
        .toBe('https://proxy.da.empresa.example/v1');
      // A confirmação mostra o valor que será salvo, não o digitado.
      expect(dialogs()[0]!.detail).toContain('Base URL da API: https://proxy.da.empresa.example/v1');
    } finally {
      spawnDeps.confirmInstall.mockClear();
      await setConfig(null, { adapterId: 'qwen', baseUrl: '' });
    }
  });

  it('recusar a confirmação mantém a URL anterior e não mostra erro de URL inválida', async () => {
    const setConfig = spawnDeps.trustedHandlers.get('provider:setConfig')!;
    spawnDeps.confirmInstall.mockResolvedValueOnce({ response: 0 });
    await setConfig(null, { adapterId: 'qwen', baseUrl: 'https://proxy.da.empresa.example/v1' });
    expect(listProviderSettings().find((p) => p.adapterId === 'qwen')?.baseUrl).toBeUndefined();
    expect(dialogs().map((d) => d.type)).toEqual(['warning']);
    spawnDeps.confirmInstall.mockClear();
  });

  it.each([
    ['ftp', 'ftp://nao-vale'],
    ['http (sem TLS)', 'http://proxy.da.empresa.example/v1'],
    ['userinfo', 'https://user:senha@proxy.da.empresa.example/v1'],
    ['string inválida', 'isto nao e uma url'],
  ])('B1: base URL descartada (%s) mostra o erro e mantém a anterior', async (_label, url) => {
    const setConfig = spawnDeps.trustedHandlers.get('provider:setConfig')!;
    spawnDeps.confirmInstall.mockClear();
    await setConfig(null, { adapterId: 'qwen', baseUrl: url });
    expect(listProviderSettings().find((p) => p.adapterId === 'qwen')?.baseUrl).toBeUndefined();
    // Sem confirmação de destino (nada foi aceito) e com o erro à vista.
    expect(dialogs().map((d) => d.type)).toEqual(['error']);
    const [error] = dialogs();
    expect(error!.title).toBe('Base URL inválida');
    expect(error!.detail).toContain(url);
    expect(error!.detail).toMatch(/https/);
    spawnDeps.confirmInstall.mockClear();
  });

  it('limpar a base URL (vazio) não pede confirmação nem mostra erro; patch de outro adapter é ignorado em silêncio', async () => {
    const setConfig = spawnDeps.trustedHandlers.get('provider:setConfig')!;
    spawnDeps.confirmInstall.mockClear();
    await setConfig(null, { adapterId: 'qwen', baseUrl: '' });
    await setConfig(null, { adapterId: 'kimi', baseUrl: PLAN });
    expect(listProviderSettings().find((p) => p.adapterId === 'kimi')?.baseUrl).toBeUndefined();
    expect(spawnDeps.confirmInstall).not.toHaveBeenCalled();
  });

  it('conta api-key pinada (a conta "a" do incidente): a chave da conta também ganha o descritor', () => {
    const account = { id: 'acct-a', label: 'a', adapterId: 'qwen', mode: 'api-key', upstream: 'anthropic' };
    spawnDeps.getAccount.mockReturnValue(account);
    spawnDeps.prepareAccount.mockReturnValueOnce({ ok: true, account, apiKey: 'sk-sp-da-conta-a', authEnv: {} });
    const result = prepareProviderSpawn('qwen', { accountId: 'acct-a', model: 'qwen3.7-plus' });
    if (!result.ok) throw new Error('spawn falhou');
    expect(result.overrides.qwenSettingsInjection).toMatchObject({ baseUrl: PLAN, tokenPlanKey: true });
    expect(result.overrides.keyEnv).toEqual({
      [result.overrides.qwenSettingsInjection!.envKey]: 'sk-sp-da-conta-a',
    });
    expect(result.overrides.qwenSettingsInjection?.models).toContain('qwen3.7-plus');
  });

  it('sem chave configurada não há descritor (settings do operador segue ligado)', () => {
    // api-key sem chave em nenhuma fonte: keyEnv vazio → sem injeção.
    const result = prepareProviderSpawn('qwen', {});
    if (!result.ok) throw new Error('spawn falhou');
    expect(result.overrides.qwenSettingsInjection).toBeUndefined();
    expect(result.overrides.keyEnv).toEqual({});
  });
});
