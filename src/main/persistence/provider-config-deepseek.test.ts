/**
 * F-724: provedor do DeepSeek (API direta × Alibaba Token Plan) de ponta a
 * ponta no hub de providers — setConfig persistido, chave, host, env do spawn,
 * catálogo e contas. Usa o launcher e os manifestos REAIS; o HOME é um
 * diretório temporário (nada lê o ~/.nexus nem o providers.conf do operador).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_CHANNELS } from '../../shared/provider-settings-types';

const fx = await vi.hoisted(async () => {
  const fsActual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const osActual = await vi.importActual<typeof import('node:os')>('node:os');
  const pathActual = await vi.importActual<typeof import('node:path')>('node:path');
  const { BUILTIN_ADAPTERS } = await import('../../adapters/builtin');
  const { adapterSchema } = await import('../../shared/adapter-types');
  return {
    home: fsActual.mkdtempSync(pathActual.join(osActual.tmpdir(), 'nexus-f724-')),
    // Manifestos reais do Claude, do DeepSeek e do Qwen Code.
    manifests: BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw))
      .filter((adapter) => ['claude', 'deepseek', 'qwen'].includes(adapter.id)),
    vault: new Map<string, string>(),
    cached: new Set<string>(),
    handlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
    accounts: [] as Array<{
      id: string; adapterId: string; label: string; mode: string;
      upstream: string; createdAt: number;
    }>,
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mock = { ...actual, homedir: () => fx.home };
  return { ...mock, default: mock };
});

vi.mock('electron', () => ({
  app: { getPath: () => fx.home, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
  powerMonitor: { getSystemIdleTime: () => 0 },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, handler: (event: unknown, raw: unknown) => unknown) => {
    fx.handlers.set(channel, handler);
  },
}));

vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: (id: string) => fx.manifests.find((adapter) => adapter.id === id) ?? null,
  listAdapters: () => fx.manifests,
  isBuiltinAdapter: () => true,
  isBinResolvable: () => true,
  getAdapterResolvedBin: (id: string) => `/usr/local/bin/${id === 'qwen' ? 'qwen' : 'claude'}`,
  resolveAdapterBinary: (id: string) => `/usr/local/bin/${id === 'qwen' ? 'qwen' : 'claude'}`,
  rescanAdapterBinaries: vi.fn(async () => []),
  notifyAdaptersChanged: vi.fn(),
  primaryKeyEnvVar: (adapter: { kind: string; auth: { method: string; envVarFallback?: string }; env?: { passthrough: string[] } }) =>
    adapter.auth.method === 'oauth' || adapter.auth.method === 'subscription'
      ? null
      : adapter.auth.envVarFallback ?? adapter.env?.passthrough[0] ?? null,
}));

vi.mock('../path-resolver', () => ({
  realUserHome: () => fx.home,
  revalidateExecutable: (binPath: string) => typeof binPath === 'string' && binPath.startsWith('/'),
  resolveCliBinary: () => null,
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

vi.mock('../adapters/model-discovery', () => ({
  discoveredModelsFor: () => [],
  refreshAllDiscoveredModels: vi.fn(),
}));

vi.mock('../adapters/provider-test', () => ({ testProviderKey: vi.fn() }));

vi.mock('./secrets-store', () => ({
  getKey: (id: string) => fx.vault.get(id) ?? null,
  getSecret: (key: string) => fx.vault.get(key) ?? null,
  hasSecret: (key: string) => fx.vault.has(key),
  hasCachedSecret: (key: string) => fx.cached.has(key),
  isSecureStorageAvailable: () => true,
  maskedKey: (id: string) => (fx.vault.has(id) ? `mask:${id}` : null),
  setKey: (id: string, key: string) => {
    if (key) fx.vault.set(id, key);
    else fx.vault.delete(id);
    return { ok: true };
  },
  setSecret: vi.fn(() => ({ ok: true })),
  deleteSecret: vi.fn(() => ({ ok: true })),
  listSecretKeys: () => [...fx.vault.keys()],
  vaultState: () => 'unlocked',
}));

vi.mock('../adapters/subscription-auth', () => ({
  hasSubscriptionAuth: () => false,
  hasSubscriptionAuthForStatus: () => false,
  subscriptionAuthStatusIsUnknown: () => false,
  refreshAgySubscriptionAuthCache: vi.fn(async () => ({ value: false, cacheUpdated: false })),
  refreshClaudeSubscriptionAuthCache: vi.fn(async () => ({ value: false, cacheUpdated: false })),
  refreshOpenClaudeSubscriptionAuthCache: vi.fn(async () => ({ value: false, cacheUpdated: false })),
  // Mesma regra de resolveAuthStrategy (sessão > chave > login).
  resolveAuthStrategy: (input: { authMethod: string; hasStoredKey: boolean; subscriptionAuthed: boolean }) =>
    input.authMethod === 'none'
      ? { strategy: 'credentialless', injectKey: false, suppressKeyEnv: false }
      : input.subscriptionAuthed
        ? { strategy: 'subscription', injectKey: false, suppressKeyEnv: true }
        : input.hasStoredKey
          ? { strategy: 'api-key', injectKey: true, suppressKeyEnv: false }
          : { strategy: 'login-needed', injectKey: false, suppressKeyEnv: false },
}));

vi.mock('./account-store', () => {
  const find = (id: string) => fx.accounts.find((account) => account.id === id) ?? null;
  return {
    accountHasFailoverCredential: () => true,
    activeClaudeAuthEnv: () => null,
    accountKey: (account: { id: string; mode: string }) =>
      account.mode === 'api-key' ? fx.vault.get(`acctkey:${account.id}`) ?? null : null,
    agyKeyringSlotAccount: () => null,
    ensureSubscriptionActive: () => true,
    fileSubscriptionAuthEnv: () => null,
    getActiveAccount: (adapterId: string) =>
      fx.accounts.find((account) => account.adapterId === adapterId) ?? null,
    getAccount: find,
    isAccountBlockedForScope: () => false,
    listAccounts: (adapterId: string) =>
      fx.accounts.filter((account) => account.adapterId === adapterId),
    pickAvailableForFailover: (adapterId: string) => ({
      account: fx.accounts.find((account) => account.adapterId === adapterId) ?? null,
    }),
    prepareAccountForSpawn: (adapterId: string, accountId: string) => {
      const account = find(accountId);
      if (!account || account.adapterId !== adapterId) {
        return { ok: false, error: 'selected account does not belong to this provider' };
      }
      return {
        ok: true, account, apiKey: fx.vault.get(`acctkey:${account.id}`) ?? null, authEnv: {},
      };
    },
    verifyManagedClaudeAccountForSpawn: vi.fn(async () => 'match'),
  };
});

vi.mock('../quota/quota-service', () => ({
  requireQuotaService: () => ({ lastSnapshot: () => null }),
}));

vi.mock('./agy-keyring-activation', () => ({
  activateAgyAccountForSpawn: vi.fn(async () => ({ ok: true, switched: false })),
}));

import { setLauncherProvidersFileForTests } from '../adapters/launcher-provider-manager';
import {
  hasRuntimeKey,
  listProviderSettings,
  prepareProviderSpawn,
  registerProviderIpc,
  resolveQuotaApiKey,
  resolveRuntimeApiKey,
} from './provider-config-store';

const TOKEN_PLAN_ANTHROPIC = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic';
const TOKEN_PLAN_OPENAI = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
const DEEPSEEK_ANTHROPIC = 'https://api.deepseek.com/anthropic';
const DIRECT_KEY = 'sk-0123456789abcdef-fixture';
const PLAN_KEY = 'sk-sp-fixture-plan';

const ENV_NAMES = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'DEEPSEEK_API_KEY',
  'BAILIAN_TOKEN_PLAN_API_KEY',
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
];

const launcherFile = path.join(fx.home, 'providers.conf');

function writeLauncher(lines: string[]): void {
  fs.writeFileSync(launcherFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  setLauncherProvidersFileForTests(launcherFile);
}

async function setConfig(patch: Record<string, unknown>): Promise<void> {
  const handler = fx.handlers.get(PROVIDER_CHANNELS.setConfig);
  if (!handler) throw new Error('setConfig handler not registered');
  await handler({}, patch);
}

const setChoice = (upstream: string) => setConfig({ adapterId: 'deepseek', upstream });

function deepseekInfo() {
  return listProviderSettings({ nonBlockingAuth: true }).find((p) => p.adapterId === 'deepseek')!;
}

function spawnEnv(perSpawn: Parameters<typeof prepareProviderSpawn>[1] = {}) {
  const prepared = prepareProviderSpawn('deepseek', perSpawn);
  if (!prepared.ok) throw new Error(prepared.error);
  return prepared.overrides;
}

beforeAll(() => {
  registerProviderIpc();
});

afterAll(() => {
  setLauncherProvidersFileForTests(null);
  vi.unstubAllEnvs();
  fs.rmSync(fx.home, { recursive: true, force: true });
});

beforeEach(async () => {
  fx.vault.clear();
  fx.cached.clear();
  fx.accounts.length = 0;
  for (const name of ENV_NAMES) vi.stubEnv(name, '');
  vi.stubEnv('QWEN_HOME', path.join(fx.home, '.qwen'));
  writeLauncher([]);
  await setConfig({ adapterId: 'deepseek', upstream: 'deepseek', defaultModel: '' });
  await setConfig({ adapterId: 'claude', upstream: 'anthropic' });
});

describe('F-724 — DeepSeek pela API direta (padrão, comportamento histórico)', () => {
  it('sobe em api.deepseek.com com a chave da DeepSeek e o slot barato no flash', () => {
    fx.vault.set('deepseek', DIRECT_KEY);
    const overrides = spawnEnv();
    expect(overrides.keyEnv.ANTHROPIC_BASE_URL).toBe(DEEPSEEK_ANTHROPIC);
    expect(overrides.keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(DIRECT_KEY);
    expect(overrides.keyEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-flash');
    expect(overrides.modelAliases).toBeUndefined();
  });

  it('nunca manda para api.deepseek.com a chave do Token Plan que o launcher amarra à Alibaba', () => {
    // Forma do providers.conf do operador (02/10): `deepseek=` guarda a chave
    // sk-sp- do Token Plan com `deepseek-base-url` no endpoint da Alibaba.
    writeLauncher([`deepseek=${PLAN_KEY}`, `deepseek-base-url=${TOKEN_PLAN_ANTHROPIC}`]);
    expect(resolveRuntimeApiKey('deepseek')).toBeNull();
    expect(hasRuntimeKey('deepseek')).toBe(false);
    const prepared = prepareProviderSpawn('deepseek');
    expect(prepared.ok).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain(PLAN_KEY);
  });

  it('chave sk-sp- (plano da Alibaba) nunca sai para a DeepSeek, nem do cofre nem do launcher sem base-url', () => {
    fx.vault.set('deepseek', PLAN_KEY);
    writeLauncher([`deepseek=${PLAN_KEY}`]);
    const prepared = prepareProviderSpawn('deepseek');
    expect(prepared).toMatchObject({ ok: false });
    if (!prepared.ok) expect(prepared.error).toContain('Token Plan');
    // Com uma chave da DeepSeek no env, é ela que vale.
    vi.stubEnv('DEEPSEEK_API_KEY', DIRECT_KEY);
    expect(spawnEnv().keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(DIRECT_KEY);
  });

  it('o Claude roteado para a DeepSeek também nunca leva a chave do Token Plan', async () => {
    await setConfig({ adapterId: 'claude', upstream: 'deepseek' });
    writeLauncher([`deepseek=${PLAN_KEY}`, `deepseek-base-url=${TOKEN_PLAN_ANTHROPIC}`]);
    expect(hasRuntimeKey('claude')).toBe(false);
    expect(JSON.stringify(prepareProviderSpawn('claude'))).not.toContain(PLAN_KEY);
    // Chave da API direta no slot do launcher continua roteando.
    writeLauncher([`deepseek=${DIRECT_KEY}`]);
    expect(hasRuntimeKey('claude')).toBe(true);
  });

  it('launcher `deepseek=` sem base-url (ou com base-url da própria DeepSeek) continua valendo', () => {
    writeLauncher([`deepseek=${DIRECT_KEY}`]);
    expect(spawnEnv().keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(DIRECT_KEY);
    writeLauncher([`deepseek=${DIRECT_KEY}`, `deepseek-base-url=${DEEPSEEK_ANTHROPIC}`]);
    expect(spawnEnv().keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(DIRECT_KEY);
  });
});

describe('F-724 — DeepSeek pelo Alibaba Token Plan', () => {
  it('a escolha persiste no providers.json e o spawn usa endpoint, chave e modelos do plano', async () => {
    fx.vault.set('deepseek', DIRECT_KEY);
    fx.vault.set('qwen', PLAN_KEY);
    await setConfig({ adapterId: 'deepseek', upstream: 'deepseek-token-plan', defaultModel: 'deepseek-flash' });
    const saved = JSON.parse(
      fs.readFileSync(path.join(fx.home, '.nexus', 'providers.json'), 'utf8'),
    ) as { providers: Record<string, { upstream: string }> };
    expect(saved.providers.deepseek.upstream).toBe('deepseek-token-plan');

    const overrides = spawnEnv({ model: 'deepseek-flash' });
    expect(overrides.keyEnv.ANTHROPIC_BASE_URL).toBe(TOKEN_PLAN_ANTHROPIC);
    expect(overrides.keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(PLAN_KEY);
    for (const slot of [
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ]) {
      expect(overrides.keyEnv[slot]).toBe('deepseek-v4-pro');
    }
    // O `--model deepseek-flash` vira v4-pro no spawn (o plano dá 403 no flash).
    expect(overrides.modelAliases).toMatchObject({
      'deepseek-flash': 'deepseek-v4-pro',
      'deepseek-v4-flash': 'deepseek-v4-pro',
    });
    expect(overrides.defaultModel).toBe('deepseek-v4-pro');
    expect(overrides.suppressEnv).toContain('DEEPSEEK_API_KEY');
    // A chave da API direta nunca entra no processo que fala com a Alibaba.
    expect(JSON.stringify(overrides)).not.toContain(DIRECT_KEY);
    expect(JSON.stringify(overrides)).not.toMatch(/qwen3/);
  });

  it('lê a chave do Token Plan do launcher (`dashscope=`), nunca a `deepseek=` da API direta', async () => {
    await setChoice('deepseek-token-plan');
    writeLauncher([
      `deepseek=${DIRECT_KEY}`,
      `dashscope=${PLAN_KEY}`,
      `qwen-base-url=${TOKEN_PLAN_OPENAI}`,
    ]);
    expect(spawnEnv().keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(PLAN_KEY);
    // Só a `deepseek=` da API direta: o plano fica sem chave.
    writeLauncher([`deepseek=${DIRECT_KEY}`]);
    expect(hasRuntimeKey('deepseek')).toBe(false);
    expect(prepareProviderSpawn('deepseek').ok).toBe(false);
    // `deepseek=` amarrado ao Token Plan pelo launcher é a chave do plano.
    writeLauncher([`deepseek=${PLAN_KEY}`, `deepseek-base-url=${TOKEN_PLAN_ANTHROPIC}`]);
    expect(spawnEnv().keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(PLAN_KEY);
  });

  it('nunca usa DEEPSEEK_API_KEY no plano; aceita as variáveis do Qwen Code', async () => {
    await setChoice('deepseek-token-plan');
    vi.stubEnv('DEEPSEEK_API_KEY', DIRECT_KEY);
    expect(hasRuntimeKey('deepseek')).toBe(false);
    vi.stubEnv('DASHSCOPE_API_KEY', PLAN_KEY);
    expect(spawnEnv().keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(PLAN_KEY);
  });

  it('o ~/.qwen/settings.json conta para o Qwen Code mas não é copiado para o DeepSeek', async () => {
    await setChoice('deepseek-token-plan');
    fs.mkdirSync(path.join(fx.home, '.qwen'), { recursive: true });
    fs.writeFileSync(path.join(fx.home, '.qwen', 'settings.json'), JSON.stringify({
      env: { DASHSCOPE_API_KEY: PLAN_KEY },
      security: { auth: { selectedType: 'openai', baseUrl: TOKEN_PLAN_OPENAI } },
    }));
    try {
      expect(hasRuntimeKey('qwen')).toBe(true);
      expect(hasRuntimeKey('deepseek')).toBe(false);
      const info = deepseekInfo();
      expect(info.providerChoice?.key.hasKey).toBe(false);
      expect(info.providerChoice?.key.hint).toContain('settings.json');
    } finally {
      fs.rmSync(path.join(fx.home, '.qwen'), { recursive: true, force: true });
    }
  });
});

describe('F-724 — host gate do token Anthropic do env nos dois sentidos', () => {
  it('token com BASE_URL no Token Plan só serve ao provedor Token Plan', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', PLAN_KEY);
    vi.stubEnv('ANTHROPIC_BASE_URL', TOKEN_PLAN_ANTHROPIC);
    // API direta: o token amarrado à Alibaba nunca vai para a DeepSeek.
    expect(hasRuntimeKey('deepseek')).toBe(false);
    expect(resolveRuntimeApiKey('deepseek')).toBeNull();
    await setChoice('deepseek-token-plan');
    expect(hasRuntimeKey('deepseek')).toBe(true);
    expect(spawnEnv().keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(PLAN_KEY);
  });

  it('token com BASE_URL na DeepSeek só serve à API direta', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', DIRECT_KEY);
    vi.stubEnv('ANTHROPIC_BASE_URL', DEEPSEEK_ANTHROPIC);
    expect(spawnEnv().keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(DIRECT_KEY);
    await setChoice('deepseek-token-plan');
    // Token Plan: a chave da DeepSeek nunca vai para a Alibaba.
    expect(hasRuntimeKey('deepseek')).toBe(false);
    const prepared = prepareProviderSpawn('deepseek');
    expect(prepared.ok).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain(DIRECT_KEY);
  });

  it('BASE_URL sem HTTPS, com credencial embutida ou em host parecido não abre o gate', async () => {
    await setChoice('deepseek-token-plan');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', PLAN_KEY);
    for (const url of [
      'http://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
      'https://u:p@token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com.evil.example/apps/anthropic',
    ]) {
      vi.stubEnv('ANTHROPIC_BASE_URL', url);
      expect(hasRuntimeKey('deepseek')).toBe(false);
    }
  });

  it('o intent router (api.deepseek.com) nunca recebe a chave do Token Plan', async () => {
    await setChoice('deepseek-token-plan');
    fx.vault.set('qwen', PLAN_KEY);
    expect(hasRuntimeKey('deepseek')).toBe(true);
    expect(resolveRuntimeApiKey('deepseek')).toBeNull();
    fx.vault.set('deepseek', DIRECT_KEY);
    expect(resolveRuntimeApiKey('deepseek')).toBe(DIRECT_KEY);
  });
});

describe('F-724 — setConfig e snapshot do provider', () => {
  it('o DeepSeek só aceita os dois provedores; a rota do plano não serve a outra CLI', async () => {
    await setChoice('glm');
    expect(deepseekInfo().upstream).toBe('deepseek');
    await setChoice('deepseek-token-plan');
    expect(deepseekInfo().upstream).toBe('deepseek-token-plan');
    await setChoice('anthropic');
    expect(deepseekInfo().upstream).toBe('deepseek-token-plan');

    await setConfig({ adapterId: 'claude', upstream: 'deepseek-token-plan' });
    const claude = listProviderSettings({ nonBlockingAuth: true }).find((p) => p.adapterId === 'claude')!;
    expect(claude.upstream).not.toBe('deepseek-token-plan');
    expect(claude.upstreams.map((u) => u.id)).not.toContain('deepseek-token-plan');
    expect(claude.providerChoice).toBeUndefined();
  });

  it('mostra o seletor, a vaga de chave do provedor e o catálogo que ele serve', async () => {
    fx.vault.set('deepseek', DIRECT_KEY);
    fx.cached.add('deepseek');
    const direct = deepseekInfo();
    expect(direct.providerChoice).toMatchObject({
      value: 'deepseek',
      key: { adapterId: 'deepseek', hasKey: true, keyMasked: 'mask:deepseek' },
    });
    expect(direct.providerChoice?.options.map((o) => o.id)).toEqual(['deepseek', 'deepseek-token-plan']);
    expect(direct.providerChoice?.options[1]?.hint).toContain('deepseek-v4-pro');
    expect(direct.models).toEqual(expect.arrayContaining(['deepseek-v4-pro', 'deepseek-flash']));
    expect(direct.modelAliases).toBeUndefined();

    await setChoice('deepseek-token-plan');
    const plan = deepseekInfo();
    expect(plan.providerChoice).toMatchObject({
      value: 'deepseek-token-plan',
      key: { adapterId: 'qwen', hasKey: false, keyMasked: null },
    });
    expect(plan.providerChoice?.key.label).toContain('Token Plan');
    expect(plan.providerChoice?.key.label).toContain('Qwen Code');
    expect(plan.hasKey).toBe(false);
    expect(plan.models).toContain('deepseek-v4-pro');
    expect(plan.models).not.toContain('deepseek-flash');
    expect(plan.models.some((m) => m.startsWith('qwen'))).toBe(false);
    expect(plan.modelAliases).toEqual({
      'deepseek-flash': 'deepseek-v4-pro',
      'deepseek-v4-flash': 'deepseek-v4-pro',
    });
    fx.vault.set('qwen', PLAN_KEY);
    fx.cached.add('qwen');
    expect(deepseekInfo()).toMatchObject({
      hasKey: true,
      authStrategy: 'api-key',
      providerChoice: { key: { hasKey: true, keyMasked: 'mask:qwen' } },
    });
  });
});

describe('F-724 — contas DeepSeek (multi-conta) e cota', () => {
  const account = {
    id: 'ds-1', adapterId: 'deepseek', label: 'pessoal', mode: 'api-key',
    upstream: 'anthropic', createdAt: 1,
  };

  it('API direta: conta DeepSeek continua indo para api.deepseek.com', () => {
    fx.accounts.push(account);
    fx.vault.set('acctkey:ds-1', DIRECT_KEY);
    const pinned = spawnEnv({ accountId: 'ds-1' });
    expect(pinned.selectedAccountId).toBe('ds-1');
    expect(pinned.keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(DIRECT_KEY);
  });

  it('API direta: conta com chave sk-sp- é recusada', () => {
    fx.accounts.push(account);
    fx.vault.set('acctkey:ds-1', PLAN_KEY);
    const prepared = prepareProviderSpawn('deepseek', { accountId: 'ds-1' });
    expect(prepared.ok).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain(PLAN_KEY);
  });

  it('Token Plan: conta DeepSeek fixada é recusada e, sem fixar, nenhuma conta é usada', async () => {
    fx.accounts.push(account);
    fx.vault.set('acctkey:ds-1', DIRECT_KEY);
    fx.vault.set('qwen', PLAN_KEY);
    await setChoice('deepseek-token-plan');
    const pinned = prepareProviderSpawn('deepseek', { accountId: 'ds-1' });
    expect(pinned.ok).toBe(false);
    if (!pinned.ok) expect(pinned.error).toContain('Token Plan');
    const unpinned = spawnEnv();
    expect(unpinned.selectedAccountId).toBeUndefined();
    expect(unpinned.keyEnv.ANTHROPIC_AUTH_TOKEN).toBe(PLAN_KEY);
    expect(JSON.stringify(unpinned)).not.toContain(DIRECT_KEY);
  });

  it('cota: a linha do Token Plan só lê a chave do plano (cofre quente)', async () => {
    fx.vault.set('deepseek', DIRECT_KEY);
    fx.cached.add('deepseek');
    fx.vault.set('qwen', PLAN_KEY);
    fx.cached.add('qwen');
    expect(resolveQuotaApiKey({ adapterId: 'deepseek', usageProviderId: 'deepseek', authMode: 'api-key' }))
      .toBe(DIRECT_KEY);
    await setChoice('deepseek-token-plan');
    expect(resolveQuotaApiKey({ adapterId: 'deepseek', usageProviderId: 'deepseek-token-plan', authMode: 'api-key' }))
      .toBe(PLAN_KEY);
    expect(resolveQuotaApiKey({ adapterId: 'deepseek', usageProviderId: 'deepseek', authMode: 'api-key' }))
      .toBeNull();
    // Vaga do plano fria: não decifra nem cai na chave da DeepSeek.
    fx.cached.delete('qwen');
    expect(resolveQuotaApiKey({ adapterId: 'deepseek', usageProviderId: 'deepseek-token-plan', authMode: 'api-key' }))
      .toBeNull();
  });
});
