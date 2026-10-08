import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
import { readRegularFileCappedAsync } from '../redline/redline-safe-read';
import { mimoCredentialSupportsModel } from '../adapters/mimo-auth';
import { qwenSettingsHasCredential } from '../adapters/qwen-settings';
import { requestQwenReadiness, peekQwenReadiness, invalidateQwenReadiness } from '../adapters/qwen-readiness-cache';
import { migrateModelId } from '../../shared/model-defaults';
import fs from 'node:fs';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, powerMonitor } from 'electron';
import type { WebContents } from 'electron';
import { handleTrusted } from '../security/trusted-ipc';
import {
  hasSensitiveChange,
  sensitiveChanges,
  validateBinPath,
  type SensitiveChange,
} from './provider-bin-trust';
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from './provider-config-format';
import {
  PROVIDER_CHANNELS,
  addModelSchema,
  exportSecretsSchema,
  importSecretsSchema,
  providerConfigPatchSchema,
  setKeySchema,
  type ProviderChoiceInfo,
  type ProviderConfig,
  type ProviderSettingsInfo,
  type TestConnectionResult,
} from '../../shared/provider-settings-types';
import {
  getAdapter,
  getAdapterResolvedBin,
  isBinResolvable,
  isBuiltinAdapter,
  listAdapters,
  notifyAdaptersChanged,
  primaryKeyEnvVar,
  rescanAdapterBinaries,
  resolveAdapterBinary,
} from '../adapters/adapter-registry';
import { resolveCliLoginCommand } from '../../shared/cli-login';
import { kimiLoginCommand } from '../../shared/kimi-login-command';
import { cachedCliBinaryVersion, revalidateExecutable, resolveCliBinary, realUserHome } from '../path-resolver';
import { cliVersionWarnings } from '../adapters/cli-compatibility';
import {
  availableEfforts,
  availablePermissionModes,
  buildControlArgs,
  defaultPermissionMode,
  supportsVerbose,
} from '../adapters/control-args';
import {
  addCustomModel,
  getCustomModels,
  removeCustomModel,
} from '../adapters/custom-models';
import { refreshAllDiscoveredModels } from '../adapters/model-discovery';
import { currentModelOffer } from '../adapters/model-offer';
import {
  cliInstallRecipeCandidates,
  cliInstallRecipeFor,
  cliInstallCommandFor,
  compatibleManualInstallCommand,
  selectInstallRecipe,
  selectCliUpdateRecipe,
  describeInstallRecipe,
  type CliInstallRecipe,
} from '../adapters/cli-install-recipes';
import {
  windowsNpmShimInvocation,
  windowsNpmShimTarget,
} from '../adapters/windows-npm-shim';
import { assessCliUpdate } from '../adapters/cli-update-observation';
import {
  moveExecutableAside,
  removeStaleExecutableCopies,
  restoreExecutableIfMissing,
} from '../adapters/in-use-executable';
import { CliAutoUpdateQueue, CliUpdateLease, selectAutomaticCliUpdateRecipe, shouldOfferAutoCliConsent } from '../adapters/cli-auto-update';
import { execFile } from 'node:child_process';
import {
  getKey,
  getSecret,
  hasCachedSecret,
  hasSecret,
  isSecureStorageAvailable,
  maskedKey,
  setKey,
  vaultState,
} from './secrets-store';
import {
  exportSecretsVault,
  importSecretsVault,
} from './secrets-portability';
import { testProviderKey } from '../adapters/provider-test';
import {
  buildProviderRoutingEnv,
  listUpstreamProviders,
  loadLauncherProviderBaseUrl,
  loadLauncherProviderKey,
  upstreamAllowedForAdapter,
} from '../adapters/launcher-provider-manager';
import {
  ALIBABA_TOKEN_PLAN_HOST,
  DEEPSEEK_DIRECT_HOST,
  DEEPSEEK_DIRECT_PROVIDER,
  DEEPSEEK_TOKEN_PLAN_MODEL,
  DEEPSEEK_TOKEN_PLAN_MODEL_ALIASES,
  DEEPSEEK_TOKEN_PLAN_PROVIDER,
  TOKEN_PLAN_KEY_ENV_VARS,
  TOKEN_PLAN_KEY_VAULT_SLOT,
  deepseekModelForProvider,
  deepseekModelsForProvider,
  deepseekProviderChoice,
  defaultDeepseekProviderChoice,
  httpsHostOf,
  isAlibabaPlanKey,
  isDeepseekProviderChoice,
  type DeepseekProviderChoice,
} from '../adapters/deepseek-provider';
import {
  loadModelCatalog,
  modelInfoForAdapter,
} from '../adapters/model-catalog';
import {
  hasSubscriptionAuth,
  hasSubscriptionAuthForStatus,
  refreshAgySubscriptionAuthCache,
  refreshClaudeSubscriptionAuthCache,
  refreshOpenClaudeSubscriptionAuthCache,
  subscriptionAuthStatusIsUnknown,
  resolveAuthStrategy,
  type AuthDecision,
} from '../adapters/subscription-auth';
import {
  KIMI_TRANSIENT_MODEL_ENV_KEYS,
  buildKimiApiKeyRuntimeEnv,
} from '../adapters/kimi-runtime-env';
import {
  isCredentiallessOpenCodeModel,
  isProviderAuthReadyForModel,
} from '../adapters/model-auth-readiness';
import {
  accountHasFailoverCredential,
  activeClaudeAuthEnv,
  accountKey,
  agyKeyringSlotAccount,
  ensureSubscriptionActive,
  fileSubscriptionAuthEnv,
  getActiveAccount,
  getAccount,
  isAccountBlockedForScope,
  listAccounts,
  pickAvailableForFailover,
  prepareAccountForSpawn,
  verifyManagedClaudeAccountForSpawn,
} from './account-store';
import type { Account } from '../../shared/account-types';
import {
  maskAccountLabel,
  type AccountChoiceAlternative,
  type AccountChoiceReceipt,
  type AccountHeadroom,
} from '../../shared/account-choice';
import type { ProviderQuotaEntry } from '../../shared/quota-types';
import { quotaAvailabilityScore } from '../quota/quota-policy';
import {
  bindingHeadroomWindow,
  compareAccountHeadroom,
  headroomInputsByAccount,
  type HeadroomInput,
} from '../quota/account-headroom';
import { requireQuotaService } from '../quota/quota-service';
import { isCurrentProcessSmokeTest } from '../smoke-core';
import type { ApiQuotaKeyRequest } from '../quota/provider-live-usage';
import { activateAgyAccountForSpawn } from './agy-keyring-activation';
import { prepareMinimaxNodeRuntime } from '../adapters/minimax-node-runtime';

/**
 * Provider configuration hub: per-adapter enable/disable, binary-path
 * override, default model and extra args (non-secret; ~/.nexus/providers.json)
 * combined with the keychain-backed secret to produce the settings UI view and
 * the spawn overrides the PTY layer applies.
 */

const CONFIG_FILE = path.join(os.homedir(), '.nexus', 'providers.json');

let configs = new Map<string, ProviderConfig>();
let isProviderConfigInitialized = false;
const listeners = new Set<WebContents>();
const cliUpdateLease = new CliUpdateLease();

/** Hold until a pane has registered its PTY, so an updater cannot replace its launcher mid-spawn. */
export async function acquireCliSpawnPermit(adapterId: string): Promise<() => void> {
  const release = await cliUpdateLease.acquireSpawnPermit(adapterId);
  if (adapterId === 'minimax-code') {
    // F-789: com o lançador travado pelo permit, o Node do mcode fica decidido
    // (sondagem assíncrona, em cache) antes do spawn síncrono. Nunca bloqueia
    // o spawn: sem decisão ele segue pelo shebang, como antes.
    try {
      const binPath = activeProviderBinary(adapterId);
      if (binPath) await prepareMinimaxNodeRuntime(binPath, process.env.PATH ?? '');
    } catch (error) {
      console.warn('[provider-config] MiniMax Code: Node do mcode não decidido:', error);
    }
  }
  return release;
}

function defaultPermissionModeFor(adapterId: string): string {
  const adapter = getAdapter(adapterId);
  return adapter?.kind === 'cli-pty' ? defaultPermissionMode(adapter) : '';
}

/**
 * F-724: sem escolha salva, o provedor do DeepSeek segue o slot `deepseek` do
 * launcher (`defaultDeepseekProviderChoice`). O select de Providers mostra o
 * mesmo valor e, ao salvar o card, é ele que fica gravado.
 */
function defaultDeepseekUpstream(): DeepseekProviderChoice {
  return defaultDeepseekProviderChoice({
    key: loadLauncherProviderKey(DEEPSEEK_DIRECT_PROVIDER),
    baseUrl: loadLauncherProviderBaseUrl(DEEPSEEK_DIRECT_PROVIDER),
  });
}

function defaultConfigFor(adapterId: string): ProviderConfig {
  // Claude-compatible forks that always talk to a third-party Anthropic
  // endpoint (GLM/z.ai, LongCat) default their upstream so spawn injects
  // ANTHROPIC_BASE_URL + AUTH_TOKEN via buildProviderRoutingEnv — not the
  // native Anthropic subscription path.
  const defaultUpstream =
    adapterId === 'glm'
      ? 'glm'
      : adapterId === 'glm-flash'
        ? 'glm-flash'
        : adapterId === 'longcat'
          ? 'longcat'
          : adapterId === DEEPSEEK_DIRECT_PROVIDER
            ? defaultDeepseekUpstream()
            : 'anthropic';
  return {
    adapterId,
    enabled: true,
    binPath: '',
    defaultModel: '',
    extraArgs: [],
    upstream: defaultUpstream,
    permissionMode: defaultPermissionModeFor(adapterId),
    effort: adapterId === 'agy' ? 'high' : '',
    verbose: false,
  };
}

function load(): void {
  configs = new Map();
  try {
    const decoded = decodeProviderConfigFile(
      JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as unknown,
    );
    for (const [adapterId, cfg] of Object.entries(decoded.providers)) {
      const defaults = defaultConfigFor(adapterId);
      configs.set(adapterId, {
        ...defaults,
        enabled: cfg.enabled ?? defaults.enabled,
        binPath: cfg.binPath ?? defaults.binPath,
        defaultModel: cfg.defaultModel ?? defaults.defaultModel,
        extraArgs: Array.isArray(cfg.extraArgs) ? cfg.extraArgs : defaults.extraArgs,
        upstream: cfg.upstream ?? defaults.upstream,
        permissionMode: cfg.permissionMode ?? defaults.permissionMode,
        effort: adapterId === 'agy' && cfg.effort === 'max'
          ? 'high' : (cfg.effort ?? defaults.effort),
        verbose: cfg.verbose ?? defaults.verbose,
      });
    }
    if (decoded.migrated) persist();
  } catch {
    // No config yet — every adapter defaults to enabled.
  } finally {
    isProviderConfigInitialized = true;
  }
}

/**
 * Load persisted provider enablement before orchestration consumes settings.
 * Idempotent so bootstrap may initialize the non-IPC store early while the
 * ordinary IPC registration remains the owner of channel wiring.
 */
export function initializeProviderConfigStore(): void {
  if (!isProviderConfigInitialized) load();
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
    const out: Record<string, ProviderConfig> = {};
    for (const [id, cfg] of configs) out[id] = cfg;
    // 0600 (L7): this file can carry user-supplied extraArgs and is adjacent to
    // secret material — do not leave it world-readable.
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify(encodeProviderConfigFile(out), null, 2),
      { mode: 0o600 },
    );
    // writeFileSync's mode only applies on creation; enforce on existing files.
    try {
      fs.chmodSync(CONFIG_FILE, 0o600);
    } catch {
      // best effort (e.g. non-POSIX fs)
    }
  } catch (err) {
    console.warn('[provider-config] failed to persist:', err);
  }
}

function configFor(adapterId: string): ProviderConfig {
  return configs.get(adapterId) ?? defaultConfigFor(adapterId);
}

/** F-724: provedor do DeepSeek — o salvo ou, sem escolha, o do launcher. */
function deepseekChoice(
  upstream: string = configFor('deepseek').upstream,
): DeepseekProviderChoice {
  return deepseekProviderChoice(upstream);
}

/** Vaga do cofre com a chave do provedor: a da DeepSeek ou a do Token Plan. */
function deepseekKeyVaultSlot(choice: DeepseekProviderChoice): string {
  return choice === DEEPSEEK_TOKEN_PLAN_PROVIDER
    ? TOKEN_PLAN_KEY_VAULT_SLOT
    : DEEPSEEK_DIRECT_PROVIDER;
}

/** No Token Plan as contas DeepSeek (chaves da API direta) não se aplicam. */
const DEEPSEEK_TOKEN_PLAN_ACCOUNT_ERROR =
  'O provedor do DeepSeek está no Alibaba Token Plan: contas DeepSeek são ' +
  'da API direta e não vão para a Alibaba. Troque o provedor em Providers › ' +
  'DeepSeek ou abra o pane sem conta fixada.';

/** Control-flag args (permission mode, effort, verbose) chosen for an adapter. */
function controlArgsFor(adapterId: string, effortOverride?: string): string[] {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty') return [];
  const cfg = configFor(adapterId);
  return buildControlArgs(adapter, {
    permissionMode: cfg.permissionMode,
    // A per-spawn effort (task-router decision) wins over the hub setting.
    effort: effortOverride || cfg.effort,
    verbose: cfg.verbose,
  });
}

/** A Claude-compatible cli-pty adapter can be routed to another upstream. */
function isRoutable(adapterId: string): boolean {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty') return false;
  return adapter.env.passthrough.some((v) => v.startsWith('ANTHROPIC_'));
}

export function isProviderEnabled(adapterId: string): boolean {
  return configFor(adapterId).enabled;
}

/** Spawn-time overrides the PTY layer applies for a cli-agent session. */
export interface ProviderSpawnOverrides {
  binPath: string | null;
  defaultModel: string | null;
  extraArgs: string[];
  /** { ENV_VAR: key } to inject, or empty when no key is stored. */
  keyEnv: Record<string, string>;
  /** Env vars to strip so nothing hijacks an active subscription session. */
  suppressEnv: string[];
  /** Recibo da escolha de conta (pinada/regra/ativa/nativa/legada). */
  accountChoice?: AccountChoiceReceipt;
  /** Main-only account binding for the physical session; never part of the receipt. */
  selectedAccountId?: string;
  /**
   * F-724: ids que o provedor escolhido serve com outro modelo — o spawn troca
   * o `--model` pedido (ex.: `deepseek-flash` → `deepseek-v4-pro` no Token Plan).
   */
  modelAliases?: Readonly<Record<string, string>>;
}

/** Key/token env vars an adapter could pick up from the parent environment. */
function keyEnvVarsOf(adapterId: string): string[] {
  const adapter = getAdapter(adapterId);
  if (!adapter) return [];
  const vars = new Set<string>();
  const primary = primaryKeyEnvVar(adapter);
  if (primary) vars.add(primary);
  if (adapter.kind === 'cli-pty') {
    for (const name of adapter.env.passthrough) {
      if (/(_API_KEY|_AUTH_TOKEN)$/.test(name)) vars.add(name);
    }
  }
  return [...vars];
}

/** Native subscription OAuth must not be silently routed to an inherited
 * third-party base URL, nor lose precedence to an inherited API credential. */
function subscriptionSuppressEnvVars(adapterId: string): string[] {
  const adapter = getAdapter(adapterId);
  const vars = new Set(keyEnvVarsOf(adapterId));
  if (adapterId === 'kimi') {
    for (const name of KIMI_TRANSIENT_MODEL_ENV_KEYS) vars.add(name);
  }
  if (adapter?.kind === 'cli-pty') {
    for (const name of adapter.env.passthrough) {
      if (/^(ANTHROPIC|CLAUDE).*_BASE_URL$/.test(name)) vars.add(name);
    }
  }
  return [...vars];
}

function keyInjectionEnvVar(adapterId: string): string | null {
  const adapter = getAdapter(adapterId);
  if (!adapter) return null;
  return primaryKeyEnvVar(adapter) ?? keyEnvVarsOf(adapterId)[0] ?? null;
}

