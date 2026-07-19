import fs from 'node:fs';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, net } from 'electron';
import type { WebContents } from 'electron';
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
  isBinResolvable,
  listAdapters,
  notifyAdaptersChanged,
  primaryKeyEnvVar,
} from '../adapters/adapter-registry';
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
  selectInstallRecipe,
  describeInstallRecipe,
} from '../adapters/cli-install-recipes';
import { execFile } from 'node:child_process';
import {
  getKey,
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
  resolveAuthStrategy,
} from '../adapters/subscription-auth';
import {
  KIMI_TRANSIENT_MODEL_ENV_KEYS,
  buildKimiApiKeyRuntimeEnv,
} from '../adapters/kimi-runtime-env';
import {
  activeClaudeAuthEnv,
  accountKey,
  ensureSubscriptionActive,
  fileSubscriptionAuthEnv,
  getActiveAccount,
  listAccounts,
  prepareAccountForSpawn,
} from './account-store';

/**
 * Provider configuration hub: per-adapter enable/disable, binary-path
 * override, default model and extra args (non-secret; ~/.nexus/providers.json)
 * combined with the keychain-backed secret to produce the settings UI view and
 * the spawn overrides the PTY layer applies.
 */

const CONFIG_FILE = path.join(os.homedir(), '.nexus', 'providers.json');

let configs = new Map<string, ProviderConfig>();
const listeners = new Set<WebContents>();

function defaultPermissionModeFor(adapterId: string): string {
  const adapter = getAdapter(adapterId);
  return adapter?.kind === 'cli-pty' ? defaultPermissionMode(adapter) : '';
}

