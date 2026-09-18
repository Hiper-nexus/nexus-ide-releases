import fs from 'node:fs';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, net } from 'electron';
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
  providerConfigPatchSchema,
  setKeySchema,
  type ProviderConfig,
  type ProviderSettingsInfo,
  type TestConnectionResult,
} from '../../shared/provider-settings-types';
import {
  getAdapter,
  getAdapterResolvedBin,
  isBinResolvable,
  listAdapters,
  notifyAdaptersChanged,
  primaryKeyEnvVar,
  rescanAdapterBinaries,
  resolveAdapterBinary,
} from '../adapters/adapter-registry';
import { resolveCliLoginCommand } from '../../shared/cli-login';
import { revalidateExecutable, resolveCliBinary } from '../path-resolver';
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
import {
  discoveredModelsFor,
  refreshAllDiscoveredModels,
} from '../adapters/model-discovery';
import {
  cliInstallRecipeCandidates,
  cliInstallRecipeFor,
  cliInstallCommandFor,
  compatibleManualInstallCommand,
  selectInstallRecipe,
  describeInstallRecipe,
  type CliInstallRecipe,
} from '../adapters/cli-install-recipes';
import { execFile } from 'node:child_process';
import {
  getKey,
  getSecret,
  hasCachedSecret,
  hasSecret,
  isSecureStorageAvailable,
  maskedKey,
  setKey,
} from './secrets-store';
import { testProviderKey } from '../adapters/provider-test';
import {
  buildProviderRoutingEnv,
  listUpstreamProviders,
  loadLauncherProviderKey,
} from '../adapters/launcher-provider-manager';
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
  ensureSubscriptionActive,
  fileSubscriptionAuthEnv,
  getActiveAccount,
  getAccount,
  isAccountBlockedForScope,
  listAccounts,
  pickAvailableForFailover,
  prepareAccountForSpawn,
} from './account-store';
import type { Account } from '../../shared/account-types';
import {
  maskAccountLabel,
  type AccountChoiceAlternative,
  type AccountChoiceReceipt,
  type AccountHeadroom,
} from '../../shared/account-choice';
import type {
  ProviderQuotaEntry,
  QuotaWindow,
} from '../../shared/quota-types';
import { quotaAvailabilityScore } from '../quota/quota-policy';
import { requireQuotaService } from '../quota/quota-service';
import type { ApiQuotaKeyRequest } from '../quota/provider-live-usage';

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