function nativeKeyEnv(
  adapterId: string,
  key: string,
  modelOverride?: string,
): Record<string, string> {
  if (adapterId === 'mimo-code' && key.startsWith('tp-')) {
    throw new Error('Use o login oficial da CLI MiMo para vincular o Token Plan e sua região.');
  }
  if (adapterId === 'kimi') {
    const adapter = getAdapter(adapterId);
    const model =
      modelOverride?.trim() ||
      configFor(adapterId).defaultModel ||
      adapter?.models.default ||
      'kimi-for-coding';
    return buildKimiApiKeyRuntimeEnv(key, model);
  }
  const envVar = keyInjectionEnvVar(adapterId);
  return envVar ? { [envVar]: key } : {};
}

function authDecision(
  adapterId: string,
  _selectedModel?: string,
  options: {
    statusSnapshot?: boolean;
  } = {},
) {
  const adapter = getAdapter(adapterId);
  const authMethod =
    adapter?.kind === 'cli-pty' ? adapter.auth.method : 'api_key';
  const probeSubscription = options.statusSnapshot || adapterId === 'agy'
    ? hasSubscriptionAuthForStatus : hasSubscriptionAuth;
  return resolveAuthStrategy({
    authMethod,
    hasStoredKey: hasRuntimeKey(adapterId),
    // AGY's native Keychain is always probed asynchronously before governed
    // spawn. Synchronous settings/spawn paths consume only that warm cache so
    // a locked login Keychain can never freeze Electron's main event loop.
    subscriptionAuthed: adapterId === 'mimo-code'
      ? probeSubscription(adapterId, effectiveProviderModel(adapterId, _selectedModel))
      : probeSubscription(adapterId),
  });
}

export function providerAuthStrategy(
  adapterId: string,
  selectedModel?: string,
): ProviderSettingsInfo['authStrategy'] {
  return authDecision(adapterId, selectedModel).strategy;
}

/**
 * Uncached auth decision for the final autonomous spawn boundary. Renderer/status
 * snapshots deliberately use the short cache; process creation must observe
 * the credential source as it exists now.
 */
async function authDecisionAuthoritativeAsync(
  adapterId: string,
  selectedModel?: string,
): Promise<AuthDecision> {
  if (adapterId !== 'agy') {
    return authDecision(adapterId, selectedModel);
  }
  const adapter = getAdapter(adapterId);
  const authMethod =
    adapter?.kind === 'cli-pty' ? adapter.auth.method : 'api_key';
  const result = await refreshAgySubscriptionAuthCache(
    os.homedir(),
    undefined,
    { authoritative: true },
  );
  return resolveAuthStrategy({
    authMethod,
    hasStoredKey: hasRuntimeKey(adapterId),
    subscriptionAuthed: result.value,
  });
}

export async function providerAuthStrategyAuthoritativeAsync(
  adapterId: string,
  selectedModel?: string,
): Promise<ProviderSettingsInfo['authStrategy']> {
  return (await authDecisionAuthoritativeAsync(adapterId, selectedModel))
    .strategy;
}

function effectiveProviderModel(
  adapterId: string,
  selectedModel?: string,
): string | undefined {
  const adapter = getAdapter(adapterId);
  // Migra antes da checagem de credencial: um default salvo que saiu do
  // catálogo (ex.: OpenCode free aposentado) não pode travar o spawn em
  // "sem login" quando o id para onde migra roda sem credencial.
  return migrateModelId(
    selectedModel?.trim() ||
    configFor(adapterId).defaultModel.trim() ||
    adapter?.models.default,
  );
}

/**
 * Resolve the API key/token for an adapter at runtime.
 * Priority (matches user mental model: launcher already works → Nexus must too):
 *  1. Nexus vault (`~/.nexus/secrets.enc` / keychain)
 *  2. ai-launcher `providers.conf` for this adapter id (e.g. `glm=…`)
 *  3. ai-launcher key for a routed upstream (claude + upstream=glm → glm key)
 *  4. process env vars declared by the adapter
 * Never logs the value.
 */
function resolveApiKey(adapterId: string, upstream?: string): string | null {
  // F-724: a chave do DeepSeek depende do provedor escolhido — cada um com
  // fontes próprias (a vaga `deepseek` nunca serve ao Token Plan).
  if (adapterId === DEEPSEEK_DIRECT_PROVIDER) {
    return resolveDeepseekProviderKey(deepseekChoice(upstream), { vault: 'read' });
  }
  const fromVault = getKey(adapterId);
  if (fromVault) return fromVault;
  return resolveApiKeyWithoutVault(adapterId, upstream);
}

/** Main-process request-time access; never expose the raw key through IPC. */
export function resolveRuntimeApiKey(adapterId: string): string | null {
  // F-724: quem pede a chave do DeepSeek em runtime (o intent router) fala
  // com api.deepseek.com — só a chave da API direta, qualquer que seja o
  // provedor dos panes. A do Token Plan nunca vai para a DeepSeek.
  if (adapterId === DEEPSEEK_DIRECT_PROVIDER) {
    return resolveDeepseekProviderKey(DEEPSEEK_DIRECT_PROVIDER, { vault: 'read' });
  }
  return resolveApiKey(adapterId);
}

/** Main-only quota read using the same config and precedence as native spawn. */
export function resolveQuotaApiKey(request: ApiQuotaKeyRequest): string | null {
  const { adapterId, accountId, usageProviderId, authMode } = request;
  if (!getAdapter(adapterId)) return null;
  const account = accountId ? getAccount(accountId) : null;
  if (accountId && (!account || account.adapterId !== adapterId || account.mode !== 'api-key')) return null;
  const currentMode = account?.mode ?? authDecision(adapterId, undefined, { statusSnapshot: true }).strategy;
  if (currentMode !== authMode) return null;
  const upstream = (account?.upstream ?? configFor(adapterId).upstream).trim();
  const hasRoute = Boolean(upstream && upstream !== 'anthropic');
  if (hasRoute && !isRoutable(adapterId)) return null;
  const target = hasRoute ? upstream : currentMode === 'api-key' ? adapterId : null;
  if (target !== usageProviderId) return null;
  if (account) {
    const key = `acctkey:${account.id}`;
    return hasCachedSecret(key) ? getSecret(key)?.trim() || null : null;
  }
  if (adapterId === DEEPSEEK_DIRECT_PROVIDER) {
    // F-724: a leitura de cota usa as fontes do provedor da própria linha —
    // a do Token Plan nunca devolve a chave da DeepSeek, e vice-versa.
    const choice = deepseekChoice(upstream);
    if (target !== choice) return null;
    const slot = deepseekKeyVaultSlot(choice);
    if (hasSecret(slot) && !hasCachedSecret(slot)) return null;
    return resolveDeepseekProviderKey(choice, {
      vault: 'cached',
      allowEnv: (name) => quotaEnvMatchesProvider(name, usageProviderId),
    });
  }
  // A cold owner credential could shadow every later source at spawn. Do not
  // decrypt it here or substitute a different account while it is unavailable.
  if (hasSecret(adapterId) && !hasCachedSecret(adapterId)) return null;
  const cached = hasCachedSecret(adapterId) ? getKey(adapterId) : null;
  if (cached) return cached;
  return resolveApiKeyWithoutVault(adapterId, upstream, (name) => quotaEnvMatchesProvider(name, usageProviderId));
}

/**
 * Host Anthropic-compatible de cada adapter host-Claude de terceiro.
 * Um ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY solto no env só é credencial do
 * provider quando ANTHROPIC_BASE_URL aponta para o host dele — sem o gate, um
 * token da z.ai (ou da própria Anthropic) era enviado para api.deepseek.com.
 *
 * F-724: o DeepSeek tem dois provedores e o id do provedor ESCOLHIDO decide o
 * host: `deepseek` (API direta) só aceita api.deepseek.com e
 * `deepseek-token-plan` só aceita o host do Token Plan da Alibaba.
 */
function anthropicHostForProvider(providerId: string): string | null {
  switch (providerId) {
    case 'glm':
    case 'glm-flash':
      return 'api.z.ai';
    case 'longcat':
      return 'api.longcat.chat';
    case DEEPSEEK_DIRECT_PROVIDER:
      return DEEPSEEK_DIRECT_HOST;
    case DEEPSEEK_TOKEN_PLAN_PROVIDER:
      return ALIBABA_TOKEN_PLAN_HOST;
    case 'muse-claude':
      return 'api.meta.ai';
    default:
      return null;
  }
}

/**
 * Token Anthropic genérico do env é credencial de `providerId` só com
 * ANTHROPIC_BASE_URL (HTTPS, sem credencial embutida) no host dele.
 */
function envAnthropicBaseUrlMatches(providerId: string): boolean {
  const host = anthropicHostForProvider(providerId);
  return host !== null && httpsHostOf(process.env.ANTHROPIC_BASE_URL) === host;
}