function defaultConfigFor(adapterId: string): ProviderConfig {
  return {
    adapterId,
    enabled: true,
    binPath: '',
    defaultModel: '',
    extraArgs: [],
    upstream: 'anthropic',
    permissionMode: defaultPermissionModeFor(adapterId),
    effort: '',
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
  }
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

function authDecision(adapterId: string) {
  const adapter = getAdapter(adapterId);
  const authMethod =
    adapter?.kind === 'cli-pty' ? adapter.auth.method : 'api_key';
  return resolveAuthStrategy({
    authMethod,
    hasStoredKey: hasRuntimeKey(adapterId),
    subscriptionAuthed: hasSubscriptionAuth(adapterId),
  });
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

  const fromLauncher = loadLauncherProviderKey(adapterId);
  if (fromLauncher) return fromLauncher;

  const route = upstream ?? configFor(adapterId).upstream;
  if (route && route !== 'anthropic' && route !== adapterId) {
    const viaUpstream = loadLauncherProviderKey(route);
    if (viaUpstream) return viaUpstream;
  }

  for (const name of keyEnvVarsOf(adapterId)) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** Exported for the pre-spawn credential probe (pty/pre-spawn-probe.ts). */
export function hasRuntimeKey(adapterId: string): boolean {
  // Provider readiness is queried during boot. Do not decrypt the vault here:
  // on macOS that crosses into SecItemCopyMatching and can block Electron's
  // main thread while the Keychain session is locked or stale. Presence in
  // the encrypted index is enough for readiness; the actual key is resolved
  // only when a provider is spawned.
  if (hasSecret(adapterId)) return true;
  return resolveApiKeyWithoutVault(adapterId) !== null;
}

function resolveApiKeyWithoutVault(adapterId: string): string | null {
  const fromLauncher = loadLauncherProviderKey(adapterId);
  if (fromLauncher) return fromLauncher;

  const route = configFor(adapterId).upstream;
  if (route && route !== 'anthropic' && route !== adapterId) {
    const viaUpstream = loadLauncherProviderKey(route);
    if (viaUpstream) return viaUpstream;
  }

  for (const name of keyEnvVarsOf(adapterId)) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
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

export function providerReadiness(adapterId: string): ProviderReadiness {
  const infrastructure = providerInfrastructureReadiness(adapterId);
  if (!infrastructure.ready) return infrastructure;

  const adapter = getAdapter(adapterId);
  if (!adapter) return infrastructure;

  const decision = authDecision(adapterId);
  if (decision.strategy === 'login-needed') {
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

export function isProviderReady(adapterId: string): boolean {
  return providerReadiness(adapterId).ready;
}

type PreparedAccount = Extract<
  ReturnType<typeof prepareAccountForSpawn>,
  { ok: true }
>;

function buildProviderSpawnOverrides(
  adapterId: string,
  perSpawn: { effort?: string; accountId?: string; model?: string },
  preparedAccount: PreparedAccount | null,
): ProviderSpawnOverrides {
  const cfg = configFor(adapterId);
  const adapter = getAdapter(adapterId);
  const key = resolveApiKey(adapterId, cfg.upstream);
  // Control flags (permission mode / effort / verbose) always apply, whatever
  // the auth/routing path — they're how the user turns on auto-operation.
  const base = {
    // Defense in depth (SEC#4): only an ABSOLUTE path is ever used as the
    // executable. A bare/relative binPath (e.g. from a hand-edited config) is
    // dropped so it can never resolve to an arbitrary binary off PATH; the
    // setConfig confirmation is the primary control.
    binPath: cfg.binPath && path.isAbsolute(cfg.binPath) ? cfg.binPath : null,
    defaultModel: cfg.defaultModel || null,
    extraArgs: [...controlArgsFor(adapterId, perSpawn.effort), ...cfg.extraArgs],
  };

  // A per-pane account is exact. Claude is deliberately excluded from the
  // legacy implicit-active-account path: restoring an old OAuth snapshot can
  // overwrite the CLI's current native session and trigger an endless login
  // loop. Its vault is used only when the user explicitly pins that account.
  const account =
    preparedAccount?.account ??
    (!perSpawn.accountId && adapterId !== 'claude' && listAccounts(adapterId).length > 0
      ? getActiveAccount(adapterId)
      : null);
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
      // Unpinned active path: Claude via token env; file providers via managed home.
      // Fail closed for file-auth: empty keyEnv would silently use the system login.
      if (adapterId === 'claude') {
        return {
          ...base,
          keyEnv: activeClaudeAuthEnv() ?? {},
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
    return {
      ...base,
      keyEnv: buildProviderRoutingEnv(cfg.upstream, key),
      suppressEnv: [],
    };
  }

  // Subscription-first (user directive): an authenticated subscription CLI
  // never receives an API key — and inherited key vars are stripped so they
  // cannot hijack billing. The key only flows when there is no subscription.
  const decision = authDecision(adapterId);
  const keyEnv =
    decision.injectKey && adapter && key
      ? nativeKeyEnv(adapterId, key, perSpawn.model)
      : decision.strategy === 'subscription' && adapterId === 'claude'
        ? (activeClaudeAuthEnv() ?? {})
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

/** Resolve all spawn-time auth synchronously, before node-pty is touched. */
export function prepareProviderSpawn(
  adapterId: string,
  perSpawn: { effort?: string; accountId?: string; model?: string } = {},
): ProviderSpawnPreparation {
  const readiness = perSpawn.accountId
    ? providerInfrastructureReadiness(adapterId)
    : providerReadiness(adapterId);
  if (!readiness.ready) return { ok: false, error: readiness.reason };

  let preparedAccount: PreparedAccount | null = null;
  if (perSpawn.accountId) {
    const prepared = prepareAccountForSpawn(adapterId, perSpawn.accountId);
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
      ),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'provider account is not activatable',
    };
  }
}

/** Backward-compatible strict accessor for non-IPC callers. */
export function providerSpawnOverrides(
  adapterId: string,
  perSpawn: { effort?: string; accountId?: string; model?: string } = {},
): ProviderSpawnOverrides {
  const prepared = prepareProviderSpawn(adapterId, perSpawn);
  if (!prepared.ok) throw new Error(prepared.error);
  return prepared.overrides;
}

function toInfo(adapterId: string): ProviderSettingsInfo | null {
  const adapter = getAdapter(adapterId);
  if (!adapter) return null;
  const cfg = configFor(adapterId);
  const detectedBin = adapter.kind === 'cli-pty' ? adapter.bin : adapter.endpoint;
  const effectiveBin = cfg.binPath || detectedBin;
  const installed =
    adapter.kind === 'cli-pty' ? isBinResolvable(effectiveBin) : true;
  const custom = getCustomModels(adapterId).filter(
    (m) => !adapter.models.list.includes(m),
  );
  // Modelos vivos reportados pela própria CLI (ex.: kimi provider list) —
  // modelo novo lançado aparece sem esperar release do Nexus.
  const staticIds = [...adapter.models.list, ...custom];
  const discovered = discoveredModelsFor(adapterId).filter(
    (m) => !staticIds.includes(m),
  );
  const models = [...staticIds, ...discovered];
  return {
    adapterId,
    label: adapter.label,
    icon: adapter.icon,
    kind: adapter.kind,
    enabled: cfg.enabled,
    installed,
    canAutoInstall: cliInstallRecipeFor(adapterId) !== null,
    binPath: cfg.binPath,
    detectedBin,
    defaultModel: cfg.defaultModel || adapter.models.default,
    models,
    modelInfo: modelInfoForAdapter(loadModelCatalog(), adapterId, models),
    customModels: getCustomModels(adapterId),
    extraArgs: cfg.extraArgs,
    keyEnvVar: primaryKeyEnvVar(adapter),
    hasKey: hasRuntimeKey(adapterId),
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
    secureStorageAvailable: isSecureStorageAvailable({ probe: false }),
    authStrategy: authDecision(adapterId).strategy,
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
  };
}

export function listProviderSettings(): ProviderSettingsInfo[] {
  return listAdapters()
    .map((a) => toInfo(a.id))
    .filter((info): info is ProviderSettingsInfo => info !== null);
}

function broadcast(): void {
  const snapshot = listProviderSettings();
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(PROVIDER_CHANNELS.changed, snapshot);
  }
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
        { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
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
 * campo: omp/opencode "não instalou nenhuma").
 */
const RUNNER_FALLBACK_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/bin',
  '/usr/bin',
  path.join(os.homedir(), '.local', 'bin'),
];

/** Caminho executável do runner: PATH primeiro, diretórios canônicos depois. */
export function resolveRunnerPath(runner: string): string | null {
  if (isBinResolvable(runner)) return runner;
  for (const dir of RUNNER_FALLBACK_DIRS) {
    const candidate = path.join(dir, runner);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // segue para o próximo diretório
    }
  }
  return null;
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
      if (recipe.kind === 'script') {
        await runScriptInstall(recipe.scriptUrl);
      } else {
        await new Promise<void>((resolve, reject) => {
          execFile(
            resolveRunnerPath(recipe.runner) ?? recipe.argv[0],
            recipe.argv.slice(1),
            { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
            (error) => (error ? reject(error) : resolve()),
          );
        });
      }
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
  load();

  ipcMain.handle(PROVIDER_CHANNELS.installCli, async (_e, raw) => {
    const parsed = z
      .object({ adapterId: z.string().min(1).max(64) })
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
    const recipe = selection.recipe;
    const confirmed = await confirmCliInstall(
      adapter.label,
      describeInstallRecipe(recipe),
    );
    if (!confirmed) return { ok: false, error: 'instalação cancelada' };
    try {
      if (recipe.kind === 'script') {
        await runScriptInstall(recipe.scriptUrl);
      } else {
        await new Promise<void>((resolve, reject) => {
          execFile(
            resolveRunnerPath(recipe.runner) ?? recipe.argv[0],
            recipe.argv.slice(1),
            // brew pode compilar; 15 min é teto honesto para 1ª instalação.
            { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
            (error) => (error ? reject(error) : resolve()),
          );
        });
      }
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? `instalação falhou: ${err.message.slice(0, 300)}`
            : 'instalação falhou',
      };
    }
    // A CLI recém-instalada aparece como installed no próximo snapshot.
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
    return listProviderSettings();
  });

  ipcMain.handle(PROVIDER_CHANNELS.setConfig, async (_event, raw) => {
    const parsed = providerConfigPatchSchema.safeParse(raw);
    if (!parsed.success) return listProviderSettings();
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
    return listProviderSettings();
  });

  ipcMain.handle(PROVIDER_CHANNELS.setKey, (_event, raw) => {
    const parsed = setKeySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid key request' };
    const result = setKey(parsed.data.adapterId, parsed.data.key);
    broadcast();
    return result;
  });

  ipcMain.handle(PROVIDER_CHANNELS.addModel, (_event, raw) => {
    const parsed = addModelSchema.safeParse(raw);
    if (parsed.success) {
      addCustomModel(parsed.data.adapterId, parsed.data.model);
      broadcast();
      notifyAdaptersChanged(); // refresh roster + Modo Livre picker
    }
    return listProviderSettings();
  });

  ipcMain.handle(PROVIDER_CHANNELS.removeModel, (_event, raw) => {
    const parsed = addModelSchema.safeParse(raw);
    if (parsed.success) {
      removeCustomModel(parsed.data.adapterId, parsed.data.model);
      broadcast();
      notifyAdaptersChanged();
    }
    return listProviderSettings();
  });

  ipcMain.handle(
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