function defaultPermissionModeFor(adapterId: string): string {
  const adapter = getAdapter(adapterId);
  return adapter?.kind === 'cli-pty' ? defaultPermissionMode(adapter) : '';
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
          : 'anthropic';
  return {
    adapterId,
    enabled: true,
    binPath: '',
    defaultModel: '',
    extraArgs: [],
    upstream: defaultUpstream,
    permissionMode: defaultPermissionModeFor(adapterId),
    effort: adapterId === 'agy' ? 'max' : '',
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
        effort: cfg.effort ?? defaults.effort,
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
  return resolveAuthStrategy({
    authMethod,
    hasStoredKey: hasRuntimeKey(adapterId),
    // AGY's native Keychain is always probed asynchronously before governed
    // spawn. Synchronous settings/spawn paths consume only that warm cache so
    // a locked login Keychain can never freeze Electron's main event loop.
    subscriptionAuthed:
      options.statusSnapshot || adapterId === 'agy'
        ? hasSubscriptionAuthForStatus(adapterId)
        : hasSubscriptionAuth(adapterId),
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
  return (
    selectedModel?.trim() ||
    configFor(adapterId).defaultModel.trim() ||
    adapter?.models.default
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
  const fromVault = getKey(adapterId);
  if (fromVault) return fromVault;
  return resolveApiKeyWithoutVault(adapterId, upstream);
}

/** Main-process request-time access; never expose the raw key through IPC. */
export function resolveRuntimeApiKey(adapterId: string): string | null {
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
  // A cold owner credential could shadow every later source at spawn. Do not
  // decrypt it here or substitute a different account while it is unavailable.
  if (hasSecret(adapterId) && !hasCachedSecret(adapterId)) return null;
  const cached = hasCachedSecret(adapterId) ? getKey(adapterId) : null;
  if (cached) return cached;
  return resolveApiKeyWithoutVault(adapterId, upstream, (name) => quotaEnvMatchesProvider(name, usageProviderId));
}

function quotaEnvMatchesProvider(name: string, providerId: string): boolean {
  if (['ZAI_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY'].includes(name)) return ['glm', 'glm-flash', 'zai', 'zhipu'].includes(providerId);
  if (name === 'LONGCAT_API_KEY') return providerId === 'longcat';
  if (['KIMI_MODEL_API_KEY', 'KIMI_API_KEY', 'KIMI_CODING_API_KEY', 'MOONSHOT_API_KEY'].includes(name)) return providerId === 'kimi';
  if (name === 'XAI_API_KEY') return providerId === 'grok';
  if (!['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(name)) return false;
  const host = providerId === 'glm' || providerId === 'glm-flash' ? 'api.z.ai' : providerId === 'longcat' ? 'api.longcat.chat' : null;
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
  if (hasSecret(adapterId)) return true;
  return resolveApiKeyWithoutVault(adapterId) !== null;
}

function resolveApiKeyWithoutVault(
  adapterId: string,
  upstream = configFor(adapterId).upstream,
  allowEnv?: (name: string) => boolean,
): string | null {
  const fromLauncher = loadLauncherProviderKey(adapterId);
  if (fromLauncher) return fromLauncher;

  const route = upstream;
  if (route && route !== 'anthropic' && route !== adapterId) {
    const viaUpstream = loadLauncherProviderKey(route);
    if (viaUpstream) return viaUpstream;
  }

  for (const name of keyEnvVarsOf(adapterId)) {
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
      reason: `${adapter.label} está desativado em Configurações › Providers.`,
    };
  }

  if (adapter.kind === 'cli-pty') {
    const effectiveBin = cfg.binPath || adapter.bin;
    if (!isBinResolvable(effectiveBin)) {
      return {
        ready: false,
        reason: `${adapter.label} não encontrado. Instale: ${adapter.install.command}`,
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
  const { account, receipt } = resolveSpawnAccountChoice(
    adapterId,
    preparedAccount,
    options,
    credentiallessOpenCode,
  );
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
      cfg.defaultModel.trim() && adapter
        ? effectiveDefaultModel(
            adapterId,
            cfg.defaultModel,
            [
              ...adapter.models.list,
              ...getCustomModels(adapterId),
              ...discoveredModelsFor(adapterId),
            ],
            adapter.models.default,
          )
        : null,
    extraArgs: [...controlArgsFor(adapterId, perSpawn.effort), ...cfg.extraArgs],
    accountChoice: receipt,
  };

  if (options.nativeAuthAttempt) {
    // Let the CLI access its own store without copying credentials or swapping
    // to an implicit account. This is an attempt, not proof of authentication.
    return { ...base, keyEnv: {}, suppressEnv: [] };
  }

  // A per-pane account is exact. Claude is deliberately excluded from the
  // legacy implicit-active-account path: restoring an old OAuth snapshot can
  // overwrite the CLI's current native session and trigger an endless login
  // loop. Its vault is used only when the user explicitly pins that account.
  // `account`/`receipt` já vieram de resolveSpawnAccountChoice acima.
  if (account) {
    if (account.mode === 'subscription') {
      // Pane-pinned: process-scoped env (Claude OAuth token or CODEX_HOME/…).
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
      // Unpinned active path: Claude via linhagem nativa (token env só no HOME
      // efêmero); file providers via managed home.
      // Fail closed for file-auth: empty keyEnv would silently use the system login.
      if (adapterId === 'claude') {
        return {
          ...base,
          keyEnv: nativeClaudeSubscriptionEnv(perSpawn.isolatedHome === true),
          suppressEnv: subscriptionSuppressEnvVars(adapterId),
        };
      }
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
      (account.upstream && account.upstream !== 'anthropic'
        ? loadLauncherProviderKey(account.upstream)
        : null) ??
      loadLauncherProviderKey(adapterId);
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
  if (cfg.upstream && cfg.upstream !== 'anthropic' && isRoutable(adapterId)) {
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
  const readiness = perSpawn.accountId || nativeAuthAttempt
    ? infrastructure
    : resolveProviderReadiness(adapterId, perSpawn.model, {
        decision: spawnDecision,
      });
  if (!readiness.ready) return { ok: false, error: readiness.reason };

  let preparedAccount: PreparedAccount | null = null;
  if (perSpawn.accountId) {
    const prepared = prepareAccountForSpawn(
      adapterId,
      perSpawn.accountId,
      undefined,
      { isolatedHome: perSpawn.isolatedHome === true },
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
        { decision: spawnDecision, nativeAuthAttempt },
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

/** Pior janela medida da conta: a de maior usedRatio conhecido. */
function headroomFromEntry(entry: ProviderQuotaEntry): AccountHeadroom {
  let worst: QuotaWindow | null = null;
  for (const w of entry.windows) {
    if (w.usedRatio === null) continue;
    if (!worst || (worst.usedRatio ?? -1) < w.usedRatio) worst = w;
  }
  return {
    usedPct:
      worst && worst.usedRatio !== null
        ? Math.round(worst.usedRatio * 100)
        : null,
    window: worst?.label ?? null,
    resetsAt: worst?.resetsAt ?? null,
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

/** As outras contas do adapter e o motivo categórico de cada derrota. */
function accountChoiceAlternatives(
  adapterId: string,
  chosenId: string | null,
  scores: ReadonlyMap<string, number> | undefined,
  now: number,
): AccountChoiceAlternative[] {
  return listAccounts(adapterId)
    .filter((a) => a.id !== chosenId)
    .map((a) => {
      const entry = quotaEntryFor(adapterId, a.id);
      const head = entry ? headroomFromEntry(entry) : null;
      const skipped = isAccountBlockedForScope(a.id, now)
        ? ('cooldown' as const)
        : !accountHasFailoverCredential(a)
          ? ('no-credential' as const)
          : !scores?.has(a.id)
            ? ('unknown-quota' as const)
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
        alternatives: accountChoiceAlternatives(
          adapterId,
          account.id,
          quotaScoresFor(adapterId),
          decidedAt,
        ),
        decidedAt,
      },
    };
  }
  const nativeLineage =
    adapterId === 'claude' ||
    (adapterId === 'agy' && options.decision?.strategy === 'subscription') ||
    credentiallessOpenCode;
  if (!nativeLineage && listAccounts(adapterId).length > 0) {
    return pickUnpinnedAccountWithHeadroom(adapterId);
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
 * Pane sem conta pinada nasce na conta com folga (paridade Overclock 1.3.18).
 * Sem snapshot de quota a ativa legada permanece; com snapshot, a irmã mais
 * livre com credencial e fora de bloco vence. Nenhuma conta livre (quota fora
 * do ar, tudo em cooldown) NÃO bloqueia o spawn: abre na ativa e avisa.
 */
function pickUnpinnedAccountWithHeadroom(
  adapterId: string,
): { account: Account | null; receipt: AccountChoiceReceipt } {
  const decidedAt = Date.now();
  const active = getActiveAccount(adapterId);
  const quotaScores = quotaScoresFor(adapterId);
  const picked = pickAvailableForFailover(
    adapterId,
    null,
    decidedAt,
    quotaScores,
  ).account;
  const alternatives = accountChoiceAlternatives(
    adapterId,
    picked?.id ?? null,
    quotaScores,
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
  const saved = savedDefault.trim();
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
  return prepareProviderSpawnWithDecision(
    adapterId,
    perSpawn,
    spawnDecision,
  );
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
  const custom = getCustomModels(adapterId).filter(
    (m) => !adapter.models.list.includes(m),
  );
  // adapter.models.list já passou por applyDiscoveredModelsToAdapter e
  // applyModelCatalogToAdapter no registry refresh. Mas cache discovered é
  // volátil: um refresh asyncrono pode esvaziar-se se a CLI não responder.
  // Adicionamos discovered do cache vivo novamente para garantir união durável.
  const staticIds = [...adapter.models.list, ...custom];
  const discovered = discoveredModelsFor(adapterId).filter(
    (m) => !staticIds.includes(m),
  );
  const models = [...staticIds, ...discovered];
  const authReadyModels = models.filter((model) => {
    const strategy = authDecision(adapterId, model, {
      statusSnapshot: options.nonBlockingAuth === true,
    }).strategy;
    return isProviderAuthReadyForModel(
      { adapterId, authStrategy: strategy },
      model,
    );
  });
  const defaultModel = effectiveDefaultModel(
    adapterId,
    cfg.defaultModel,
    models,
    adapter.models.default,
  );
  const strategy = authDecision(adapterId, defaultModel, {
    statusSnapshot: options.nonBlockingAuth === true,
  }).strategy;
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
    defaultModel,
    models,
    authReadyModels,
    modelInfo: modelInfoForAdapter(loadModelCatalog(), adapterId, models),
    customModels: getCustomModels(adapterId),
    extraArgs: cfg.extraArgs,
    keyEnvVar: primaryKeyEnvVar(adapter),
    hasKey: hasRuntimeKey(adapterId, defaultModel),
    // Prefer vault mask; if only the launcher has the key, mask that instead
    // so Settings doesn't look "empty" while readiness is already true.
    keyMasked: (() => {
      // A cached value is safe to mask. For a cold boot, only inspect the
      // encrypted index and return a generic mask; never decrypt Keychain data
      // while constructing the provider snapshot.
      const vault = hasCachedSecret(adapterId) ? maskedKey(adapterId) : null;
      if (vault) return vault;
      if (hasSecret(adapterId)) return '••••••';
      const resolved = resolveApiKeyWithoutVault(adapterId);
      return resolved ? maskToken(resolved) : null;
    })(),
    authMethod: adapter.kind === 'cli-pty' ? adapter.auth.method : 'api_key',
    loginHint:
      adapter.kind === 'cli-pty' ? adapter.auth.loginHint : undefined,
    loginCommand:
      adapter.kind === 'cli-pty'
        ? (resolveCliLoginCommand({
            loginCommand: adapter.auth.loginCommand,
            authMethod: adapter.auth.method,
            interactive: adapter.spawn.interactive,
          }) ?? undefined)
        : undefined,
    secureStorageAvailable: isSecureStorageAvailable({ probe: false }),
    authStrategy: strategy,
    authState: strategy !== 'login-needed' ? 'ok' :
      subscriptionAuthStatusIsUnknown(adapterId) ? 'unknown' : 'missing',
    upstream: cfg.upstream || 'anthropic',
    routable: isRoutable(adapterId),
    upstreams: listUpstreamProviders().map((p) => ({
      id: p.id,
      label: p.label,
      requiresToken: p.requiresToken,
    })),
    permissionMode: cfg.permissionMode,
    permissionModes:
      adapter.kind === 'cli-pty' ? availablePermissionModes(adapter) : [],
    effort: cfg.effort,
    efforts: adapter.kind === 'cli-pty' ? availableEfforts(adapter) : [],
    verbose: cfg.verbose,
    supportsVerbose: adapter.kind === 'cli-pty' ? supportsVerbose(adapter) : false,
    // L4: true when the key comes from the plaintext launcher providers.conf
    // (not the encrypted vault). The UI should warn about cleartext storage.
    plaintextKeyFallback: !hasCachedSecret(adapterId) && !hasSecret(adapterId)
      ? resolveApiKeyWithoutVault(adapterId) !== null
      : false,
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
): Promise<boolean> {
  const opts = {
    type: 'question' as const,
    buttons: ['Cancelar', 'Instalar'],
    defaultId: 1,
    cancelId: 0,
    title: `Instalar ${label}`,
    message: `Instalar a CLI de ${label} nesta máquina?`,
    detail:
      `O NexusIDE vai executar exatamente:\n\n  ${description}\n\n` +
      'Fonte oficial do provider. Nada além disto será executado.',
    noLink: true,
  };
  const win = BrowserWindow.getFocusedWindow();
  const result = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return result.response === 1;
}

/** Baixa o instalador oficial (HTTPS) para um arquivo temporário 0700 e o
 * executa com bash — nunca `curl | sh`: o conteúdo em disco é o que roda. */
async function runScriptInstall(scriptUrl: string): Promise<void> {
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
  fs.writeFileSync(file, body, { mode: 0o700 });
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        resolveRunnerPath('bash') ?? 'bash',
        [file],
        installExecOptions(),
        (error) => (error ? reject(error) : resolve()),
      );
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Baixa um instalador oficial PowerShell para disco antes de executar.
 * Nunca usamos `irm | iex` dentro do processo do Nexus: o comando só aparece
 * como instrução manual; a instalação automática roda o arquivo baixado com
 * `powershell.exe -File`, sem um shell intermediário escondido. */
async function runPowerShellScriptInstall(scriptUrl: string): Promise<void> {
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
  fs.writeFileSync(file, body, { mode: 0o600 });
  try {
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
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Executa uma receita selecionada mantendo a separação por plataforma. */
async function runInstallRecipe(recipe: CliInstallRecipe): Promise<void> {
  if (recipe.kind === 'script') {
    await runScriptInstall(recipe.scriptUrl);
    return;
  }
  if (recipe.kind === 'powershell-script') {
    await runPowerShellScriptInstall(recipe.scriptUrl);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      resolveRunnerPath(recipe.runner) ?? recipe.argv[0],
      recipe.argv.slice(1),
      installExecOptions(),
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
    try {
      await runInstallRecipe(recipe);
      done.push(provider.label);
    } catch (err) {
      pending.push(
        `${provider.label} — ${err instanceof Error ? err.message.slice(0, 120) : 'falhou'}`,
      );
    }
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
}

export function registerProviderIpc(): void {
  initializeProviderConfigStore();

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
    const selection = selectInstallRecipe(
      cliInstallRecipeCandidates(adapter.id),
      (runner) => resolveRunnerPath(runner) !== null,
    );
    if (!selection) {
      return {
        ok: false,
        error:
          'Sem instalador automático para esta CLI nesta plataforma ainda — ' +
          'use o site oficial do provider.',
      };
    }
    if (!selection.ok) {
      return { ok: false, error: selection.missingRunnerHints.join(' OU: ') };
    }
    const recipe =
      parsed.data.mode === 'update' &&
      selection.recipe.kind === 'argv' &&
      selection.recipe.updateArgv
        ? { ...selection.recipe, argv: selection.recipe.updateArgv }
        : selection.recipe;
    const confirmed = await confirmCliInstall(
      adapter.label,
      describeInstallRecipe(recipe),
    );
    if (!confirmed) return { ok: false, error: 'instalação cancelada' };
    try {
      // brew pode compilar; 15 min é teto honesto para 1ª instalação.
      await runInstallRecipe(recipe);
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? `instalação falhou: ${err.message.slice(0, 300)}`
            : 'instalação falhou',
      };
    }
    // Re-fold PATH + re-probe absolute bins so the new CLI is spawnable now.
    await rescanAdapterBinaries();
    broadcast();
    return { ok: true };
  });

  ipcMain.handle(PROVIDER_CHANNELS.list, () => {
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
    persist();
    broadcast();
    return listProviderSettingsForRenderer();
  });

  handleTrusted(PROVIDER_CHANNELS.setKey, (_event, raw) => {
    const parsed = setKeySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid key request' };
    const result = setKey(parsed.data.adapterId, parsed.data.key);
    broadcast();
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