/** Valor não vazio de uma variável do env do processo (aparado). */
function envValue(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * F-724: a chave do slot `<id>` do launcher só vale para `host` quando o
 * próprio launcher não a amarrou a outro endpoint (`<id>-base-url`).
 */
function launcherKeyForHost(providerId: string, host: string): string | null {
  const key = loadLauncherProviderKey(providerId);
  if (!key) return null;
  const baseUrl = loadLauncherProviderBaseUrl(providerId);
  return baseUrl === null || httpsHostOf(baseUrl) === host ? key : null;
}

/**
 * Chave do launcher para uma rota de upstream (outra CLI Claude-compatible
 * roteada para ela). F-724: a da rota `deepseek` só vale se for da API direta
 * — nunca a `sk-sp-` que o launcher amarra ao Token Plan.
 */
function launcherKeyForRoute(route: string): string | null {
  if (route !== DEEPSEEK_DIRECT_PROVIDER) return loadLauncherProviderKey(route);
  const key = launcherKeyForHost(DEEPSEEK_DIRECT_PROVIDER, DEEPSEEK_DIRECT_HOST);
  return key && !isAlibabaPlanKey(key) ? key : null;
}

interface DeepseekKeyOptions {
  /**
   * `read` decifra o cofre (spawn); `cached` só aceita valor já em memória
   * (cota/snapshot, nunca cruza o Keychain); `skip` ignora o cofre.
   */
  readonly vault: 'read' | 'cached' | 'skip';
  /** Mesmo filtro de env do caminho genérico (cota: env do provider certo). */
  readonly allowEnv?: (name: string) => boolean;
}

/**
 * F-724: chave do provedor ESCOLHIDO do DeepSeek. As fontes são disjuntas:
 *  - API direta: cofre `deepseek` → launcher `deepseek` (sem base-url de outro
 *    host) → DEEPSEEK_API_KEY / ANTHROPIC_AUTH_TOKEN com BASE_URL na DeepSeek.
 *    Chave `sk-sp-` (plano da Alibaba) nunca sai para api.deepseek.com.
 *  - Token Plan: cofre `qwen` → launcher `qwen`/`dashscope`/`bailian` (e
 *    `deepseek` só se o launcher o amarra ao Token Plan) →
 *    BAILIAN_TOKEN_PLAN_API_KEY / DASHSCOPE_API_KEY / ANTHROPIC_AUTH_TOKEN com
 *    BASE_URL no Token Plan. Nunca a chave da DeepSeek.
 * O `~/.qwen/settings.json` não é fonte: o segredo do Qwen Code não é copiado
 * para outro processo (F-238). Nunca loga o valor.
 */
function resolveDeepseekProviderKey(
  choice: DeepseekProviderChoice,
  options: DeepseekKeyOptions,
): string | null {
  const plan = choice === DEEPSEEK_TOKEN_PLAN_PROVIDER;
  const accept = (key: string | null | undefined): string | null => {
    const value = key?.trim();
    if (!value) return null;
    return !plan && isAlibabaPlanKey(value) ? null : value;
  };
  const slot = deepseekKeyVaultSlot(choice);
  if (options.vault !== 'skip') {
    const fromVault =
      options.vault === 'read' || hasCachedSecret(slot) ? getKey(slot) : null;
    const accepted = accept(fromVault);
    if (accepted) return accepted;
  }
  const launcher = plan
    ? [
        launcherKeyForHost(TOKEN_PLAN_KEY_VAULT_SLOT, ALIBABA_TOKEN_PLAN_HOST),
        loadLauncherProviderBaseUrl(DEEPSEEK_DIRECT_PROVIDER) !== null
          ? launcherKeyForHost(DEEPSEEK_DIRECT_PROVIDER, ALIBABA_TOKEN_PLAN_HOST)
          : null,
      ]
    : [launcherKeyForHost(DEEPSEEK_DIRECT_PROVIDER, DEEPSEEK_DIRECT_HOST)];
  for (const key of launcher) {
    const accepted = accept(key);
    if (accepted) return accepted;
  }
  const envNames = plan
    ? [...TOKEN_PLAN_KEY_ENV_VARS, 'ANTHROPIC_AUTH_TOKEN']
    : ['ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY'];
  for (const name of envNames) {
    if (name === 'ANTHROPIC_AUTH_TOKEN' && !envAnthropicBaseUrlMatches(choice)) {
      continue;
    }
    const accepted = accept(envValue(name));
    if (!accepted) continue;
    if (options.allowEnv && !options.allowEnv(name)) return null;
    return accepted;
  }
  return null;
}

/**
 * F-238: um OPENAI_API_KEY solto no env só é credencial do Qwen quando
 * OPENAI_BASE_URL já aponta para a Alibaba (`*.aliyuncs.com`) — sem o gate,
 * uma chave OpenAI de outro provider seria tratada como credencial Qwen.
 */
function openAiHostMatchesProvider(providerId: string): boolean {
  if (providerId !== 'qwen') return false;
  try {
    const url = new URL(process.env.OPENAI_BASE_URL ?? '');
    const host = url.hostname;
    return (
      url.protocol === 'https:' &&
      (host === 'aliyuncs.com' || host.endsWith('.aliyuncs.com')) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * Gate genérico de variável de chave por host: devolve true quando a env var
 * `name` é prova de credencial deste provider. Vars sem regra retornam true
 * (comportamento histórico: qualquer valor presente conta).
 */
function genericEnvKeyAllowedForProvider(name: string, providerId: string): boolean {
  // Só o Qwen reaproveita a var da OpenAI para outro host; codex/opencode/
  // aider/openclaude continuam aceitando OPENAI_API_KEY como sempre.
  if (name === 'OPENAI_API_KEY' && providerId === 'qwen') return openAiHostMatchesProvider(providerId);
  return true;
}

function quotaEnvMatchesProvider(name: string, providerId: string): boolean {
  if (['ZAI_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY'].includes(name)) return ['glm', 'glm-flash', 'zai', 'zhipu'].includes(providerId);
  if (name === 'LONGCAT_API_KEY') return providerId === 'longcat';
  // F-724: a chave da DeepSeek é só da API direta; a do Token Plan é do Qwen
  // Code e do DeepSeek pelo plano — nunca uma no lugar da outra.
  if (name === 'DEEPSEEK_API_KEY') return providerId === DEEPSEEK_DIRECT_PROVIDER;
  if (name === 'MINIMAX_API_KEY') return providerId === 'minimax-code';
  if (['KIMI_MODEL_API_KEY', 'KIMI_API_KEY', 'KIMI_CODING_API_KEY', 'MOONSHOT_API_KEY'].includes(name)) return providerId === 'kimi';
  if (name === 'XAI_API_KEY') return providerId === 'grok';
  if (name === 'OPENAI_API_KEY') return openAiHostMatchesProvider(providerId);
  if ((TOKEN_PLAN_KEY_ENV_VARS as readonly string[]).includes(name)) {
    return providerId === 'qwen' || providerId === DEEPSEEK_TOKEN_PLAN_PROVIDER;
  }
  if (!['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(name)) return false;
  const host = anthropicHostForProvider(providerId);
  if (!host) return false;
  try {
    const url = new URL(process.env.ANTHROPIC_BASE_URL ?? '');
    return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password;
  } catch { return false; }
}

/** Exported for the pre-spawn credential probe (pty/pre-spawn-probe.ts). */
export function hasRuntimeKey(
  adapterId: string,
  _selectedModel?: string,
): boolean {
  // Provider readiness is queried during boot. Do not decrypt the vault here:
  // on macOS that crosses into SecItemCopyMatching and can block Electron's
  // main thread while the Keychain session is locked or stale. Presence in
  // the encrypted index is enough for readiness; the actual key is resolved
  // only when a provider is spawned.
  if (adapterId === DEEPSEEK_DIRECT_PROVIDER) {
    // F-724: a prontidão segue o provedor escolhido (vaga `deepseek` ou a do
    // Token Plan), nunca a soma dos dois.
    const choice = deepseekChoice();
    return (
      hasSecret(deepseekKeyVaultSlot(choice)) ||
      resolveDeepseekProviderKey(choice, { vault: 'skip' }) !== null
    );
  }
  if (hasSecret(adapterId)) return true;
  // F-238: a credencial do Qwen pode viver só em ~/.qwen/settings.json
  // (`env.BAILIAN_TOKEN_PLAN_API_KEY` / envKey por modelo) — conta como
  // `present`; a leitura nunca carrega o valor para fora do settings.
  if (adapterId === 'qwen' && qwenSettingsHasCredential()) return true;
  return resolveApiKeyWithoutVault(adapterId) !== null;
}

function resolveApiKeyWithoutVault(
  adapterId: string,
  upstream = configFor(adapterId).upstream,
  allowEnv?: (name: string) => boolean,
): string | null {
  if (adapterId === DEEPSEEK_DIRECT_PROVIDER) {
    return resolveDeepseekProviderKey(deepseekChoice(upstream), {
      vault: 'skip',
      ...(allowEnv ? { allowEnv } : {}),
    });
  }
  const fromLauncher = loadLauncherProviderKey(adapterId);
  if (fromLauncher) return fromLauncher;

  const route = upstream;
  if (route && route !== 'anthropic' && route !== adapterId) {
    const viaUpstream = launcherKeyForRoute(route);
    if (viaUpstream) return viaUpstream;
  }

  const anthropicHost = anthropicHostForProvider(adapterId);
  for (const name of keyEnvVarsOf(adapterId)) {
    if (
      anthropicHost !== null &&
      (name === 'ANTHROPIC_AUTH_TOKEN' || name === 'ANTHROPIC_API_KEY')
    ) {
      // Token Anthropic genérico só é deste provider se o BASE_URL do env já
      // aponta para o host dele — senão pode ser da Anthropic ou de outro
      // host-Claude e vazaria para o endpoint errado.
      try {
        const url = new URL(process.env.ANTHROPIC_BASE_URL ?? '');
        if (url.hostname !== anthropicHost) continue;
      } catch {
        continue;
      }
    }
    if (!genericEnvKeyAllowedForProvider(name, adapterId)) continue;
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      if (allowEnv && !allowEnv(name)) return null;
      return value.trim();
    }
  }
  return null;
}

function maskToken(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export interface ProviderReadiness {
  ready: boolean;
  reason: string;
}

function providerInfrastructureReadiness(adapterId: string): ProviderReadiness {
  const adapter = getAdapter(adapterId);
  if (!adapter) return { ready: false, reason: `unknown provider: ${adapterId}` };

  const cfg = configFor(adapterId);
  if (!cfg.enabled) {
    return {
      ready: false,
      reason: `${adapter.label} está desativado em Configurações › Contas de IA.`,
    };
  }

  if (adapter.kind === 'cli-pty') {
    const effectiveBin = cfg.binPath || adapter.bin;
    if (!isBinResolvable(effectiveBin)) {
      return {
        ready: false,
        // "Instale" mentia quando a CLI existe fora do PATH que o Nexus vê
        // (nvm, pnpm, instalador próprio). O caminho que funciona vem antes.
        reason:
          `${adapter.label} não foi encontrado no PATH do Nexus. Se já está ` +
          `instalado, use Configurações › Contas de IA › Reexaminar CLIs ou ` +
          `informe o caminho do binário. Para instalar: ${adapter.install.command}`,
      };
    }
  }

  return { ready: true, reason: 'ready' };
}

function resolveProviderReadiness(
  adapterId: string,
  selectedModel?: string,
  options: {
    decision?: AuthDecision;
  } = {},
): ProviderReadiness {
  const infrastructure = providerInfrastructureReadiness(adapterId);
  if (!infrastructure.ready) return infrastructure;

  const adapter = getAdapter(adapterId);
  if (!adapter) return infrastructure;

  const effectiveModel = effectiveProviderModel(adapterId, selectedModel);
  const decision =
    options.decision ?? authDecision(adapterId, selectedModel);
  if (adapterId === 'qwen' && decision.strategy === 'api-key' && listAccounts('qwen').length === 0) {
    const credential = peekQwenReadiness();
    if (credential.state === 'invalid-credential') return { ready: false, reason: 'Qwen: chave inválida. Atualize a chave em Contas de IA.' };
    if (credential.state === 'no-credential') return { ready: false, reason: 'Qwen: nenhuma chave utilizável foi encontrada.' };
  }
  if (decision.strategy === 'login-needed') {
    const credentiallessReady =
      isProviderAuthReadyForModel(
        { adapterId, authStrategy: decision.strategy },
        effectiveModel,
      );
    if (credentiallessReady) {
      return { ready: true, reason: 'ready' };
    }
    return {
      ready: false,
      reason:
        `${adapter.label} sem login/key configurado. ` +
        (adapter.kind === 'cli-pty'
          ? (adapter.auth.loginHint ?? 'Faça login na CLI ou configure a key.')
          : 'Configure a key do provider.'),
    };
  }

  return { ready: true, reason: 'ready' };
}

export function providerReadiness(
  adapterId: string,
  selectedModel?: string,
): ProviderReadiness {
  return resolveProviderReadiness(adapterId, selectedModel);
}

export function isProviderReady(adapterId: string, model?: string): boolean {
  return providerReadiness(adapterId, model).ready;
}

type PreparedAccount = Extract<
  ReturnType<typeof prepareAccountForSpawn>,
  { ok: true }
>;

/**
 * `isolatedHome`: a política de execução decidiu por um HOME isolado
 * (Hardened ou Claude-family de terceiro). Isso muda a credencial do Claude:
 * no HOME real o CLI usa e RENOVA sozinho a linhagem nativa (Keychain /
 * .credentials.json) e um token de env só atrapalha — é snapshot estático que
 * expira em horas e tem precedência sobre o login. No HOME efêmero o CLI não
 * enxerga essa linhagem, então o token de env é a única ponte possível.
 */
export interface ProviderPerSpawn {
  effort?: string;
  accountId?: string;
  model?: string;
  isolatedHome?: boolean;
  /** Main-only: an explicitly requested pane may let Muse check its native auth. */
  allowNativeAuthAttempt?: boolean;
  /**
   * F-235: contas com pane Claude VIVO na mesma missão — o pane novo nunca
   * nasce numa delas (duas cópias do refresh token colidem, F-645). Backstop
   * fail-closed: sem conta livre fora da exclusão o spawn recusa.
   */
  excludeAccountIds?: readonly string[];
}

/**
 * Credencial da assinatura Claude NATIVA para um pane não pinado.
 *
 * HOME real → `{}`: o CLI lê e RENOVA a própria linhagem (Keychain no macOS,
 * ~/.claude/.credentials.json no resto). `CLAUDE_CODE_OAUTH_TOKEN` ali seria um
 * snapshot estático com precedência sobre o login — expira em horas e o CLI não
 * refresca token de ambiente (401 no respawn de failover, caso de campo).
 *
 * HOME efêmero → token obrigatório: o CLI não enxerga a linhagem nativa a
 * partir dele. Sem token o pane abre em "Not logged in · Run /login" com a
 * máquina perfeitamente autenticada, e a identidade projetada no .claude.json
 * ainda escreve "Welcome back" — falha silenciosa que parecia bug de login.
 * Por isso aqui é fail-closed: melhor recusar o spawn com motivo do que
 * entregar um orquestrador mudo que trava a missão inteira.
 */
function nativeClaudeSubscriptionEnv(
  isolatedHome: boolean,
): Record<string, string> {
  if (!isolatedHome) return {};
  const nativeEnv = activeClaudeAuthEnv();
  if (!nativeEnv) {
    throw new Error(
      'não foi possível ler a credencial nativa do Claude (Keychain ' +
        'indisponível) para um pane com HOME isolado. Desbloqueie o login ' +
        'keychain ou rode `claude` num terminal para renovar a sessão',
    );
  }
  return nativeEnv;
}

function buildProviderSpawnOverrides(
  adapterId: string,
  perSpawn: ProviderPerSpawn,
  preparedAccount: PreparedAccount | null,
  options: {
    decision?: AuthDecision;
    nativeAuthAttempt?: boolean;
    selectedChoice?: ReturnType<typeof pickUnpinnedAccountWithHeadroom>;
    verifiedClaudeBlob?: string;
  } = {},
): ProviderSpawnOverrides {
  const cfg = configFor(adapterId);
  const adapter = getAdapter(adapterId);
  const credentiallessOpenCode =
    isCredentiallessOpenCodeModel(
      adapterId,
      effectiveProviderModel(adapterId, perSpawn.model),
    );
  // A conta do pane e o recibo de QUEM decidiu (pinada, regra de folga,
  // ativa, fallback, nativa ou legada) — rótulos sempre mascarados.
  const { account, receipt } = options.selectedChoice ?? resolveSpawnAccountChoice(
    adapterId, preparedAccount, options, credentiallessOpenCode,
  );
  if (adapterId === 'mimo-code' && account?.mode === 'subscription') {
    const blob = getSecret(`acctcred:${account.id}`);
    if (!blob || !mimoCredentialSupportsModel(blob, effectiveProviderModel(adapterId, perSpawn.model))) {
      throw new Error('Este modelo não está disponível na conta MiMo selecionada. Token Plan inclui Pro e Flash; UltraSpeed exige acesso API separado.');
    }
  }
  // Control flags (permission mode / effort / verbose) always apply, whatever
  // the auth/routing path — they're how the user turns on auto-operation.
  // Prefer: (1) valid user absolute override, (2) valid discovery cache,
  // (3) live resolve. Stale absolute paths must not block live PATH walk.
  // Spawn must receive an absolute path so the PTY host never re-searches a
  // different PATH for a bare command name.
  const userBin =
    cfg.binPath &&
    path.isAbsolute(cfg.binPath) &&
    revalidateExecutable(cfg.binPath)
      ? cfg.binPath
      : null;
  const cached = getAdapterResolvedBin(adapterId);
  const cachedValid =
    cached && revalidateExecutable(cached) ? cached : null;
  const discovered =
    userBin ?? cachedValid ?? resolveAdapterBinary(adapterId);
  // F-724: no Token Plan o DeepSeek só existe como v4-pro — o default salvo e
  // o `--model` pedido sobem nele em vez de morrer em 403.
  const deepseekPlan =
    adapterId === DEEPSEEK_DIRECT_PROVIDER &&
    deepseekChoice(cfg.upstream) === DEEPSEEK_TOKEN_PLAN_PROVIDER;
  // F-964: o default salvo só vale se a CLI ainda o oferece (listagem viva
  // autoritativa); senão o pane abre no default resolvido, nunca num fantasma.
  const offer = adapter ? currentModelOffer(adapter) : null;
  const savedDefault =
    cfg.defaultModel.trim() && adapter && offer
      ? effectiveDefaultModel(
          adapterId,
          cfg.defaultModel,
          offer.offered,
          offer.defaultModel,
        )
      : null;
  const base = {
    // Defense in depth (SEC#4): only an ABSOLUTE path is ever used as the
    // executable. A bare/relative binPath (e.g. from a hand-edited config) is
    // dropped so it can never resolve to an arbitrary binary off PATH; the
    // setConfig confirmation is the primary control.
    binPath:
      discovered && path.isAbsolute(discovered) && revalidateExecutable(discovered)
        ? discovered
        : null,
    defaultModel:
      savedDefault && deepseekPlan
        ? deepseekModelForProvider(savedDefault, DEEPSEEK_TOKEN_PLAN_PROVIDER)
        : savedDefault,
    extraArgs: [...controlArgsFor(adapterId, perSpawn.effort), ...cfg.extraArgs],
    accountChoice: receipt,
    ...(account ? { selectedAccountId: account.id } : {}),
    ...(deepseekPlan ? { modelAliases: DEEPSEEK_TOKEN_PLAN_MODEL_ALIASES } : {}),
  };

  if (options.nativeAuthAttempt) {
    // Let the CLI access its own store without copying credentials or swapping
    // to an implicit account. This is an attempt, not proof of authentication.
    return { ...base, keyEnv: {}, suppressEnv: [] };
  }

  // Both a pin and an automatic selection must use the chosen account's
  // own credential. Claude preparation must never switch the global Keychain.
  if (account) {
    if (account.mode === 'subscription') {
      if (adapterId === 'claude' && !preparedAccount) {
        const selected = prepareAccountForSpawn(adapterId, account.id, undefined, {
          isolatedHome: perSpawn.isolatedHome === true,
          ...(options.verifiedClaudeBlob ? { expectedClaudeBlob: options.verifiedClaudeBlob } : {}),
        });
        if (!selected.ok) throw new Error(selected.error);
        return {
          ...base,
          keyEnv: { ...selected.authEnv },
          suppressEnv: subscriptionSuppressEnvVars(adapterId),
        };
      }
      // Pane-pinned: account-scoped auth profile (or API credential).
      if (preparedAccount) {
        return {
          ...base,
          keyEnv: { ...preparedAccount.authEnv },
          suppressEnv: subscriptionSuppressEnvVars(adapterId),
        };
      }
      if (!ensureSubscriptionActive(account)) {
        throw new Error(
          `selected subscription "${account.label}" could not be activated`,
        );
      }
      // Other file providers use the selected account's managed home.
      // Fail closed for file-auth: empty keyEnv would silently use the system login.
      const keyEnv = fileSubscriptionAuthEnv(account);
      if (!keyEnv || Object.keys(keyEnv).length === 0) {
        throw new Error(
          `selected subscription "${account.label}" has no usable managed credential`,
        );
      }
      return {
        ...base,
        keyEnv,
        suppressEnv: subscriptionSuppressEnvVars(adapterId),
      };
    }

    // An exact account must use its own vault credential. Only an unpinned,
    // legacy active account retains providers.conf fallback compatibility.
    const accKey =
      preparedAccount?.apiKey ??
      accountKey(account) ??
      (adapterId === DEEPSEEK_DIRECT_PROVIDER
        // F-724: o fallback legado só lê o `deepseek=` do launcher que não
        // está amarrado a outro host.
        ? launcherKeyForHost(DEEPSEEK_DIRECT_PROVIDER, DEEPSEEK_DIRECT_HOST)
        : (account.upstream && account.upstream !== 'anthropic'
            ? launcherKeyForRoute(account.upstream)
            : null) ?? loadLauncherProviderKey(adapterId));
    if (adapterId === DEEPSEEK_DIRECT_PROVIDER) {
      // F-724: conta DeepSeek é chave da API direta e só sai para
      // api.deepseek.com — nem rota para a Alibaba, nem chave `sk-sp-`.
      if (
        account.upstream &&
        account.upstream !== 'anthropic' &&
        account.upstream !== DEEPSEEK_DIRECT_PROVIDER
      ) {
        throw new Error(
          `a conta "${account.label}" do DeepSeek só roteia para a API direta`,
        );
      }
      if (accKey && isAlibabaPlanKey(accKey)) {
        throw new Error(
          `a conta "${account.label}" guarda uma chave do Alibaba Token Plan ` +
            '(sk-sp-…), que nunca vai para api.deepseek.com — escolha o ' +
            'provedor "Alibaba Token Plan" em Providers › DeepSeek',
        );
      }
    } else if (
      account.upstream &&
      !upstreamAllowedForAdapter(adapterId, account.upstream)
    ) {
      throw new Error(
        `selected account "${account.label}" cannot route this provider`,
      );
    }
    if (account.upstream && account.upstream !== 'anthropic') {
      if (preparedAccount && !isRoutable(adapterId)) {
        throw new Error(
          `selected account "${account.label}" cannot route this provider`,
        );
      }
      const keyEnv = buildProviderRoutingEnv(account.upstream, accKey);
      if (preparedAccount && Object.keys(keyEnv).length === 0) {
        throw new Error(
          `selected account "${account.label}" has an invalid upstream route`,
        );
      }
      return { ...base, keyEnv, suppressEnv: [] };
    }
    const keyEnv = accKey
      ? nativeKeyEnv(adapterId, accKey, perSpawn.model)
      : {};
    if (preparedAccount && (!accKey || Object.keys(keyEnv).length === 0)) {
      throw new Error(
        `selected account "${account.label}" cannot inject its API credential`,
      );
    }
    return {
      ...base,
      keyEnv,
      suppressEnv: [],
    };
  }

  // Upstream routing (ai-launcher port): when a Claude-compatible CLI is
  // pointed at a non-native upstream (GLM, Fugu, …), inject the launcher's
  // ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + extras and DROP the native
  // API-key env (the launcher unsets ANTHROPIC_API_KEY for third parties).
  // An explicit route is the user's choice — it wins over subscription auth.
  if (adapterId === DEEPSEEK_DIRECT_PROVIDER) {
    // F-724: o DeepSeek sempre sobe pela rota do provedor escolhido, com a
    // chave DESSE provedor. Sem chave o spawn é recusado: um pane sem token
    // no endpoint de terceiro só morreria depois, mudo.
    const choice = deepseekChoice(cfg.upstream);
    const key = resolveDeepseekProviderKey(choice, { vault: 'read' });
    if (!key) {
      throw new Error(
        choice === DEEPSEEK_TOKEN_PLAN_PROVIDER
          ? 'DeepSeek pelo Alibaba Token Plan sem a chave do Token Plan — ' +
              'cole-a em Providers › DeepSeek (é a mesma do Qwen Code).'
          : 'DeepSeek (API direta) sem chave da DeepSeek — cole-a em ' +
              'Providers › DeepSeek. Chave sk-sp-… é do Alibaba Token Plan: ' +
              'escolha esse provedor.',
      );
    }
    const keyEnv = buildProviderRoutingEnv(choice, key);
    if (Object.keys(keyEnv).length === 0) {
      throw new Error(`DeepSeek: rota "${choice}" indisponível`);
    }
    return {
      ...base,
      keyEnv,
      // Nada da API direta entra no processo que fala com a Alibaba.
      suppressEnv: choice === DEEPSEEK_TOKEN_PLAN_PROVIDER ? ['DEEPSEEK_API_KEY'] : [],
    };
  }
  if (cfg.upstream && cfg.upstream !== 'anthropic' && isRoutable(adapterId)) {
    if (!upstreamAllowedForAdapter(adapterId, cfg.upstream)) {
      throw new Error(`${adapter?.label ?? adapterId}: rota "${cfg.upstream}" não serve a este provider`);
    }
    const key = resolveApiKey(adapterId, cfg.upstream);
    return {
      ...base,
      keyEnv: buildProviderRoutingEnv(cfg.upstream, key),
      suppressEnv: [],
    };
  }

  // Subscription-first (user directive): an authenticated subscription CLI
  // never receives an API key — and inherited key vars are stripped so they
  // cannot hijack billing. The key only flows when there is no subscription.
  const decision =
    options.decision ??
    authDecision(adapterId, perSpawn.model);
  // `getKey()` may synchronously cross the macOS Keychain boundary. Keep that
  // effect behind the exact API-key decision so a healthy native subscription
  // can never stall the Electron main thread on an irrelevant vault prompt.
  const key = decision.injectKey
    ? resolveApiKey(adapterId, cfg.upstream)
    : null;
  const keyEnv =
    decision.injectKey && adapter && key
      ? nativeKeyEnv(adapterId, key, perSpawn.model)
      : decision.strategy === 'subscription' && adapterId === 'claude'
        ? nativeClaudeSubscriptionEnv(perSpawn.isolatedHome === true)
        : {};
  return {
    ...base,
    keyEnv,
    suppressEnv: decision.suppressKeyEnv
      ? subscriptionSuppressEnvVars(adapterId)
      : [],
  };
}

export type ProviderSpawnPreparation =
  | { ok: true; overrides: ProviderSpawnOverrides }
  | { ok: false; error: string };

function prepareProviderSpawnWithDecision(
  adapterId: string,
  perSpawn: ProviderPerSpawn,
  spawnDecision: AuthDecision | undefined,
  selectedChoice?: ReturnType<typeof pickUnpinnedAccountWithHeadroom>,
  verifiedClaudeBlob?: string,
): ProviderSpawnPreparation {
  const infrastructure = providerInfrastructureReadiness(adapterId);
  if (!infrastructure.ready) {
    return { ok: false, error: infrastructure.reason };
  }
  const nativeAuthAttempt =
    adapterId === 'muse' &&
    perSpawn.allowNativeAuthAttempt === true &&
    perSpawn.isolatedHome === false &&
    !perSpawn.accountId &&
    spawnDecision?.strategy === 'login-needed' &&
    subscriptionAuthStatusIsUnknown(adapterId);
  const managedAccountSelection = !perSpawn.accountId &&
    adapterId === 'claude' && listAccounts(adapterId).length > 0;
  const readiness = perSpawn.accountId || nativeAuthAttempt || managedAccountSelection
    ? infrastructure
    : resolveProviderReadiness(adapterId, perSpawn.model, {
        decision: spawnDecision,
      });
  if (!readiness.ready) return { ok: false, error: readiness.reason };

  let preparedAccount: PreparedAccount | null = null;
  if (
    perSpawn.accountId &&
    adapterId === DEEPSEEK_DIRECT_PROVIDER &&
    deepseekChoice() === DEEPSEEK_TOKEN_PLAN_PROVIDER
  ) {
    return { ok: false, error: DEEPSEEK_TOKEN_PLAN_ACCOUNT_ERROR };
  }
  if (perSpawn.accountId) {
    const prepared = prepareAccountForSpawn(
      adapterId,
      perSpawn.accountId,
      undefined,
      { isolatedHome: perSpawn.isolatedHome === true,
        ...(verifiedClaudeBlob ? { expectedClaudeBlob: verifiedClaudeBlob } : {}) },
    );
    if (!prepared.ok) return prepared;
    preparedAccount = prepared;
  }

  try {
    return {
      ok: true,
      overrides: buildProviderSpawnOverrides(
        adapterId,
        perSpawn,
        preparedAccount,
        { decision: spawnDecision, nativeAuthAttempt, selectedChoice, verifiedClaudeBlob },
      ),
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'provider account is not activatable',
    };
  }
}

/** Snapshot de scores de quota do adapter; undefined quando não há medição. */
function quotaScoresFor(
  adapterId: string,
): ReadonlyMap<string, number> | undefined {
  try {
    const snap = requireQuotaService().lastSnapshot();
    if (!snap) return undefined;
    const scores = new Map<string, number>();
    for (const entry of snap.entries) {
      if (entry.adapterId === adapterId && entry.accountId) {
        scores.set(entry.accountId, quotaAvailabilityScore(entry));
      }
    }
    return scores.size > 0 ? scores : undefined;
  } catch {
    /* quota service opcional na corrida de boot — sem medição */
    return undefined;
  }
}

/**
 * F-969: janelas medidas por conta do adapter — a regra de folga compara só
 * janelas comparáveis. undefined quando não há medição.
 */
function quotaHeadroomFor(
  adapterId: string,
): ReadonlyMap<string, HeadroomInput> | undefined {
  try {
    const snap = requireQuotaService().lastSnapshot();
    return snap ? headroomInputsByAccount(snap.entries, adapterId) : undefined;
  } catch {
    /* quota service opcional na corrida de boot — sem medição */
    return undefined;
  }
}

function quotaEntryFor(
  adapterId: string,
  accountId: string,
): ProviderQuotaEntry | undefined {
  try {
    const snap = requireQuotaService().lastSnapshot();
    return snap?.entries.find(
      (e) => e.adapterId === adapterId && e.accountId === accountId,
    );
  } catch {
    return undefined;
  }
}

/**
 * A janela que limita a conta (F-969): a medida mais apertada, com reset.
 * Janela sem leitura não entra — nunca vira "0% usado".
 */
function headroomFromEntry(entry: ProviderQuotaEntry): AccountHeadroom {
  const binding = bindingHeadroomWindow(entry);
  return {
    usedPct: binding ? Math.round(binding.usedRatio * 100) : null,
    window: binding?.label ?? null,
    resetsAt: binding?.resetsAt ?? null,
    score: quotaAvailabilityScore(entry),
  };
}

function headroomFor(
  adapterId: string,
  accountId: string,
): AccountHeadroom | null {
  const entry = quotaEntryFor(adapterId, accountId);
  return entry ? headroomFromEntry(entry) : null;
}

function receiptAccount(account: Account): {
  label: string;
  mode: 'subscription' | 'api_key' | 'unknown';
} {
  return {
    label: maskAccountLabel(account.label),
    mode:
      account.mode === 'api-key'
        ? 'api_key'
        : account.mode === 'subscription'
          ? 'subscription'
          : 'unknown',
  };
}

/**
 * As outras contas do adapter e o motivo categórico de cada derrota.
 * F-969: o motivo é verdadeiro — conta fixada/nativa não concorreu
 * (`not-compared`); sob "ativa mantida" a irmã com MAIS folga em janelas
 * comparáveis aparece como `active-kept`, nunca como "menos folga".
 */
function accountChoiceAlternatives(
  adapterId: string,
  chosenId: string | null,
  quota: ReadonlyMap<string, HeadroomInput> | undefined,
  now: number,
  competed = true,
): AccountChoiceAlternative[] {
  const chosen = chosenId ? quota?.get(chosenId) : undefined;
  return listAccounts(adapterId)
    .filter((a) => a.id !== chosenId)
    .map((a) => {
      const entry = quotaEntryFor(adapterId, a.id);
      const head = entry ? headroomFromEntry(entry) : null;
      const skipped = isAccountBlockedForScope(a.id, now)
        ? ('cooldown' as const)
        : !accountHasFailoverCredential(a)
          ? ('no-credential' as const)
          : !competed
            ? ('not-compared' as const)
            : !quota?.has(a.id)
              ? ('unknown-quota' as const)
              : chosenId !== null &&
                  compareAccountHeadroom(quota.get(a.id), chosen) > 0
                ? ('active-kept' as const)
                : ('less-headroom' as const);
      return {
        label: maskAccountLabel(a.label),
        usedPct: head?.usedPct ?? null,
        window: head?.window ?? null,
        resetsAt: head?.resetsAt ?? null,
        skipped,
      };
    });
}

/**
 * A conta do pane + o recibo de quem decidiu: pinada pelo chamador, regra de
 * folga, ativa mantida, fallback na ativa, linhagem nativa ou caminho legado.
 */
function resolveSpawnAccountChoice(
  adapterId: string,
  preparedAccount: PreparedAccount | null,
  options: { decision?: AuthDecision; nativeAuthAttempt?: boolean },
  credentiallessOpenCode: boolean,
): { account: Account | null; receipt: AccountChoiceReceipt } {
  const decidedAt = Date.now();
  if (options.nativeAuthAttempt) {
    return {
      account: null,
      receipt: {
        adapterId,
        source: 'native',
        account: null,
        headroom: null,
        alternatives: [],
        decidedAt,
      },
    };
  }
  if (preparedAccount) {
    const account = preparedAccount.account;
    return {
      account,
      receipt: {
        adapterId,
        source: 'pinned',
        account: receiptAccount(account),
        headroom: headroomFor(adapterId, account.id),
        // Fixada pelo chamador: as irmãs não concorreram (F-969).
        alternatives: accountChoiceAlternatives(
          adapterId,
          account.id,
          quotaHeadroomFor(adapterId),
          decidedAt,
          false,
        ),
        decidedAt,
      },
    };
  }
  if (
    adapterId === DEEPSEEK_DIRECT_PROVIDER &&
    deepseekChoice() === DEEPSEEK_TOKEN_PLAN_PROVIDER
  ) {
    // F-724: contas DeepSeek guardam chaves da API direta; no Token Plan o
    // pane usa a chave do plano e nenhuma conta da DeepSeek é escolhida.
    return {
      account: null,
      receipt: {
        adapterId,
        source: 'legacy',
        account: null,
        headroom: null,
        alternatives: [],
        decidedAt,
        note: 'provedor Alibaba Token Plan: contas DeepSeek (API direta) não se aplicam',
      },
    };
  }
  const hasManagedAccounts = listAccounts(adapterId).length > 0;
  const nativeLineage =
    (adapterId === 'claude' && !hasManagedAccounts) ||
    (adapterId === 'agy' && options.decision?.strategy === 'subscription') ||
    credentiallessOpenCode;
  if (!nativeLineage && hasManagedAccounts) {
    return pickUnpinnedAccountWithHeadroom(adapterId);
  }
  if (adapterId === 'agy' && nativeLineage && hasManagedAccounts && process.platform === 'win32') {
    // F-677: no Windows a "sessão nativa" do AGY é a conta da vaga única do
    // keyring. O pane nasce fixado nela — o failover precisa saber QUAL conta
    // esgotou — e, se ela já está em cooldown, a regra de folga escolhe a
    // irmã, que o preparo autoritativo grava na vaga.
    // Vaga ilegível: segue a linhagem nativa (nunca troca por conta velha).
    const slotOwner = agyKeyringSlotAccount();
    if (slotOwner && isAccountBlockedForScope(slotOwner.id, decidedAt)) {
      return pickUnpinnedAccountWithHeadroom(adapterId);
    }
    if (slotOwner) {
      return {
        account: slotOwner,
        receipt: {
          adapterId,
          source: 'native',
          account: receiptAccount(slotOwner),
          headroom: headroomFor(adapterId, slotOwner.id),
          alternatives: accountChoiceAlternatives(
            adapterId,
            slotOwner.id,
            quotaHeadroomFor(adapterId),
            decidedAt,
            false,
          ),
          decidedAt,
        },
      };
    }
  }
  return {
    account: null,
    receipt: {
      adapterId,
      source: nativeLineage ? 'native' : 'legacy',
      account: null,
      headroom: null,
      alternatives: [],
      decidedAt,
    },
  };
}

/**
 * Pane sem conta pinada nasce na conta ativa enquanto ela ainda tem cota.
 * A irmã só entra quando a ativa mede disponibilidade zero ou sai da lista
 * (cooldown, sem credencial, excluída pelo hit). Sem snapshot a ativa
 * permanece. Nenhuma conta livre NÃO bloqueia o spawn: abre na ativa e avisa.
 */
function pickUnpinnedAccountWithHeadroom(
  adapterId: string,
  excludeIds?: ReadonlySet<string>,
): { account: Account | null; receipt: AccountChoiceReceipt } {
  const decidedAt = Date.now();
  const active = getActiveAccount(adapterId);
  const quotaScores = quotaScoresFor(adapterId);
  // F-969: folga comparada só entre janelas comparáveis.
  const quotaByAccountId = quotaHeadroomFor(adapterId);
  const pickOptions = {
    ...(excludeIds?.size ? { excludeIds } : {}),
    ...(quotaByAccountId ? { quotaByAccountId } : {}),
  };
  const picked = (
    Object.keys(pickOptions).length > 0
      ? pickAvailableForFailover(adapterId, null, decidedAt, quotaScores, pickOptions)
      : pickAvailableForFailover(adapterId, null, decidedAt, quotaScores)
  ).account;
  // F-235: exclusões vêm de panes Claude vivos na mesma missão. Se nada livre
  // sobra, cair no active-fallback poria dois panes na MESMA conta (duas
  // cópias do refresh token colidem, F-645) — fail-closed com recibo
  // categórico que o prepare autoritativo transforma em erro visível.
  if (!picked && excludeIds?.size) {
    const note =
      'claude_accounts_in_use: todas as contas Claude com credencial já ' +
      'têm pane vivo nesta missão';
    console.warn(`[spawn] ${note} (${adapterId})`);
    return {
      account: null,
      receipt: {
        adapterId,
        source: 'legacy',
        account: null,
        headroom: null,
        alternatives: accountChoiceAlternatives(
          adapterId,
          null,
          quotaByAccountId,
          decidedAt,
        ),
        decidedAt,
        note,
      },
    };
  }
  const alternatives = accountChoiceAlternatives(
    adapterId,
    picked?.id ?? null,
    quotaByAccountId,
    decidedAt,
  );
  if (picked) {
    if (active && picked.id !== active.id) {
      console.warn(
        `[spawn] conta ativa "${active.label}" sem folga; pane nasce em "${picked.label}" (${adapterId})`,
      );
    }
    return {
      account: picked,
      receipt: {
        adapterId,
        source:
          active && picked.id === active.id ? 'active' : 'headroom-rule',
        account: receiptAccount(picked),
        headroom: headroomFor(adapterId, picked.id),
        alternatives,
        decidedAt,
      },
    };
  }
  // Nada livre com credencial (quota fora do ar ou tudo em bloco): abre no
  // caminho legado — ativa quando existir, providers.conf quando não — e avisa.
  if (active) {
    // O log do Main pode nomear a conta; o recibo viaja até o agente e só
    // carrega o rótulo mascarado.
    console.warn(
      `[spawn] nenhuma conta livre com credencial para ${adapterId}; ` +
        `abrindo na ativa "${active.label}"`,
    );
    return {
      account: active,
      receipt: {
        adapterId,
        source: 'active-fallback',
        account: receiptAccount(active),
        headroom: headroomFor(adapterId, active.id),
        alternatives,
        decidedAt,
        note:
          `nenhuma conta livre com credencial para ${adapterId}; ` +
          `abrindo na ativa "${maskAccountLabel(active.label)}"`,
      },
    };
  }
  const note =
    `[spawn] nenhuma conta livre com credencial para ${adapterId}; ` +
    'abrindo no caminho legado';
  console.warn(note);
  return {
    account: null,
    receipt: {
      adapterId,
      source: 'legacy',
      account: null,
      headroom: null,
      alternatives,
      decidedAt,
      note,
    },
  };
}

/**
 * Modelo salvo desconhecido não desce para o pane (paridade Overclock 1.3.18:
 * "unknown model slug, leaving settings.model untouched"). A preferência do
 * usuário permanece no disco — o spawn usa o default do adapter até a
 * descoberta viva voltar a conhecer o slug. Aviso uma vez por slug.
 */
const warnedUnknownModelSlugs = new Set<string>();

export function effectiveDefaultModel(
  adapterId: string,
  savedDefault: string,
  knownModels: readonly string[],
  adapterDefault: string,
): string {
  const saved = migrateModelId(savedDefault.trim()) ?? '';
  if (!saved) return adapterDefault;
  if (knownModels.includes(saved)) return saved;
  const warnKey = `${adapterId}:${saved}`;
  if (!warnedUnknownModelSlugs.has(warnKey)) {
    warnedUnknownModelSlugs.add(warnKey);
    console.warn(
      `[${adapterId}] modelo salvo "${saved}" desconhecido pela CLI; ` +
        `pane usa o default "${adapterDefault}" (preferência mantida)`,
    );
  }
  return adapterDefault;
}

/** Resolve cached spawn-time auth synchronously, before node-pty is touched. */
export function prepareProviderSpawn(
  adapterId: string,
  perSpawn: ProviderPerSpawn = {},
): ProviderSpawnPreparation {
  return prepareProviderSpawnWithDecision(
    adapterId,
    perSpawn,
    perSpawn.accountId
      ? undefined
      : authDecision(adapterId, perSpawn.model),
  );
}

/**
 * Resolve live Keychain-only auth asynchronously at the final spawn boundary.
 * This keeps Electron's main event loop out of SecItemCopyMatching while
 * ensuring a stale status cache cannot route a signed-in CLI through the vault.
 */
export async function prepareProviderSpawnAuthoritative(
  adapterId: string,
  perSpawn: ProviderPerSpawn = {},
): Promise<ProviderSpawnPreparation> {
  const infrastructure = providerInfrastructureReadiness(adapterId);
  if (!infrastructure.ready) {
    return { ok: false, error: infrastructure.reason };
  }
  let spawnDecision: AuthDecision | undefined;
  if (!perSpawn.accountId) {
    try {
      spawnDecision = await authDecisionAuthoritativeAsync(
        adapterId,
        perSpawn.model,
      );
    } catch {
      return {
        ok: false,
        error:
          adapterId === 'agy'
            ? 'não foi possível verificar a sessão nativa do AGY; desbloqueie o Keychain e tente novamente'
            : 'não foi possível verificar a autenticação do provider',
      };
    }
  }
  // A synchronous prepare can write the chosen Claude credential into its
  // managed auth store. Prove the account *before* crossing that boundary.
  const selectedChoice = adapterId === 'claude' && !perSpawn.accountId &&
    listAccounts('claude').length > 0
    ? pickUnpinnedAccountWithHeadroom(
        'claude',
        perSpawn.excludeAccountIds?.length
          ? new Set(perSpawn.excludeAccountIds)
          : undefined,
      )
    : undefined;
  // F-235: com exclusões de missão e nenhuma conta livre, o picker devolve o
  // recibo fail-closed em vez do active-fallback — aqui vira recusa visível.
  if (selectedChoice?.receipt.note?.startsWith('claude_accounts_in_use')) {
    return { ok: false, error: selectedChoice.receipt.note };
  }
  const account = perSpawn.accountId
    ? getAccount(perSpawn.accountId)
    : selectedChoice?.account;
  let verifiedClaudeBlob: string | undefined;
  if (adapterId === 'claude' && account?.mode === 'subscription') {
    const identity = await verifyManagedClaudeAccountForSpawn(account.id, (blob) => {
      verifiedClaudeBlob = blob;
    });
    if (identity !== 'match') {
      return { ok: false, error: identity === 'mismatch'
        ? `A credencial de “${account.label}” pertence a outra conta Claude — entre novamente antes de abrir um pane.`
        : identity === 'auth-expired'
          ? `A sessão de “${account.label}” expirou — entre novamente antes de abrir um pane.`
          : `Não foi possível verificar a identidade de “${account.label}” — tente novamente.` };
    }
    const current = getAccount(account.id);
    if (!current || current.adapterId !== account.adapterId ||
        current.mode !== account.mode ||
        current.email?.trim().toLowerCase() !== account.email?.trim().toLowerCase()) {
      return { ok: false, error: 'A conta Claude mudou durante a verificação — tente novamente.' };
    }
    if (!verifiedClaudeBlob) {
      return { ok: false, error: 'Não foi possível fixar a credencial Claude verificada — tente novamente.' };
    }
  }
  const prepared = prepareProviderSpawnWithDecision(
    adapterId,
    perSpawn,
    spawnDecision,
    selectedChoice,
    verifiedClaudeBlob,
  );
  // F-677: no Windows a conta AGY do pane é a da vaga única do keyring — a
  // conta escolhida (pin, rotação por limite, headroom) vai para a vaga agora.
  // Conta por chave de API não passa pela vaga (a chave vai por ENV).
  const agySelected = prepared.ok && adapterId === 'agy' && prepared.overrides.selectedAccountId
    ? getAccount(prepared.overrides.selectedAccountId)
    : null;
  if (agySelected?.mode === 'subscription') {
    const activation = await activateAgyAccountForSpawn(agySelected.id);
    if (!activation.ok) return { ok: false, error: activation.error };
  }
  return prepared;
}

/** Backward-compatible strict accessor for non-IPC callers. */
export function providerSpawnOverrides(
  adapterId: string,
  perSpawn: ProviderPerSpawn = {},
): ProviderSpawnOverrides {
  const prepared = prepareProviderSpawn(adapterId, perSpawn);
  if (!prepared.ok) throw new Error(prepared.error);
  return prepared.overrides;
}

function toInfo(
  adapterId: string,
  options: { nonBlockingAuth?: boolean } = {},
): ProviderSettingsInfo | null {
  const adapter = getAdapter(adapterId);
  if (!adapter) return null;
  const cfg = configFor(adapterId);
  // Prefer the absolute path from discovery so UI and spawn agree.
  // Cache first; live-resolve only on miss so listing N providers does not
  // re-walk PATH when the registry is already warm.
  let resolved: string | null = null;
  if (adapter.kind !== 'api-provider') {
    const cached = getAdapterResolvedBin(adapterId);
    resolved =
      cached && revalidateExecutable(cached)
        ? cached
        : resolveAdapterBinary(adapterId);
  }
  const cliInstallationWarning = adapter.kind === 'cli-pty' && !cfg.binPath
    ? resolveCliBinary(adapter.bin)?.installationWarning : undefined;
  const detectedBin =
    adapter.kind !== 'api-provider'
      ? resolved || adapter.bin
      : adapter.endpoint;
  const userBinOk =
    Boolean(cfg.binPath) &&
    path.isAbsolute(cfg.binPath) &&
    revalidateExecutable(cfg.binPath);
  const installed =
    adapter.kind !== 'api-provider'
      ? Boolean(userBinOk || resolved)
      : true;
  // F-964 (PRV-01): a oferta é a listagem viva da CLI (+ custom do operador),
  // não a união estático ∪ catálogo ∪ descoberta. Falha mantém a última boa;
  // listagem vazia com sucesso limpa; o que a CLI não lista vira unverified.
  const offer = currentModelOffer(adapter);
  // F-724: o catálogo do DeepSeek é o que o provedor escolhido serve (no
  // Token Plan só o v4-pro; o flash dá 403).
  const deepseekSelected =
    adapterId === DEEPSEEK_DIRECT_PROVIDER ? deepseekChoice(cfg.upstream) : null;
  const models = deepseekSelected
    ? deepseekModelsForProvider([...offer.offered], deepseekSelected)
    : [...offer.offered];
  const keySlot = deepseekSelected
    ? deepseekKeyVaultSlot(deepseekSelected)
    : adapterId;
  const resolveKeyWithoutVault = (): string | null =>
    deepseekSelected
      ? resolveDeepseekProviderKey(deepseekSelected, { vault: 'skip' })
      : resolveApiKeyWithoutVault(adapterId);
  const qwenUsesConfiguredKey = adapterId === 'qwen' && listAccounts('qwen').length === 0 &&
    authDecision(adapterId, undefined, { statusSnapshot: options.nonBlockingAuth === true }).strategy === 'api-key';
  if (qwenUsesConfiguredKey && cfg.enabled && installed) {
    if (hasSecret('qwen') && !hasCachedSecret('qwen')) {
      // A cold encrypted vault cannot be replaced by a different settings key.
      invalidateQwenReadiness();
    } else {
      void requestQwenReadiness({ key: (hasCachedSecret('qwen') ? getKey('qwen') : null) ?? resolveKeyWithoutVault(),
        onChange: broadcast });
    }
  }
  const credentialReadiness = qwenUsesConfiguredKey ? peekQwenReadiness().state : undefined;
  const authReadyModels = models.filter((model) => {
    const strategy = authDecision(adapterId, model, {
      statusSnapshot: options.nonBlockingAuth === true,
    }).strategy;
    if (strategy === 'api-key' && (credentialReadiness === 'invalid-credential' || credentialReadiness === 'no-credential')) return false;
    return isProviderAuthReadyForModel(
      { adapterId, authStrategy: strategy },
      model,
    );
  });
  const defaultModel = effectiveDefaultModel(
    adapterId,
    cfg.defaultModel,
    models,
    models.includes(offer.defaultModel) ? offer.defaultModel : adapter.models.default,
  );
  const strategy = authDecision(adapterId, defaultModel, {
    statusSnapshot: options.nonBlockingAuth === true,
  }).strategy;
  // F-966: o aviso de versão aparece aqui ANTES de qualquer spawn — versão já
  // sondada do binário que o spawn usaria (nunca executa a CLI aqui).
  const spawnBin = userBinOk ? cfg.binPath : resolved;
  const cliCompatibilityWarning = adapter.kind === 'cli-pty' && spawnBin
    ? cliVersionWarnings({
        bin: adapter.bin,
        version: cachedCliBinaryVersion(spawnBin) ?? null,
        model: defaultModel,
      }).join(' ')
    : '';
  return {
    adapterId,
    label: adapter.label,
    icon: adapter.icon,
    kind: adapter.kind,
    enabled: cfg.enabled,
    installed,
    canAutoInstall: cliInstallRecipeFor(adapterId) !== null,
    installCommand:
      cliInstallCommandFor(adapterId) ??
      (adapter.kind === 'cli-pty'
        ? compatibleManualInstallCommand(adapter.install?.command)
        : undefined) ?? undefined,
    binPath: cfg.binPath,
    detectedBin,
    ...(cliInstallationWarning ? { cliInstallationWarning } : {}),
    ...(cliCompatibilityWarning ? { cliCompatibilityWarning } : {}),
    defaultModel,
    models,
    ...(offer.unverified.length > 0 ? { unverifiedModels: [...offer.unverified] } : {}),
    modelListSource: offer.source,
    authReadyModels,
    ...(strategy === 'api-key' && credentialReadiness ? { credentialReadiness } : {}),
    modelInfo: modelInfoForAdapter(loadModelCatalog(), adapterId, models),
    customModels: getCustomModels(adapterId),
    extraArgs: cfg.extraArgs,
    keyEnvVar: primaryKeyEnvVar(adapter),
    hasKey: hasRuntimeKey(adapterId, defaultModel),
    // Prefer vault mask; if only the launcher has the key, mask that instead
    // so Settings doesn't look "empty" while readiness is already true.
    keyMasked: maskedRuntimeKey(keySlot, resolveKeyWithoutVault),
    authMethod: adapter.kind === 'cli-pty' ? adapter.auth.method : 'api_key',
    loginHint:
      adapter.kind === 'cli-pty' ? adapter.auth.loginHint : undefined,
    loginCommand:
      adapter.kind === 'cli-pty'
        ? (adapterId === 'kimi'
            ? kimiLoginCommand()
            : (resolveCliLoginCommand({
                loginCommand: adapter.auth.loginCommand,
                authMethod: adapter.auth.method,
                interactive: adapter.spawn.interactive,
              }) ?? undefined))
        : undefined,
    secureStorageAvailable: isSecureStorageAvailable({ probe: false }),
    authStrategy: strategy,
    authState: strategy !== 'login-needed' ? 'ok' :
      subscriptionAuthStatusIsUnknown(adapterId) ? 'unknown' : 'missing',
    upstream: deepseekSelected ?? (cfg.upstream || 'anthropic'),
    routable: isRoutable(adapterId),
    upstreams: listUpstreamProviders().map((p) => ({
      id: p.id,
      label: p.label,
      requiresToken: p.requiresToken,
    })),
    ...(deepseekSelected
      ? { providerChoice: deepseekProviderChoiceInfo(deepseekSelected) }
      : {}),
    ...(deepseekSelected === DEEPSEEK_TOKEN_PLAN_PROVIDER
      ? { modelAliases: { ...DEEPSEEK_TOKEN_PLAN_MODEL_ALIASES } }
      : {}),
    permissionMode: cfg.permissionMode,
    permissionModes:
      adapter.kind === 'cli-pty' ? availablePermissionModes(adapter) : [],
    effort: cfg.effort,
    efforts: adapter.kind === 'cli-pty' ? availableEfforts(adapter) : [],
    verbose: cfg.verbose,
    supportsVerbose: adapter.kind === 'cli-pty' ? supportsVerbose(adapter) : false,
    // L4: true when the key comes from the plaintext launcher providers.conf
    // (not the encrypted vault). The UI should warn about cleartext storage.
    plaintextKeyFallback: !hasCachedSecret(keySlot) && !hasSecret(keySlot)
      ? resolveKeyWithoutVault() !== null
      : false,
  };
}

/**
 * Máscara da chave de uma vaga para o snapshot da UI. Valor em cache é seguro
 * de mascarar; no boot frio só o índice cifrado é consultado — nunca decifra
 * o Keychain para montar o snapshot.
 */
function maskedRuntimeKey(
  slot: string,
  resolveWithoutVault: () => string | null,
): string | null {
  const vault = hasCachedSecret(slot) ? maskedKey(slot) : null;
  if (vault) return vault;
  if (hasSecret(slot)) return '••••••';
  const resolved = resolveWithoutVault();
  return resolved ? maskToken(resolved) : null;
}

/** F-724: o seletor "Provedor do DeepSeek" e a vaga de chave que ele usa. */
function deepseekProviderChoiceInfo(
  choice: DeepseekProviderChoice,
): ProviderChoiceInfo {
  const plan = choice === DEEPSEEK_TOKEN_PLAN_PROVIDER;
  const slot = deepseekKeyVaultSlot(choice);
  const resolveWithoutVault = () =>
    resolveDeepseekProviderKey(choice, { vault: 'skip' });
  const hasKey = hasSecret(slot) || resolveWithoutVault() !== null;
  return {
    value: choice,
    options: [
      {
        id: DEEPSEEK_DIRECT_PROVIDER,
        label: 'DeepSeek (API direta)',
        hint: 'Chave da DeepSeek (platform.deepseek.com), enviada só para api.deepseek.com.',
      },
      {
        id: DEEPSEEK_TOKEN_PLAN_PROVIDER,
        label: 'Alibaba Token Plan',
        hint:
          `Chave do Token Plan (a mesma do Qwen Code). O plano só serve o ` +
          `${DEEPSEEK_TOKEN_PLAN_MODEL}: o flash sobe nele.`,
      },
    ],
    key: {
      adapterId: slot,
      label: plan
        ? 'Chave do Token Plan (a mesma do Qwen Code)'
        : 'Chave da DeepSeek',
      envVar: 'ANTHROPIC_AUTH_TOKEN',
      hasKey,
      keyMasked: maskedRuntimeKey(slot, resolveWithoutVault),
      ...(plan && !hasKey && qwenSettingsHasCredential()
        ? {
            hint:
              'A chave do Qwen Code está só no ~/.qwen/settings.json, que o ' +
              'Nexus não copia para outro processo. Cole-a aqui: ela vai para o ' +
              'cofre, na mesma vaga do Qwen Code.',
          }
        : {}),
    },
  };
}

export function listProviderSettings(
  options: { nonBlockingAuth?: boolean } = {},
): ProviderSettingsInfo[] {
  return listAdapters()
    .map((a) => toInfo(a.id, options))
    .filter((info): info is ProviderSettingsInfo => info !== null);
}

function listProviderSettingsForRenderer(): ProviderSettingsInfo[] {
  return listProviderSettings({ nonBlockingAuth: true });
}

function broadcast(): void {
  const snapshot = listProviderSettingsForRenderer();
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(PROVIDER_CHANNELS.changed, snapshot);
  }
}

/** Publish observations refreshed through the dedicated auth-status endpoint. */
export function notifyProviderAuthChanged(): void {
  broadcast();
}

export function registerProviderListener(wc: WebContents): void {
  listeners.add(wc);
}

export function unregisterProviderListener(wc: WebContents): void {
  listeners.delete(wc);
}

/** Confirmação nativa (não-spoofável) antes de instalar uma CLI — mostra o
 * comando/URL exato; mesma doutrina SEC#4 do confirmExecConfig. */
async function confirmCliInstall(
  label: string,
  description: string,
  mode: 'install' | 'update' = 'install',
): Promise<boolean> {
  const action = mode === 'update' ? 'Atualizar' : 'Instalar';
  const opts = {
    type: 'question' as const,
    buttons: ['Cancelar', action],
    defaultId: 1,
    cancelId: 0,
    title: `${action} ${label}`,
    message: `${action} a CLI de ${label} nesta máquina?`,
    detail:
      `O NexusIDE vai usar esta receita oficial:\n\n  ${description}\n\n` +
      'O instalador pode baixar e executar dependências próprias.',
    noLink: true,
  };
  const win = BrowserWindow.getFocusedWindow();
  const result = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return result.response === 1;
}

/** The same priority as the pane: explicit executable, cached discovery, PATH. */
function activeProviderBinary(adapterId: string): string | null {
  const configured = configFor(adapterId).binPath;
  if (configured && path.isAbsolute(configured) && revalidateExecutable(configured)) {
    return configured;
  }
  const cached = getAdapterResolvedBin(adapterId);
  return cached && revalidateExecutable(cached)
    ? cached
    : resolveAdapterBinary(adapterId);
}

type AutomaticCliCandidate = {
  readonly adapterId: string;
  readonly label: string;
  readonly binPath: string;
  readonly realBinPath: string;
  readonly recipe: CliInstallRecipe;
  /** Null para o script oficial do fornecedor (F-749): não há argv a montar. */
  readonly prepared: ArgvInstallInvocation | null;
};

function resolveCliRealPath(filePath: string): string | null {
  try { return fs.realpathSync(filePath); }
  catch { return null; }
}

function automaticCliCandidate(adapterId: string): AutomaticCliCandidate | null {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty' || !isBuiltinAdapter(adapterId) ||
      configFor(adapterId).binPath) return null;
  const binPath = activeProviderBinary(adapterId);
  if (!binPath) return null;
  let realBinPath: string;
  try { realBinPath = fs.realpathSync(process.platform === 'win32'
    ? windowsNpmShimTarget(adapterId, binPath) ?? binPath : binPath); }
  catch { return null; }
  const recipe = selectAutomaticCliUpdateRecipe({
    adapterId, platform: process.platform, binPath, realBinPath,
    userHome: realUserHome(), windowsLocalAppData: process.env.LOCALAPPDATA,
    installationDistribution: adapterId === 'devin' ? installedDevinDistribution(realBinPath) : null,
    isRunnerResolvable: (runner) => resolveRunnerPath(runner) !== null,
    resolveRealPath: resolveCliRealPath,
    isTargetWritable: (target) => {
      try { fs.accessSync(path.dirname(target), fs.constants.W_OK); return true; }
      catch { return false; }
    },
  });
  if (!recipe) return null;
  if (recipe.kind !== 'argv') {
    return { adapterId, label: adapter.label, binPath, realBinPath, recipe, prepared: null };
  }
  try {
    return { adapterId, label: adapter.label, binPath, realBinPath, recipe,
      prepared: prepareArgvInstallInvocation(recipe) };
  } catch { return null; }
}

async function automaticCliCandidateAsync(adapterId: string): Promise<AutomaticCliCandidate | null> {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty' || !isBuiltinAdapter(adapterId) ||
      configFor(adapterId).binPath) return null;
  const binPath = activeProviderBinary(adapterId);
  if (!binPath) return null;
  let realBinPath: string;
  try { realBinPath = await fsp.realpath(process.platform === 'win32'
    ? windowsNpmShimTarget(adapterId, binPath) ?? binPath : binPath); }
  catch { return null; }
  const writable = new Map<string, boolean>();
  for (const target of [binPath, realBinPath]) {
    writable.set(target, await fsp.access(path.dirname(target), fs.constants.W_OK).then(() => true, () => false));
  }
  const recipe = selectAutomaticCliUpdateRecipe({
    adapterId, platform: process.platform, binPath, realBinPath,
    userHome: realUserHome(), windowsLocalAppData: process.env.LOCALAPPDATA,
    installationDistribution: adapterId === 'devin' ? installedDevinDistribution(realBinPath) : null,
    isRunnerResolvable: (runner) => resolveRunnerPath(runner) !== null,
    resolveRealPath: resolveCliRealPath,
    isTargetWritable: (target) => writable.get(target) === true,
  });
  if (!recipe) return null;
  if (recipe.kind !== 'argv') {
    return { adapterId, label: adapter.label, binPath, realBinPath, recipe, prepared: null };
  }
  try {
    return { adapterId, label: adapter.label, binPath, realBinPath, recipe,
      prepared: prepareArgvInstallInvocation(recipe) };
  } catch { return null; }
}

/** Linha do diálogo de consentimento: o comando exato ou o script oficial. */
function describeAutomaticCliCandidate(candidate: AutomaticCliCandidate): string {
  if (candidate.prepared) {
    return describeArgvInstallInvocation(candidate.prepared).replaceAll('\n', ' ');
  }
  return candidate.recipe.kind === 'argv'
    ? candidate.recipe.argv.join(' ')
    : `script oficial ${candidate.recipe.scriptUrl}`;
}

type AutoCliPreferences = {
  readonly enabled: boolean;
  readonly askAgainAt?: number;
  readonly checkedAt: Readonly<Record<string, number>>;
};

function readAutoCliPreferences(file: string): AutoCliPreferences | null {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const parsed = z.object({
      enabled: z.boolean(),
      askAgainAt: z.number().finite().nonnegative().optional(),
      checkedAt: z.record(z.string(), z.number().finite().nonnegative()).default({}),
    }).safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A dangling symlink is an existing choice whose content is unavailable.
      try { fs.lstatSync(file); }
      catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
          return { enabled: true, checkedAt: {} };
        }
      }
    }
    return null;
  }
}

