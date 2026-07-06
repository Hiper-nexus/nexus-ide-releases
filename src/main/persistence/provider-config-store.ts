import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  hasSensitiveChange,
  sensitiveChanges,
  validateBinPath,
  type SensitiveChange,
} from './provider-bin-trust';
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
  getKey,
  hasKey,
  isSecureStorageAvailable,
  maskedKey,
  setKey,
} from './secrets-store';
import { testProviderKey } from '../adapters/provider-test';
import {
  buildProviderRoutingEnv,
  listUpstreamProviders,
} from '../adapters/launcher-provider-manager';
import {
  hasSubscriptionAuth,
  resolveAuthStrategy,
} from '../adapters/subscription-auth';
import {
  accountKey,
  ensureSubscriptionActive,
  getActiveAccount,
  listAccounts,
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
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Record<
      string,
      Partial<ProviderConfig>
    >;
    for (const [adapterId, cfg] of Object.entries(raw)) {
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
  } catch {
    // No config yet — every adapter defaults to enabled.
  }
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const out: Record<string, ProviderConfig> = {};
    for (const [id, cfg] of configs) out[id] = cfg;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2));
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

function authDecision(adapterId: string) {
  const adapter = getAdapter(adapterId);
  const authMethod =
    adapter?.kind === 'cli-pty' ? adapter.auth.method : 'api_key';
  return resolveAuthStrategy({
    authMethod,
    hasStoredKey: hasKey(adapterId),
    subscriptionAuthed: hasSubscriptionAuth(adapterId),
  });
}

export function providerSpawnOverrides(
  adapterId: string,
  perSpawn: { effort?: string } = {},
): ProviderSpawnOverrides {
  const cfg = configFor(adapterId);
  const adapter = getAdapter(adapterId);
  const key = getKey(adapterId);
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

  // Multi-account: when accounts exist for this adapter, the ACTIVE account
  // decides auth + routing (this is how a GLM account — adapter=claude,
  // upstream=glm, z.ai key — runs through the Claude CLI).
  if (listAccounts(adapterId).length > 0) {
    const account = getActiveAccount(adapterId);
    if (account) {
      if (account.mode === 'subscription') {
        // Restore its Claude keychain credential; inject NO key and strip
        // inherited key vars (subscription-first).
        ensureSubscriptionActive(account);
        return {
          ...base,
          keyEnv: {},
          suppressEnv: keyEnvVarsOf(adapterId),
        };
      }
      // api-key account: route to its upstream (GLM/Fugu/…) or inject native.
      const accKey = accountKey(account);
      if (account.upstream && account.upstream !== 'anthropic') {
        return { ...base, keyEnv: buildProviderRoutingEnv(account.upstream, accKey), suppressEnv: [] };
      }
      const keyEnv: Record<string, string> = {};
      if (adapter && accKey) {
        const envVar = primaryKeyEnvVar(adapter);
        if (envVar) keyEnv[envVar] = accKey;
      }
      return { ...base, keyEnv, suppressEnv: [] };
    }
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
  const keyEnv: Record<string, string> = {};
  if (decision.injectKey && adapter && key) {
    const envVar = primaryKeyEnvVar(adapter);
    if (envVar) keyEnv[envVar] = key;
  }
  return {
    ...base,
    keyEnv,
    suppressEnv: decision.suppressKeyEnv ? keyEnvVarsOf(adapterId) : [],
  };
}

function toInfo(adapterId: string): ProviderSettingsInfo | null {
  const adapter = getAdapter(adapterId);
  if (!adapter) return null;
  const cfg = configFor(adapterId);
  const detectedBin = adapter.kind === 'cli-pty' ? adapter.bin : adapter.endpoint;
  const effectiveBin = cfg.binPath || detectedBin;
  const installed =
    adapter.kind === 'cli-pty' ? isBinResolvable(effectiveBin) : true;
  return {
    adapterId,
    label: adapter.label,
    icon: adapter.icon,
    kind: adapter.kind,
    enabled: cfg.enabled,
    installed,
    binPath: cfg.binPath,
    detectedBin,
    defaultModel: cfg.defaultModel || adapter.models.default,
    models: [
      ...adapter.models.list,
      ...getCustomModels(adapterId).filter(
        (m) => !adapter.models.list.includes(m),
      ),
    ],
    customModels: getCustomModels(adapterId),
    extraArgs: cfg.extraArgs,
    keyEnvVar: primaryKeyEnvVar(adapter),
    hasKey: hasKey(adapterId),
    keyMasked: maskedKey(adapterId),
    authMethod: adapter.kind === 'cli-pty' ? adapter.auth.method : 'api_key',
    loginHint:
      adapter.kind === 'cli-pty' ? adapter.auth.loginHint : undefined,
    secureStorageAvailable: isSecureStorageAvailable(),
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
  const opts = {
    type: 'warning' as const,
    buttons: ['Cancelar', 'Confiar e salvar'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirmar execução de binário',
    message: `Confiar nesta configuração de execução para ${label}?`,
    detail:
      `${lines.join('\n')}\n\n` +
      'O NexusIDE passará a EXECUTAR exatamente isto ao abrir este provider. ' +
      'Confirme apenas se você reconhece este caminho/estes argumentos.',
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

export function registerProviderIpc(): void {
  load();

  ipcMain.handle(PROVIDER_CHANNELS.list, () => listProviderSettings());

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
      const key = getKey(parsed.data.adapterId);
      return testProviderKey(adapter, key);
    },
  );
}