let autoCliPreferencesRevision = 0;

function writeAutoCliPreferences(file: string, state: AutoCliPreferences): boolean {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file);
    autoCliPreferencesRevision++;
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* no-op */ }
    return false;
  }
}

async function readAutoCliPreferencesAsync(file: string): Promise<AutoCliPreferences | null> {
  const result = await readRegularFileCappedAsync(file, 256 * 1024);
  if (result.kind === 'none' && result.stamp === 'missing') return { enabled: true, checkedAt: {} };
  if (result.kind !== 'text') return null;
  try {
    const parsed = z.object({ enabled: z.boolean(), askAgainAt: z.number().finite().nonnegative().optional(),
      checkedAt: z.record(z.string(), z.number().finite().nonnegative()).default({}) }).safeParse(JSON.parse(result.text));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

async function writeAutoCliPreferencesAsync(file: string, state: AutoCliPreferences, current: () => boolean): Promise<boolean> {
  const revision = autoCliPreferencesRevision;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!current()) return false;
    await fsp.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    if (!current() || revision !== autoCliPreferencesRevision) return false;
    await fsp.rename(temporary, file);
    autoCliPreferencesRevision++;
    return true;
  } catch { return false; }
  finally { await fsp.rm(temporary, { force: true }).catch(() => undefined); }
}

function autoCliStatus(state: AutoCliPreferences | null): import('../../shared/provider-settings-types').CliAutoUpdateStatus {
  const checks = Object.values(state?.checkedAt ?? {});
  return {
    enabled: state?.enabled ?? false,
    deferredUntil: !state?.enabled && state?.askAgainAt !== Number.MAX_SAFE_INTEGER
      ? state?.askAgainAt ?? null : null,
    lastCheckedAt: checks.length ? Math.max(...checks) : null,
  };
}

async function confirmAutomaticCliConsent(candidates: readonly AutomaticCliCandidate[]): Promise<boolean> {
  const opts = {
    type: 'question' as const,
    buttons: ['Agora não', 'Ativar atualizações automáticas'],
    defaultId: 0, cancelId: 0,
    title: 'Atualização automática das CLIs',
    message: 'Manter as CLIs instaladas atualizadas?',
    detail: 'O Nexus verifica no máximo uma vez por dia cada CLI, quando ela não tem pane ativo. ' +
      'Se escolher Agora não, perguntaremos novamente em 7 dias. ' +
      'Estes são os comandos reconhecidos agora; instalações desconhecidas e canais que pedem privilégios ficam manuais:\n\n' +
      candidates.map((candidate) =>
        `• ${candidate.label}: ${describeAutomaticCliCandidate(candidate)}`,
      ).join('\n'),
    noLink: true,
  };
  const win = BrowserWindow.getFocusedWindow();
  const result = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return result.response === 1;
}

const CLI_AUTO_UPDATE_IDLE_SECONDS = 60;

/** Background maintenance yields to operator activity and this adapter's live panes. */
export function startCliAutoUpdate(
  userDataDir: string,
  hasLivePane: (adapterId: string) => boolean,
): () => Promise<void> {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) return async () => {};
  const file = path.join(userDataDir, 'cli-auto-update.json');
  const controller = new AbortController();
  const taskId = `cli-auto-update:${randomUUID()}`;
  let preferences = readAutoCliPreferences(file);
  const queue = new CliAutoUpdateQueue(preferences?.checkedAt);
  let prompting = false;
  let checking = false;
  let stopped = false;
  let lastDiscoveryAt = 0;
  let candidates: AutomaticCliCandidate[] = [];
  const tick = async (context: PeriodicTaskContext) => {
    preferences = await context.wait(readAutoCliPreferencesAsync(file)) ?? preferences;
    if (stopped || prompting || checking || cliUpdateLease.isProvisioning() ||
        (preferences?.enabled === false && !shouldOfferAutoCliConsent(preferences, Date.now()))) return;
    checking = true;
    try {
      // A boot-time update used to take the launcher's lease just as the
      // operator opened their first pane. Do maintenance while they are away.
      if (powerMonitor.getSystemIdleTime() < CLI_AUTO_UPDATE_IDLE_SECONDS) return;
      if (Date.now() - lastDiscoveryAt >= 30 * 60_000) {
        await context.wait(rescanAdapterBinaries());
        candidates = [];
        for (const adapter of listAdapters()) {
          await context.checkpoint();
          if (stopped) return;
          const candidate = await context.wait(automaticCliCandidateAsync(adapter.id));
          if (candidate) candidates.push(candidate);
        }
        lastDiscoveryAt = Date.now();
      }
      if (candidates.length === 0) return;
      if (shouldOfferAutoCliConsent(preferences, Date.now())) {
        if (candidates.every((candidate) => hasLivePane(candidate.adapterId))) return;
        if (!cliUpdateLease.beginAutoConsent()) return;
        prompting = true;
        try {
          const accepted = await context.wait(confirmAutomaticCliConsent(candidates));
          const next = {
            enabled: accepted,
            askAgainAt: accepted ? undefined : Date.now() + 7 * 24 * 60 * 60_000,
            checkedAt: preferences?.checkedAt ?? {},
          };
          if (stopped || !await context.wait(writeAutoCliPreferencesAsync(file, next, () => !stopped))) return;
          preferences = next;
        } finally { prompting = false; cliUpdateLease.endAutoConsent(); }
      }
      if (!preferences?.enabled || stopped) return;
      if ((await context.wait(readAutoCliPreferencesAsync(file)))?.enabled !== true) return;
      const now = Date.now();
      await queue.runOne(candidates.map((candidate) => candidate.adapterId), now,
        (id) => hasLivePane(id) || cliUpdateLease.isHeld(id), async (id) => {
        // Revalidate the effective launcher and permissions immediately before mutation.
        const selected = await context.wait(automaticCliCandidateAsync(id));
        const admittedPreference = await context.wait(readAutoCliPreferencesAsync(file));
        if (!selected || stopped || hasLivePane(id) ||
            powerMonitor.getSystemIdleTime() < CLI_AUTO_UPDATE_IDLE_SECONDS ||
            admittedPreference?.enabled !== true ||
            !cliUpdateLease.acquire(id)) return false;
        try {
          const beforeVersion = await context.wait(installedCliVersion(id, selected.binPath));
          let stillSameTarget = false;
          try {
            stillSameTarget = await fsp.realpath(process.platform === 'win32'
              ? windowsNpmShimTarget(id, selected.binPath) ?? selected.binPath
              : selected.binPath) === selected.realBinPath;
          } catch { /* The launcher disappeared while being checked. */ }
          const effectivePreference = await context.wait(readAutoCliPreferencesAsync(file));
          if (!beforeVersion || !stillSameTarget || stopped || hasLivePane(id) ||
              powerMonitor.getSystemIdleTime() < CLI_AUTO_UPDATE_IDLE_SECONDS ||
              effectivePreference?.enabled !== true ||
              activeProviderBinary(id) !== selected.binPath) return false;
          const preferenceRevision = autoCliPreferencesRevision;
          const assertInstallCurrent = () => {
            context.assertCurrent();
            if (stopped || autoCliPreferencesRevision !== preferenceRevision || hasLivePane(id) ||
              powerMonitor.getSystemIdleTime() < CLI_AUTO_UPDATE_IDLE_SECONDS || activeProviderBinary(id) !== selected.binPath) {
              throw new Error('CLI update authority changed before execution');
            }
          };
          try { await context.wait(runInstallRecipe(selected.recipe, selected.prepared ?? undefined, assertInstallCurrent)); }
          catch (error) {
            console.warn(`[cli-auto-update] ${id}: update failed`, error);
            return false;
          }
          // Refresh this launcher under the lease. The full PATH/login-shell
          // scan below must not keep a ready launcher behind unrelated CLIs.
          resolveAdapterBinary(id);
          const afterBin = activeProviderBinary(id);
          const afterVersion = afterBin ? await context.wait(installedCliVersion(id, afterBin)) : null;
          if (!afterBin || !afterVersion || stopped) return false;
          const result = assessCliUpdate({
            beforeBin: selected.binPath, beforeVersion, afterBin, afterVersion,
            platform: process.platform,
          });
          if (result === 'different-launcher') return false;
          console.info(`[cli-auto-update] ${id}: ${result === 'updated' ? 'updated' : 'checked'}, ${afterVersion}`);
        } finally { cliUpdateLease.release(id); }
        await context.wait(rescanAdapterBinaries());
        if (stopped) return false;
        broadcast();
        return true;
      });
      const current = await context.wait(readAutoCliPreferencesAsync(file));
      if (current?.enabled) {
        preferences = { ...current, checkedAt: queue.snapshot() };
        if (!await context.wait(writeAutoCliPreferencesAsync(file, preferences, () => !stopped))) {
          console.warn('[cli-auto-update] could not persist last check');
        }
      } else {
        preferences = current;
      }
    } catch (error) {
      if (!stopped) console.warn('[cli-auto-update] background check deferred', error);
    } finally { checking = false; }
  };
  const request = () => {
    void runPeriodicTask(taskId, tick, { signal: controller.signal, cadenceMs: 60_000 }).catch(() => undefined);
  };
  const initial = setTimeout(request, 60_000);
  const interval = setInterval(request, 60_000);
  return async () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
    controller.abort(new Error('CLI auto update stopped'));
    await stopPeriodicTask(taskId);
  };
}

function installedDevinDistribution(realBinPath: string): string | null {
  let marker: string;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    marker = path.join(process.env.LOCALAPPDATA, 'devin', 'cli', 'distribution');
  } else if (process.platform !== 'win32' &&
      realBinPath.replaceAll('\\', '/').includes('/devin/cli/_versions/')) {
    marker = path.join(path.dirname(path.dirname(realBinPath)), 'distribution');
  } else {
    return null;
  }
  try {
    return fs.readFileSync(marker, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Read the version from the executable itself, never another CLI on PATH. */
async function installedCliVersion(adapterId: string, binPath: string): Promise<string | null> {
  let executable = binPath;
  let args = ['--version'];
  if (process.platform === 'win32' && /\.cmd$/iu.test(binPath)) {
    // The .cmd shim is shell text. Run its verified package entrypoint through
    // its native binary or node.exe, without interpolating a path in cmd.exe.
    const invocation = windowsNpmShimInvocation(adapterId, binPath, resolveRunnerPath('node'));
    if (!invocation) return null;
    executable = invocation.executable;
    args = [...invocation.argsPrefix, '--version'];
  } else if (process.platform === 'win32' && !/\.(?:exe|com)$/i.test(binPath)) {
    return null;
  }
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true },
      (error, stdout) => {
        const version = String(stdout).trim().split(/\r?\n/u)[0]?.trim();
        resolve(error || !version ? null : version.slice(0, 100));
      },
    );
  });
}

/** Baixa o instalador oficial (HTTPS) para um arquivo temporário 0700 e o
 * executa com bash — nunca `curl | sh`: o conteúdo em disco é o que roda. */
async function runScriptInstall(
  scriptUrl: string,
  envOverrides?: Readonly<Record<string, string>>,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  const url = new URL(scriptUrl);
  if (url.protocol !== 'https:') {
    throw new Error('instalador oficial precisa ser HTTPS');
  }
  const response = await net.fetch(scriptUrl);
  if (!response.ok) {
    throw new Error(`download do instalador falhou: HTTP ${response.status}`);
  }
  const body = await response.text();
  if (!body.trim()) throw new Error('instalador oficial veio vazio');
  const file = path.join(
    os.tmpdir(),
    `nexus-cli-install-${Date.now()}-${process.pid}.sh`,
  );
  await fsp.writeFile(file, body, { mode: 0o700, flag: 'wx' });
  try {
    assertCurrent?.();
    await new Promise<void>((resolve, reject) => {
      execFile(
        resolveRunnerPath('bash') ?? 'bash',
        [file],
        envOverrides
          ? { ...installExecOptions(), env: { ...process.env, ...envOverrides } }
          : installExecOptions(),
        (error) => (error ? reject(error) : resolve()),
      );
    });
  } finally {
    await fsp.rm(file, { force: true });
  }
}

/** Baixa um instalador oficial PowerShell para disco antes de executar.
 * Nunca usamos `irm | iex` dentro do processo do Nexus: o comando só aparece
 * como instrução manual; a instalação automática roda o arquivo baixado com
 * `powershell.exe -File`, sem um shell intermediário escondido. */
async function runPowerShellScriptInstall(
  scriptUrl: string,
  replacesLocalAppDataExecutable?: string,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  const url = new URL(scriptUrl);
  if (url.protocol !== 'https:') {
    throw new Error('instalador oficial precisa ser HTTPS');
  }
  const response = await net.fetch(scriptUrl);
  if (!response.ok) {
    throw new Error(`download do instalador falhou: HTTP ${response.status}`);
  }
  const body = await response.text();
  if (!body.trim()) throw new Error('instalador oficial veio vazio');
  const file = path.join(
    os.tmpdir(),
    `nexus-cli-install-${Date.now()}-${process.pid}.ps1`,
  );
  await fsp.writeFile(file, body, { mode: 0o600, flag: 'wx' });
  // F-747: o executável em uso por um pane sai do caminho do `Copy-Item`.
  const localAppData = process.env.LOCALAPPDATA;
  const entry =
    replacesLocalAppDataExecutable && localAppData
      ? path.join(localAppData, ...replacesLocalAppDataExecutable.split('/'))
      : null;
  let aside: string | null = null;
  try {
    assertCurrent?.();
    if (entry) {
      removeStaleExecutableCopies(entry);
      aside = moveExecutableAside(entry, String(Date.now()));
    }
    assertCurrent?.();
    await new Promise<void>((resolve, reject) => {
      execFile(
        resolveRunnerPath('powershell') ?? 'powershell.exe',
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
        // powershell.exe é um binário real; não precisa do shell=true que os
        // shims `.cmd` de npm/brew exigem no Windows.
        { ...installExecOptions(), shell: false },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  } catch (error) {
    // Falhou sem deixar binário novo: o antigo volta, a CLI não some.
    if (entry) restoreExecutableIfMissing(entry, aside);
    throw error;
  } finally {
    await fsp.rm(file, { force: true });
  }
}

/** Executa uma receita selecionada mantendo a separação por plataforma. */
type ArgvInstallInvocation = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: ReturnType<typeof installExecOptions>;
  readonly envOverrides?: Readonly<Record<string, string>>;
};

function prepareArgvInstallInvocation(recipe: Extract<CliInstallRecipe, { kind: 'argv' }>): ArgvInstallInvocation {
  // A Windows npm shim needs cmd.exe, which would interpret an installation
  // prefix from the filesystem as shell text. Run npm's JS entrypoint with
  // node.exe directly when updating a known global prefix instead.
  let executable = resolveRunnerPath(recipe.runner);
  if (!executable) throw new Error(`runner ${recipe.runner} não está mais disponível`);
  let args = recipe.argv.slice(1);
  let options = installExecOptions();
  if (recipe.env) options = { ...options, env: { ...process.env, ...recipe.env } };
  if (process.platform === 'win32' && /\.(?:exe|com)$/iu.test(executable)) {
    // Native Windows executables accept argv directly. In particular, a
    // configured CLI path must never be interpolated through cmd.exe.
    options = { ...options, shell: false };
  }
  if (process.platform === 'win32' && recipe.runner === 'npm' && args.includes('--prefix')) {
    const npmJs = path.join(path.dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const node = resolveRunnerPath('node');
    if (!node || !fs.existsSync(npmJs)) {
      throw new Error('não consegui executar o npm da instalação atual sem o shell');
    }
    executable = node;
    args = [npmJs, ...args];
    options = { ...options, shell: false };
  } else if (process.platform === 'win32' && path.isAbsolute(recipe.runner) && /\.cmd$/iu.test(executable)) {
    const adapterId = path.basename(executable).replace(/\.cmd$/iu, '');
    const invocation = windowsNpmShimInvocation(adapterId, executable, resolveRunnerPath('node'));
    if (!invocation) {
      throw new Error('não consegui executar a CLI atual sem o shell');
    }
    executable = invocation.executable;
    args = [...invocation.argsPrefix, ...args];
    options = { ...options, shell: false };
  }
  return { executable, args, options, envOverrides: recipe.env };
}

function describeArgvInstallInvocation(invocation: ArgvInstallInvocation): string {
  const environment = invocation.envOverrides
    ? `\nAmbiente: ${Object.entries(invocation.envOverrides).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}`
    : '';
  return `Executável: ${invocation.executable}\nArgumentos: ${invocation.args.map((arg) => JSON.stringify(arg)).join(' ')}${environment}`;
}

async function runInstallRecipe(
  recipe: CliInstallRecipe,
  prepared?: ArgvInstallInvocation,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  if (recipe.kind === 'script') {
    await runScriptInstall(recipe.scriptUrl, recipe.env, assertCurrent);
    return;
  }
  if (recipe.kind === 'powershell-script') {
    await runPowerShellScriptInstall(recipe.scriptUrl, recipe.replacesLocalAppDataExecutable, assertCurrent);
    return;
  }
  const invocation = prepared ?? prepareArgvInstallInvocation(recipe);
  assertCurrent?.();
  await new Promise<void>((resolve, reject) => {
    execFile(
      invocation.executable,
      [...invocation.args],
      invocation.options,
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

/** Native, un-spoofable confirmation before trusting a renderer-supplied
 * binary/args as the thing the app will execute (SEC#4). */
async function confirmExecConfig(
  adapterId: string,
  change: SensitiveChange,
): Promise<boolean> {
  const label = getAdapter(adapterId)?.label ?? adapterId;
  const lines: string[] = [];
  if (change.binPath !== undefined) lines.push(`Binário: ${change.binPath}`);
  if (change.extraArgs !== undefined) {
    lines.push(`Argumentos extras: ${change.extraArgs.join(' ')}`);
  }
  if (change.permissionMode !== undefined) {
    lines.push(`Permissões: ${change.permissionMode} (FULL AUTO)`);
  }
  const opts = {
    type: 'warning' as const,
    buttons: ['Cancelar', 'Confiar e salvar'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirmar configuração de execução',
    message: `Confiar nesta configuração de alto impacto para ${label}?`,
    detail:
      `${lines.join('\n')}\n\n` +
      'O NexusIDE passará a EXECUTAR exatamente isto ao abrir este provider. ' +
      'FULL AUTO remove confirmações e pode reduzir ou desativar o sandbox. ' +
      'Confirme apenas se você entende e aceita esse alcance.',
    noLink: true,
  };
  const win = BrowserWindow.getFocusedWindow();
  const result = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return result.response === 1;
}

async function warnInvalidBin(
  adapterId: string,
  binPath: string,
  reason: string,
): Promise<void> {
  const opts = {
    type: 'error' as const,
    buttons: ['OK'],
    title: 'Caminho de binário inválido',
    message: `Caminho rejeitado para ${getAdapter(adapterId)?.label ?? adapterId}`,
    detail: `${binPath}\n\n${reason}`,
    noLink: true,
  };
  const win = BrowserWindow.getFocusedWindow();
  if (win) await dialog.showMessageBox(win, opts);
  else await dialog.showMessageBox(opts);
}

const PROVISION_OFFER_MARKER = 'provisioning-offer.json';

/**
 * Diretórios canônicos onde os runners de instalação vivem no macOS/Linux.
 * App GUI pode ter PATH incompleto (fold de login capturado no boot; brew
 * instalado depois; máquina onde o fold falhou) — o instalador não pode
 * declarar "sem Homebrew" com o brew instalado no lugar padrão (caso de
 * campo: opencode "não instalou nenhuma").
 */
const RUNNER_FALLBACK_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/bin',
  '/usr/bin',
  path.join(os.homedir(), '.local', 'bin'),
  // Windows GUI launches frequently omit the user npm directory from PATH.
  // Keep these locations as discovery fallbacks; the resolved path is still
  // validated as a regular file before any install command runs.
  ...(process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
        path.join(
          process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          'nodejs',
        ),
        path.join(
          process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
          'Programs',
          'nodejs',
        ),
        path.join(
          process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
          'npm',
        ),
        path.join(
          process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
          'Microsoft',
          'WinGet',
          'Links',
        ),
      ]
    : []),
];

/** Caminho executável do runner: PATH primeiro, diretórios canônicos depois. */
export function resolveRunnerPath(runner: string): string | null {
  // Returning the bare name here made the Windows packaged app call
  // `execFile('npm', ...)`. Node cannot launch npm's .cmd shim with
  // shell:false, so every install failed with `spawn npm ENOENT` even though
  // discovery had already proved that npm existed. Always return the absolute
  // file selected by the same resolver used for CLI discovery.
  const resolved = resolveCliBinary(runner);
  if (resolved) return resolved.binPath;
  for (const dir of RUNNER_FALLBACK_DIRS) {
    const candidate = resolveCliBinary(runner, {
      processPath: dir,
      effectivePath: dir,
    });
    if (candidate) return candidate.binPath;
  }
  return null;
}

/**
 * npm/brew are command shims on Windows (`.cmd`). Node 22 intentionally does
 * not execute those files through `execFile` with `shell:false` (ENOENT/EINVAL).
 * The recipes are immutable, code-owned argv, so enabling the native command
 * interpreter only on Windows preserves the no-shell path on POSIX while
 * making the verified installer usable in the packaged app.
 */
function installExecOptions(): {
  timeout: number;
  maxBuffer: number;
  windowsHide?: boolean;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
} {
  return {
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    ...(process.platform === 'win32'
      ? { shell: true, windowsHide: true }
      : {}),
  };
}

/**
 * Piloto automático de máquina nova (oferta única por instalação): no
 * primeiro boot com CLIs auto-instaláveis ausentes, UM diálogo nativo lista
 * os comandos EXATOS e oferece instalar tudo em sequência. Mesma doutrina
 * SEC#4 do fluxo por-CLI — comandos/URLs visíveis, argv sem shell, receitas
 * em código. Quem recusar continua com o botão no hub de Providers.
 */
export async function maybeOfferFirstRunProvisioning(
  userDataDir: string,
): Promise<void> {
  const markerPath = path.join(userDataDir, PROVISION_OFFER_MARKER);
  try {
    if (fs.existsSync(markerPath)) return;
  } catch {
    return;
  }
  if (!cliUpdateLease.beginProvisioning()) return;
  try {
  const missing = listProviderSettings().filter(
    (provider) => !provider.installed && provider.canAutoInstall,
  );
  const writeMarker = (accepted: boolean): void => {
    try {
      fs.writeFileSync(
        markerPath,
        JSON.stringify({ offeredAt: Date.now(), missing: missing.length, accepted }),
        { mode: 0o600 },
      );
    } catch {
      // Marker é conveniência; falha não pode quebrar o boot.
    }
  };
  if (missing.length === 0) {
    writeMarker(false);
    return;
  }
  const selections = missing.map((provider) => ({
    provider,
    selection: selectInstallRecipe(
      cliInstallRecipeCandidates(provider.adapterId),
      (runner) => resolveRunnerPath(runner) !== null,
    ),
  }));
  const lines = selections.map(({ provider, selection }) => {
    if (!selection) return `• ${provider.label}: —`;
    return selection.ok
      ? `• ${provider.label}: ${describeInstallRecipe(selection.recipe)}`
      : `• ${provider.label}: sem runner (${selection.missingRunnerHints.join(' OU ')})`;
  });
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const offer = {
    type: 'info' as const,
    buttons: ['Agora não', 'Instalar todas agora'],
    defaultId: 1,
    cancelId: 0,
    title: 'Provisionar máquina nova',
    message: `${missing.length} CLIs de IA ausentes nesta máquina`,
    detail:
      'O NexusIDE pode instalá-las agora pelas fontes oficiais:\n\n' +
      `${lines.join('\n')}\n\n` +
      'Cada instalação executa exatamente o comando mostrado (sem shell). ' +
      'Logins/assinaturas seguem sendo feitos em cada CLI depois.',
    noLink: true,
  };
  const choice = win
    ? await dialog.showMessageBox(win, offer)
    : await dialog.showMessageBox(offer);
  writeMarker(choice.response === 1);
  if (choice.response !== 1) return;

  const done: string[] = [];
  const pending: string[] = [];
  for (const { provider, selection } of selections) {
    if (!selection) continue;
    if (!selection.ok) {
      pending.push(
        `${provider.label} — ${selection.missingRunnerHints.join(' OU ')}`,
      );
      continue;
    }
    const recipe = selection.recipe;
    if (!cliUpdateLease.acquire(provider.adapterId, 'provisioning')) {
      pending.push(`${provider.label} — instalação ocupada; tente pelo botão da CLI`);
      continue;
    }
    try {
      await runInstallRecipe(recipe);
      done.push(provider.label);
    } catch (err) {
      pending.push(
        `${provider.label} — ${err instanceof Error ? err.message.slice(0, 120) : 'falhou'}`,
      );
    } finally { cliUpdateLease.release(provider.adapterId); }
  }
  broadcast();
  const summary = {
    type: 'info' as const,
    buttons: ['OK'],
    title: 'Provisionamento concluído',
    message:
      done.length > 0
        ? `Instaladas: ${done.join(', ')}`
        : 'Nenhuma CLI instalada desta vez',
    detail:
      (pending.length > 0 ? `Pendentes:\n${pending.join('\n')}\n\n` : '') +
      'Próximo passo: faça login em cada CLI quando for usá-la (1x por máquina).',
    noLink: true,
  };
  if (win && !win.isDestroyed()) await dialog.showMessageBox(win, summary);
  else await dialog.showMessageBox(summary);
  } finally { cliUpdateLease.endProvisioning(); }
}

export function registerProviderIpc(): void {
  initializeProviderConfigStore();

  handleTrusted(PROVIDER_CHANNELS.autoCliUpdates, async (_event, raw) => {
    const parsed = z.discriminatedUnion('action', [
      z.object({ action: z.literal('get') }),
      z.object({ action: z.literal('set'), enabled: z.boolean() }),
    ]).safeParse(raw);
    const file = path.join(app.getPath('userData'), 'cli-auto-update.json');
    const previous = readAutoCliPreferences(file);
    if (!parsed.success) return { ...autoCliStatus(previous), error: 'pedido inválido' };
    if (parsed.data.action === 'get') return autoCliStatus(previous);
    if (!parsed.data.enabled) {
      const next = { enabled: false, askAgainAt: Number.MAX_SAFE_INTEGER,
        checkedAt: previous?.checkedAt ?? {} };
      return writeAutoCliPreferences(file, next)
        ? autoCliStatus(next)
        : { ...autoCliStatus(previous), error: 'não consegui salvar a preferência' };
    }
    if (!cliUpdateLease.beginAutoConsent()) {
      return { ...autoCliStatus(previous), error: 'outra instalação ou confirmação está em andamento' };
    }
    try {
      await rescanAdapterBinaries();
      const candidates = listAdapters()
        .map((adapter) => automaticCliCandidate(adapter.id))
        .filter((candidate): candidate is AutomaticCliCandidate => candidate !== null);
      if (candidates.length === 0) {
        return { ...autoCliStatus(previous), error: 'nenhuma CLI elegível para atualização automática nesta máquina' };
      }
      const accepted = await confirmAutomaticCliConsent(candidates);
      if (!accepted) return autoCliStatus(previous);
      const next = { enabled: true, checkedAt: previous?.checkedAt ?? {} };
      return writeAutoCliPreferences(file, next)
        ? autoCliStatus(next)
        : { ...autoCliStatus(previous), error: 'não consegui salvar a preferência' };
    } catch {
      return { ...autoCliStatus(previous), error: 'não consegui verificar as CLIs instaladas' };
    } finally { cliUpdateLease.endAutoConsent(); }
  });

  handleTrusted(PROVIDER_CHANNELS.installCli, async (_e, raw) => {
    const parsed = z
      .object({
        adapterId: z.string().min(1).max(64),
        /** F-520: 'update' troca install por upgrade onde o install é no-op (brew). */
        mode: z.enum(['install', 'update']).default('install'),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'adapter inválido' };
    const adapter = getAdapter(parsed.data.adapterId);
    if (!adapter) return { ok: false, error: 'adapter desconhecido' };
    if (!cliUpdateLease.acquire(adapter.id)) {
      return { ok: false, error: 'Já existe uma instalação ou atualização desta CLI em andamento.' };
    }
    try {
    const updating = parsed.data.mode === 'update';
    if (!updating && adapter.id === 'claude') {
      // The UI can be stale, or only the native symlink may be broken.
      // Reuse a verified existing CLI instead of installing over it.
      await rescanAdapterBinaries();
      const existing = activeProviderBinary(adapter.id);
      const version = existing ? await installedCliVersion(adapter.id, existing) : null;
      if (version) {
        broadcast();
        return { ok: true, changed: false, version };
      }
    }
    const beforeBin = updating ? activeProviderBinary(adapter.id) : null;
    if (updating && !beforeBin) {
      return { ok: false, error: 'CLI não encontrada; reexamine as CLIs antes de atualizar.' };
    }
    let realBinPath: string | null = null;
    if (beforeBin) {
      try {
        realBinPath = fs.realpathSync(
          process.platform === 'win32'
            ? windowsNpmShimTarget(adapter.id, beforeBin) ?? beforeBin
            : beforeBin,
        );
      } catch {
        return { ok: false, error: 'O executável mudou; reexamine as CLIs antes de atualizar.' };
      }
    }
    const selection = updating && beforeBin && realBinPath
      ? selectCliUpdateRecipe({
          adapterId: adapter.id,
          platform: process.platform,
          binPath: beforeBin,
          realBinPath,
          userHome: realUserHome(),
          windowsLocalAppData: process.env.LOCALAPPDATA,
          installationDistribution: adapter.id === 'devin'
            ? installedDevinDistribution(realBinPath)
            : null,
          isRunnerResolvable: (runner) => resolveRunnerPath(runner) !== null,
          resolveRealPath: resolveCliRealPath,
        })
      : selectInstallRecipe(
          cliInstallRecipeCandidates(adapter.id),
          (runner) => resolveRunnerPath(runner) !== null,
        );
    if (!selection) {
      return {
        ok: false,
        error: updating
          ? 'Não reconheci o canal da CLI usada pelo pane; atualize essa instalação pelo canal original.'
          : 'Sem instalador automático para esta CLI nesta plataforma ainda — use o site oficial do provider.',
      };
    }
    if (!selection.ok) {
      return { ok: false, error: selection.missingRunnerHints.join(' OU: ') };
    }
    const recipe = selection.recipe;
    let prepared: ArgvInstallInvocation | undefined;
    try {
      if (recipe.kind === 'argv') prepared = prepareArgvInstallInvocation(recipe);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'instalador indisponível' };
    }
    const confirmed = await confirmCliInstall(
      adapter.label,
      prepared ? describeArgvInstallInvocation(prepared) : describeInstallRecipe(recipe),
      parsed.data.mode,
    );
    if (!confirmed) return { ok: false, error: updating ? 'atualização cancelada' : 'instalação cancelada' };
    const beforeVersion = beforeBin ? await installedCliVersion(adapter.id, beforeBin) : null;
    try {
      // brew pode compilar; 15 min é teto honesto para 1ª instalação.
      await runInstallRecipe(recipe, prepared);
    } catch (err) {
      const operation = updating ? 'atualização' : 'instalação';
      return {
        ok: false,
        error:
          err instanceof Error
            ? `${operation} falhou: ${err.message.slice(0, 300)}`
            : `${operation} falhou`,
      };
    }
    // Re-fold PATH + re-probe absolute bins so the new CLI is spawnable now.
    await rescanAdapterBinaries();
    broadcast();
    const afterBin = activeProviderBinary(adapter.id);
    const afterVersion = afterBin ? await installedCliVersion(adapter.id, afterBin) : null;
    if (!afterBin || !afterVersion) {
      return {
        ok: false,
        error: 'O instalador terminou, mas o Nexus não conseguiu verificar a versão da CLI usada pelo pane.',
      };
    }
    if (!updating) return { ok: true, version: afterVersion };
    if (!beforeBin) return { ok: false, error: 'CLI anterior não verificada.' };
    const observation = assessCliUpdate({
      beforeBin,
      beforeVersion,
      afterBin,
      afterVersion,
      platform: process.platform,
    });
    if (observation === 'different-launcher') {
      return {
        ok: false,
        error: 'O instalador terminou, mas o Nexus passou a usar outro executável no PATH; reexamine as CLIs antes de afirmar a atualização.',
      };
    }
    return {
      ok: true,
      changed: observation === 'verified' ? undefined : observation === 'updated',
      version: afterVersion,
    };
    } finally { cliUpdateLease.release(adapter.id); }
  });

  ipcMain.handle(PROVIDER_CHANNELS.list, () => {
    // F-1004: o smoke do gate de release não lê o Keychain do operador nem
    // executa CLIs; a lista sai só dos metadados/cache.
    if (isCurrentProcessSmokeTest()) return listProviderSettingsForRenderer();
    // Descoberta viva em background: quando terminar, o broadcast de
    // providers empurra a lista atualizada (o "Atualizar modelos" chama list,
    // e o changed subsequente entrega os modelos novos sem segundo clique).
    refreshAllDiscoveredModels(
      listAdapters().map((a) => a.id),
      () => broadcast(),
    );
    // Keychain-only provider logins are warmed asynchronously. The immediate
    // snapshot stays metadata/cache-only and cannot freeze this IPC request
    // behind `security` for up to five seconds.
    void Promise.allSettled([
      refreshClaudeSubscriptionAuthCache(),
      refreshOpenClaudeSubscriptionAuthCache(),
      refreshAgySubscriptionAuthCache(),
    ]).then((results) => {
      if (results.some((result) => result.status === 'rejected' || result.value.cacheUpdated)) broadcast();
    });
    return listProviderSettingsForRenderer();
  });

  handleTrusted(PROVIDER_CHANNELS.setConfig, async (_event, raw) => {
    const parsed = providerConfigPatchSchema.safeParse(raw);
    if (!parsed.success) return listProviderSettingsForRenderer();
    const { adapterId, ...patch } = parsed.data;
    const current = configFor(adapterId);
    if (patch.upstream !== undefined) {
      // F-724: o DeepSeek só escolhe entre a API direta e o Token Plan; a rota
      // do Token Plan é dele e de mais ninguém (outra CLI mandaria a própria
      // chave para a Alibaba).
      const upstream = patch.upstream.trim();
      const allowed =
        adapterId === DEEPSEEK_DIRECT_PROVIDER
          ? isDeepseekProviderChoice(upstream)
          : upstreamAllowedForAdapter(adapterId, upstream);
      if (allowed) patch.upstream = upstream;
      else delete patch.upstream;
    }

    // SEC#4: binPath/extraArgs become the executed binary + argv at spawn. A
    // NEW value must pass validation AND an explicit native confirmation the
    // renderer cannot forge, before it is ever persisted/trusted.
    const sensitive = sensitiveChanges(patch, current);
    if (sensitive.binPath !== undefined) {
      const check = validateBinPath(sensitive.binPath);
      if (!check.ok) {
        await warnInvalidBin(adapterId, sensitive.binPath, check.error ?? '');
        delete patch.binPath;
        delete sensitive.binPath;
      }
    }
    if (hasSensitiveChange(sensitive)) {
      const approved = await confirmExecConfig(adapterId, sensitive);
      if (!approved) {
        // Declined → keep the previously-trusted values, apply the rest.
        delete patch.binPath;
        delete patch.extraArgs;
        delete patch.permissionMode;
      }
    }

    const merged: ProviderConfig = { ...current, adapterId };
    if (patch.enabled !== undefined) merged.enabled = patch.enabled;
    if (patch.binPath !== undefined) merged.binPath = patch.binPath;
    if (patch.defaultModel !== undefined) merged.defaultModel = patch.defaultModel;
    if (patch.extraArgs !== undefined) merged.extraArgs = patch.extraArgs;
    if (patch.upstream !== undefined) merged.upstream = patch.upstream;
    if (patch.permissionMode !== undefined) merged.permissionMode = patch.permissionMode;
    if (patch.effort !== undefined) merged.effort = patch.effort;
    if (patch.verbose !== undefined) merged.verbose = patch.verbose;
    configs.set(adapterId, merged);
    if (adapterId === 'qwen') invalidateQwenReadiness();
    persist();
    broadcast();
    return listProviderSettingsForRenderer();
  });

  handleTrusted(PROVIDER_CHANNELS.setKey, (_event, raw) => {
    const parsed = setKeySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid key request' };
    if (!getAdapter(parsed.data.adapterId)) return { ok: false, error: 'unknown provider' };
    const result = setKey(parsed.data.adapterId, parsed.data.key);
    if (parsed.data.adapterId === 'qwen' && result.ok) invalidateQwenReadiness();
    broadcast();
    return result;
  });

  // ── Multi-PC: o safeStorage é amarrado ao keychain da máquina. Export/import
  //    com passphrase é a única forma das keys viajarem sem plaintext em disco.
  handleTrusted(PROVIDER_CHANNELS.vaultState, () => vaultState());

  handleTrusted(PROVIDER_CHANNELS.exportSecrets, async (_event, raw) => {
    const parsed = exportSecretsSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'invalid export request' };
    }
    const result = exportSecretsVault(parsed.data.passphrase);
    if (!result.ok) return result;
    const win = BrowserWindow.getFocusedWindow();
    const saveOptions = {
      title: 'Exportar keys (multi-PC)',
      defaultPath: `nexus-keys-${new Date().toISOString().slice(0, 10)}.nexusvault`,
      filters: [{ name: 'Nexus Keys', extensions: ['nexusvault'] }],
    };
    const save = win
      ? await dialog.showSaveDialog(win, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (save.canceled || !save.filePath) {
      return { ok: false, error: 'Export cancelado.' };
    }
    try {
      fs.writeFileSync(save.filePath, result.bundle, { encoding: 'utf8', mode: 0o600 });
    } catch {
      return { ok: false, error: 'Não foi possível gravar o arquivo de export.' };
    }
    // O bundle já vai cifrado; o texto não volta para o renderer.
    return {
      ok: true,
      exportedKeys: result.exportedKeys,
      skippedKeys: result.skippedKeys,
      path: save.filePath,
    };
  });

  handleTrusted(PROVIDER_CHANNELS.importSecrets, async (_event, raw) => {
    const parsed = importSecretsSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'invalid import request' };
    }
    const result = importSecretsVault(parsed.data.bundle, parsed.data.passphrase);
    if (result.ok) {
      broadcast();
      notifyAdaptersChanged();
    }
    return result;
  });

  handleTrusted(PROVIDER_CHANNELS.addModel, (_event, raw) => {
    const parsed = addModelSchema.safeParse(raw);
    if (parsed.success) {
      addCustomModel(parsed.data.adapterId, parsed.data.model);
      broadcast();
      notifyAdaptersChanged(); // refresh roster + Modo Livre picker
    }
    return listProviderSettingsForRenderer();
  });

  handleTrusted(PROVIDER_CHANNELS.removeModel, (_event, raw) => {
    const parsed = addModelSchema.safeParse(raw);
    if (parsed.success) {
      removeCustomModel(parsed.data.adapterId, parsed.data.model);
      broadcast();
      notifyAdaptersChanged();
    }
    return listProviderSettingsForRenderer();
  });

  handleTrusted(
    PROVIDER_CHANNELS.testKey,
    async (_event, raw): Promise<TestConnectionResult> => {
      const parsed = setKeySchema
        .pick({ adapterId: true })
        .safeParse(raw);
      if (!parsed.success) return { ok: false, detail: 'invalid request' };
      const adapter = getAdapter(parsed.data.adapterId);
      if (!adapter) return { ok: false, detail: 'unknown provider' };
      const key = resolveApiKey(parsed.data.adapterId);
      return testProviderKey(adapter, key);
    },
  );
}
