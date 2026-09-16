import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { WebContents } from 'electron';
import {
  adapterSchema,
  hasNexusMcpCapability,
} from '../../shared/adapter-types';
import { canonicalCliAdapterId } from '../../shared/cli-adapter-id';
import type {
  Adapter,
  AdapterCapabilityMatrix,
  AdapterInfo,
  OrchestrationEvidence,
} from '../../shared/adapter-types';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { ADAPTER_CHANNELS } from '../../shared/channels';
import {
  resolveCliBinary,
  revalidateExecutable,
  refreshUserPath,
  getEffectivePath,
  type CliBinaryResolution,
} from '../path-resolver';
import { getCustomModels } from './custom-models';
import {
  applyDiscoveredEffortsToAdapter,
  applyDiscoveredModelsToAdapter,
  cliModelCacheDirectories,
  discoverCliEfforts,
  discoverCliModels,
} from './cli-model-discovery';
import {
  discoveredModelsFor,
  MODEL_DISCOVERY_POLL_MS,
  refreshAllDiscoveredModels,
} from './model-discovery';
import {
  USER_MODEL_CATALOG_FILE,
  applyModelCatalogToAdapter,
  invalidateModelCatalogCache,
  loadModelCatalog,
  modelInfoForAdapter,
  refreshRemoteModelCatalog,
  seedLocalModelCatalogFromPublished,
} from './model-catalog';
import { invalidateAdapterHotCache } from './adapter-hot-cache';
import {
  supportsEnforceableReadOnlyNativeAuthority,
  supportsEnforceableWorkspaceWriteNativeAuthority,
} from '../pty/autonomous-cli-policy';
import {
  cliInstallCommandFor,
  compatibleManualInstallCommand,
} from './cli-install-recipes';

const USER_ADAPTER_DIR = path.join(os.homedir(), '.nexus', 'plugins', 'adapters');
const NEXUS_DIR = path.join(os.homedir(), '.nexus');
type AdapterOrigin = 'builtin' | 'user';

/** CLI removida do produto; modelos gemini-* continuam pertencendo ao AGY. */
const RETIRED_ADAPTER_IDS = new Set(['gemini', 'gemini-cli']);

function isRetiredAdapter(adapter: Adapter): boolean {
  const id = adapter.id.trim().toLowerCase();
  const bin = adapter.kind === 'cli-pty'
    ? path.posix
        .basename(adapter.bin.replaceAll('\\', '/'))
        .toLowerCase()
        .replace(/\.(?:exe|cmd|bat)$/u, '')
    : '';
  return (
    RETIRED_ADAPTER_IDS.has(id) ||
    bin === 'gemini'
  );
}

/**
 * These builtins completed Nexus' real governed coordinator gate. Keep this
 * allowlist deliberately small: declaring MCP metadata never promotes a CLI.
 */
const VERIFIED_ORCHESTRATOR_BUILTINS = new Set(['claude', 'codex']);

export function orchestrationEvidenceForAdapter(
  adapter: Adapter,
  origin: AdapterOrigin,
): OrchestrationEvidence {
  if (
    adapter.kind !== 'cli-pty' ||
    !hasNexusMcpCapability(adapter.quirks) ||
    // The production Maestro is always confined independently from Nexus MCP.
    // A declared route without provider-native read-only enforcement cannot
    // ever pass that boundary, so presenting it as an experimental Maestro is
    // a dead-end rather than an honest capability.
    !supportsEnforceableReadOnlyNativeAuthority(adapter)
  ) {
    return 'unsupported';
  }
  if (
    origin === 'builtin' &&
    VERIFIED_ORCHESTRATOR_BUILTINS.has(adapter.id)
  ) {
    return 'verified';
  }
  return 'experimental';
}

function hasPromptTemplate(adapter: Adapter): boolean {
  if (adapter.kind !== 'cli-pty') return false;
  if (adapter.promptInjection.method === 'stdin') return true;
  return adapter.spawn.headless.some((arg) => arg.includes('{{PROMPT}}'));
}

/**
 * Project adapter mechanics and Nexus-owned release qualifications separately.
 *
 * User adapters may describe launch/prompt/status/resume mechanics because
 * those fields only select host integration code. They can never self-award
 * unattended read/write or Maestro authority.
 */
export function adapterCapabilityMatrixForAdapter(
  adapter: Adapter,
  origin: AdapterOrigin,
): AdapterCapabilityMatrix {
  const launchable = adapter.kind === 'cli-pty';
  const promptInjectable = launchable && hasPromptTemplate(adapter);
  const statusObservable =
    adapter.kind === 'cli-pty' &&
    (adapter.stateParsing.idle.type === 'regex' ||
      adapter.stateParsing.idle.type === 'timeout');
  const resumable =
    adapter.kind === 'cli-pty' &&
    (adapter.spawn.resumeArgs.length > 0 ||
      (adapter.spawn.resumeIdArgs?.length ?? 0) > 0);
  const nexusMcpCapable =
    adapter.kind === 'cli-pty' &&
    hasNexusMcpCapability(adapter.quirks);
  const releaseOwnedBase =
    origin === 'builtin' &&
    adapter.kind === 'cli-pty' &&
    promptInjectable &&
    statusObservable &&
    nexusMcpCapable;
  const autonomousReadOnly =
    releaseOwnedBase &&
    supportsEnforceableReadOnlyNativeAuthority(adapter);
  const governedWriter =
    releaseOwnedBase &&
    supportsEnforceableWorkspaceWriteNativeAuthority(adapter);
  const verifiedMaestro =
    releaseOwnedBase &&
    orchestrationEvidenceForAdapter(adapter, origin) === 'verified';
  return Object.freeze({
    launchable,
    promptInjectable,
    statusObservable,
    resumable,
    autonomousReadOnly,
    governedWriter,
    verifiedMaestro,
  });
}

/**
 * PTY-stream handoff is a Main-owned protocol, so it does not depend on a
 * provider plugin being bundled by Nexus. Any launchable CLI whose prompt can
 * be injected and whose terminal lifecycle is observable can return the
 * session-bound completion marker. Hardened write authority remains a
 * separate, release-owned capability.
 */
export function taskHandoffCapabilityForAdapter(
  adapter: Adapter,
  origin: AdapterOrigin,
): boolean {
  const capabilities = adapterCapabilityMatrixForAdapter(adapter, origin);
  return (
    capabilities.launchable &&
    capabilities.promptInjectable &&
    capabilities.statusObservable
  );
}

/**
 * Maestro startup requires the physical Nexus MCP route checked by
 * canUseNexusMcp in cli-mcp-inject. PTY completion alone remains sufficient for
 * workers, but cannot carry the coordinator's Nexus tool calls.
 */
export function missionControlCapabilityForAdapter(
  adapter: Adapter,
  origin: AdapterOrigin,
): boolean {
  if (adapter.kind !== 'cli-pty' || adapter.quirks.nexusMcp === 'agy') {
    return false;
  }
  const hasPhysicalMcpRoute =
    hasNexusMcpCapability(adapter.quirks) || adapter.bin === 'claude';
  const capabilities = adapterCapabilityMatrixForAdapter(adapter, origin);
  return (
    hasPhysicalMcpRoute &&
    capabilities.launchable &&
    capabilities.promptInjectable &&
    capabilities.statusObservable
  );
}

/** Validate and load a single raw JSON object as an adapter. */
function parseAdapter(raw: unknown, source: string): Adapter | null {
  const result = adapterSchema.safeParse(raw);
  if (!result.success) {
    console.error(
      `[adapter-registry] Invalid adapter from ${source}:`,
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
    return null;
  }
  return result.data;
}

/** Validate and collect all builtin adapters (imported as JSON at compile time). */
function loadBuiltins(): Adapter[] {
  return BUILTIN_ADAPTERS.flatMap((raw, i) => {
    const adapter = parseAdapter(raw, `builtin[${i}]`);
    return adapter ? [adapter] : [];
  });
}

/** Scan the user plugin directory and load all valid adapter JSON files. */
function loadUserAdapters(): Adapter[] {
  if (!fs.existsSync(USER_ADAPTER_DIR)) return [];
  try {
    const files = fs.readdirSync(USER_ADAPTER_DIR).filter((f) => f.endsWith('.json'));
    return files.flatMap((file) => {
      const fullPath = path.join(USER_ADAPTER_DIR, file);
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        const adapter = parseAdapter(raw, fullPath);
        return adapter ? [adapter] : [];
      } catch (err) {
        console.error(`[adapter-registry] Failed to read ${fullPath}:`, err);
        return [];
      }
    });
  } catch (err) {
    console.error('[adapter-registry] Failed to scan user adapter dir:', err);
    return [];
  }
}

/** Verified compatibility defaults for existing user CLI manifests. */
function withNativeApprovalDefaults(adapter: Adapter): Adapter {
  if (adapter.kind !== 'cli-pty') return adapter;
  const permission = adapter.control.permission;
  // Qwen CLI advertises --yolo; the API provider with the same id is unrelated.
  const missingQwen = adapter.id === 'qwen' && adapter.bin === 'qwen'
    && !permission?.yolo.length;
  // Older Nexus Kimi manifests used --auto, which is not its approval flag.
  const legacyKimi = adapter.id === 'kimi' && adapter.bin === 'kimi'
    && (!permission?.yolo.length || permission.yolo.join(' ') === '--auto');
  if (!missingQwen && !legacyKimi) return adapter;
  return {
    ...adapter,
    control: {
      ...adapter.control,
      permission: { modes: {}, default: '', ...permission, yolo: ['--yolo'] },
    },
  };
}

/**
 * Merge builtin and user adapter arrays. User adapters with the same id as a
 * builtin override it; new ids are simply added. Pure function — testable without
 * side effects.
 */
export function mergeAdapters(
  builtins: readonly Adapter[],
  user: readonly Adapter[],
): Map<string, Adapter> {
  const merged = new Map<string, Adapter>();
  for (const a of builtins) {
    if (!isRetiredAdapter(a)) {
      merged.set(a.id, withNativeApprovalDefaults(a));
    }
  }
  for (const a of user) {
    if (!isRetiredAdapter(a)) {
      merged.set(a.id, withNativeApprovalDefaults(a));
    }
  }
  return merged;
}

/**
 * Effective PATH (login shell + curated install dirs). Kept for callers that
 * still inject PATH into child envs; discovery/spawn should prefer absolute
 * paths from getAdapterResolvedBin / resolveAdapterBinary.
 *
 * Ensures PATH has been folded at least once so GUI/Finder launches see the
 * same tools as an interactive shell without every caller re-probing.
 */
export function resolveLoginShellPath(): string {
  // getEffectivePath memoises; first call probes login shell once.
  const effective = getEffectivePath();
  // Keep process.env in sync for child PTYs that inherit PATH.
  if (process.env.PATH !== effective) {
    process.env.PATH = effective;
  }
  return effective;
}

/** Check whether the CLI binary for an adapter is available (absolute path). */
function resolveBin(bin: string): CliBinaryResolution | null {
  return resolveCliBinary(bin);
}

function isBinInstalled(bin: string): boolean {
  return resolveBin(bin) !== null;
}

function resolveIdleTimeoutMs(adapter: Adapter): number {
  if (adapter.kind !== 'cli-pty') return 0;
  const { idle } = adapter.stateParsing;
  return idle.type === 'timeout' ? idle.ms : 800;
}

export interface AdapterBinResolution {
  installed: boolean;
  /** Absolute path when installed; null when missing or api-provider. */
  binPath: string | null;
}

/**
 * Declared auth method for the renderer gate. Static metadata only — never
 * proof of a live session (herança Orca: cada CLI usa sua sessão nativa).
 */
export function authMethodForAdapter(adapter: Adapter): string {
  return adapter.kind === 'api-provider' ? 'api_key' : adapter.auth.method;
}

/** Build a trimmed AdapterInfo safe to send to the renderer. */
function toAdapterInfo(
  adapter: Adapter,
  resolution: AdapterBinResolution,
  origin: AdapterOrigin,
): AdapterInfo {
  const installCommand =
    adapter.kind !== 'api-provider'
      ? cliInstallCommandFor(adapter.id) ??
        compatibleManualInstallCommand(adapter.install.command)
      : null;
  const loginHint =
    adapter.kind !== 'api-provider' ? adapter.auth.loginHint : undefined;
  // Merge user-added custom models so a CLI's newest models (added by hand)
  // appear everywhere the adapter's models show.
  const custom = getCustomModels(adapter.id).filter(
    (m) => !adapter.models.list.includes(m),
  );
  const staticIds = [...adapter.models.list, ...custom];
  const discovered = discoveredModelsFor(adapter.id).filter(
    (m) => !staticIds.includes(m),
  );
  const modelList = [...staticIds, ...discovered];
  const capabilities = adapterCapabilityMatrixForAdapter(adapter, origin);
  const authMethod = authMethodForAdapter(adapter);
  return {
    id: adapter.id,
    kind: adapter.kind,
    label: adapter.label,
    icon: adapter.icon,
    models: {
      ...adapter.models,
      list: modelList,
      info: modelInfoForAdapter(loadModelCatalog(), adapter.id, modelList),
    },
    installed: resolution.installed,
    resolvedBinPath: resolution.binPath,
    // AdapterInfo mantém string por compatibilidade IPC; vazio significa que
    // não existe receita nativa segura para este SO (ex.: Muse no Windows).
    installCommand: installCommand ?? '',
    loginHint,
    authMethod,
    idleTimeoutMs: resolveIdleTimeoutMs(adapter),
    taskHandoffCapable: taskHandoffCapabilityForAdapter(adapter, origin),
    missionControlCapable: missionControlCapabilityForAdapter(adapter, origin),
    orchestratorCapable:
      adapter.kind === 'cli-pty' &&
      hasNexusMcpCapability(adapter.quirks),
    autonomousWorkspaceWriteCapable: capabilities.governedWriter,
    orchestrationEvidence: orchestrationEvidenceForAdapter(adapter, origin),
    capabilities,
  };
}

// ── Registry state ──────────────────────────────────────────────────────────

let registry = new Map<string, Adapter>();
let adapterOrigins = new Map<string, AdapterOrigin>();
/** Discovery cache: installed flag + absolute bin path for spawn. */
let installedCache = new Map<string, AdapterBinResolution>();
const listeners = new Set<WebContents>();
let watcher: fs.FSWatcher | null = null;
let modelCatalogWatcher: fs.FSWatcher | null = null;
const cliModelWatchers: fs.FSWatcher[] = [];
let periodicRefresh: ReturnType<typeof setInterval> | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

// Atomic saves (write-temp + rename) fire 2-4 fs.watch events per file change,
// and each reload() walks PATH for every adapter — enough to stall the main
// thread. Collapse the burst into one reload after a short quiet period.
const WATCH_DEBOUNCE_MS = 100;

function resolveAdapterBin(adapter: Adapter): AdapterBinResolution {
  if (adapter.kind === 'api-provider') {
    return { installed: true, binPath: null };
  }
  const hit = resolveBin(adapter.bin);
  return {
    installed: hit !== null,
    binPath: hit?.binPath ?? null,
  };
}

function refreshInstalledCache(): void {
  const next = new Map<string, AdapterBinResolution>();
  for (const [id, adapter] of registry) {
    next.set(id, resolveAdapterBin(adapter));
  }
  installedCache = next;
}

function reload(): void {
  const catalog = loadModelCatalog();
  const discovered = discoverCliModels();
  const discoveredEfforts = discoverCliEfforts();
  const builtins = loadBuiltins();
  const userAdapters = loadUserAdapters();
  registry = mergeAdapters(builtins, userAdapters);
  const userIds = new Set(userAdapters.map((adapter) => adapter.id));
  adapterOrigins = new Map(
    [...registry.keys()].map((id) => [
      id,
      userIds.has(id) ? 'user' : 'builtin',
    ]),
  );
  registry = new Map(
    [...registry.entries()].map(([id, adapter]) => [
      id,
      applyModelCatalogToAdapter(
        applyDiscoveredEffortsToAdapter(
          applyDiscoveredModelsToAdapter(adapter, discovered),
          discoveredEfforts,
        ),
        catalog,
      ),
    ]),
  );
  refreshInstalledCache();
}

/**
 * Send a payload to every live listener, pruning any whose webContents has
 * already been destroyed. Exported so the destroyed-window guard can be tested
 * without booting Electron. The registry must never hold references to dead
 * webContents — this is both the send guard and the leak sweep.
 */
export function broadcastToListeners(
  targets: Set<WebContents>,
  channel: string,
  payload: unknown,
): void {
  for (const wc of [...targets]) {
    // Destroyed is permanent → prune. Crashed is transient (the renderer may
    // reload the same webContents) → skip this send but keep the listener.
    // isDestroyed() alone is insufficient: right after a renderer crash it still
    // reports false, yet send() would log "Render frame was disposed".
    if (wc.isDestroyed()) {
      targets.delete(wc);
      continue;
    }
    if (wc.isCrashed()) continue;
    wc.send(channel, payload);
  }
}

function broadcast(): void {
  broadcastToListeners(listeners, ADAPTER_CHANNELS.changed, listAdapterInfos());
}

/** Push the (possibly custom-model-updated) adapter list to the renderer. */
export function notifyAdaptersChanged(): void {
  // Do NOT re-walk PATH here — model catalog / custom-model updates fire this
  // often and shell probes would stall main. Call rescanAdapterBinaries() after
  // external installs or explicit "Reexaminar CLIs".
  invalidateAdapterHotCache();
  broadcast();
}

function scheduleReloadAndBroadcast(): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    invalidateModelCatalogCache();
    reload();
    broadcast();
  }, WATCH_DEBOUNCE_MS);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initAdapterRegistry(): void {
  fs.mkdirSync(NEXUS_DIR, { recursive: true });
  fs.mkdirSync(USER_ADAPTER_DIR, { recursive: true });
  // Seed ~/.nexus/model-catalog.json from the published JSON when missing so
  // this machine has grok-4.5 / fable api-only flags without waiting on network.
  if (seedLocalModelCatalogFromPublished()) {
    invalidateModelCatalogCache();
  }
  reload();

  try {
    watcher = fs.watch(USER_ADAPTER_DIR, { persistent: false }, () => {
      scheduleReloadAndBroadcast();
    });
    watcher.on('error', (err) => {
      console.error('[adapter-registry] watcher error:', err);
    });
  } catch (err) {
    // fs.watch can fail in some sandboxed or network-mounted dirs — hot-reload
    // is best-effort; the registry still works without it.
    console.warn('[adapter-registry] hot-reload unavailable:', err);
  }

  try {
    modelCatalogWatcher = fs.watch(NEXUS_DIR, { persistent: false }, (_event, filename) => {
      if (!filename || filename.toString() !== path.basename(USER_MODEL_CATALOG_FILE)) return;
      scheduleReloadAndBroadcast();
    });
    modelCatalogWatcher.on('error', (err) => {
      console.error('[model-catalog] watcher error:', err);
    });
  } catch (err) {
    console.warn('[model-catalog] hot-reload unavailable:', err);
  }

  for (const directory of cliModelCacheDirectories()) {
    if (!fs.existsSync(directory)) continue;
    try {
      const cacheWatcher = fs.watch(directory, { persistent: false }, () => {
        scheduleReloadAndBroadcast();
      });
      cacheWatcher.on('error', (err) => {
        console.warn(`[model-catalog] CLI cache watcher falhou (${directory}):`, err);
      });
      cliModelWatchers.push(cacheWatcher);
    } catch (err) {
      console.warn(`[model-catalog] CLI cache sem hot-reload (${directory}):`, err);
    }
  }

  void refreshRemoteModelCatalog().then((updated) => {
    if (updated) scheduleReloadAndBroadcast();
  });

  refreshAllDiscoveredModels(
    [...registry.keys()],
    () => scheduleReloadAndBroadcast(),
  );

  // Remote metadata is eventually consistent; CLI cache watchers provide the
  // immediate path (Claude/Codex/Grok). Polling covers providers that atomically
  // replace caches in directories the platform watcher cannot observe, and
  // re-asks CLIs that expose a live models command (see MODEL_DISCOVERY_INVENTORY).
  // Grok is cache-only: the poll re-reads ~/.grok/models_cache.json and never
  // spawns `grok models` (that CLI rotates the refresh token on every run).
  periodicRefresh ??= setInterval(() => {
    refreshAllDiscoveredModels([...registry.keys()]);
    void refreshRemoteModelCatalog().finally(() => scheduleReloadAndBroadcast());
  }, MODEL_DISCOVERY_POLL_MS);
  periodicRefresh.unref?.();
}

export function registerAdapterListener(wc: WebContents): void {
  listeners.add(wc);
}

export function unregisterAdapterListener(wc: WebContents): void {
  listeners.delete(wc);
}

export function getAdapter(id: string): Adapter | null {
  return registry.get(canonicalCliAdapterId(id)) ?? null;
}

/** User adapters may override builtin ids; security qualifications never do. */
export function isBuiltinAdapter(id: string): boolean {
  return adapterOrigins.get(canonicalCliAdapterId(id)) === 'builtin';
}

/** Every loaded adapter (full config) — used by the provider settings hub. */
export function listAdapters(): Adapter[] {
  return [...registry.values()];
}

/**
 * The env var an adapter's API key should be injected as. cli-pty prefers its
 * declared auth fallback, else the first passthrough var; api-provider uses its
 * declared envVar. Returns null for adapters that don't take a key (oauth-only).
 */
export function primaryKeyEnvVar(adapter: Adapter): string | null {
  if (adapter.kind === 'api-provider') return adapter.auth.envVar;
  if (adapter.auth.method === 'oauth' || adapter.auth.method === 'subscription') {
    return null;
  }
  return adapter.auth.envVarFallback ?? adapter.env.passthrough[0] ?? null;
}

/** Whether a bin path (absolute or bare command) resolves on this machine. */
export function isBinResolvable(bin: string): boolean {
  if (path.isAbsolute(bin)) return revalidateExecutable(bin);
  return isBinInstalled(bin);
}

/**
 * Whether an adapter's CLI binary is currently resolvable. node-pty does not
 * throw for a missing bin on macOS — it spawns and immediately exits 1 — so the
 * spawn IPC must gate on this to surface an install hint instead of a bare
 * "process exited (code 1)".
 */
export function isAdapterInstalled(id: string): boolean {
  return installedCache.get(canonicalCliAdapterId(id))?.installed ?? false;
}

/**
 * Absolute path discovered for an adapter's CLI, or null when missing.
 * Spawn MUST use this path (or a user absolute override) — never the bare
 * command name — so detection and execution share the same executable.
 */
export function getAdapterResolvedBin(id: string): string | null {
  return installedCache.get(canonicalCliAdapterId(id))?.binPath ?? null;
}

/**
 * Live resolve (bypasses cache). Prefer for pre-spawn revalidation.
 * Returns absolute path or null.
 */
export function resolveAdapterBinary(id: string): string | null {
  const canonicalId = canonicalCliAdapterId(id);
  const adapter = registry.get(canonicalId);
  if (!adapter || adapter.kind === 'api-provider') return null;
  const hit = resolveBin(adapter.bin);
  if (hit) {
    installedCache.set(canonicalId, { installed: true, binPath: hit.binPath });
  } else {
    installedCache.set(canonicalId, { installed: false, binPath: null });
  }
  return hit?.binPath ?? null;
}

/**
 * Re-fold PATH, re-probe every adapter binary, broadcast. Use after external
 * CLI installs (brew/npm/kimi installer) without restarting the app.
 */
export async function rescanAdapterBinaries(): Promise<AdapterInfo[]> {
  await refreshUserPath();
  refreshInstalledCache();
  invalidateAdapterHotCache();
  const infos = listAdapterInfos();
  broadcastToListeners(listeners, ADAPTER_CHANNELS.changed, infos);
  return infos;
}

export function listAdapterInfos(): AdapterInfo[] {
  return [...registry.values()].map((a) =>
    toAdapterInfo(
      a,
      installedCache.get(a.id) ?? { installed: false, binPath: null },
      adapterOrigins.get(a.id) ?? 'user',
    ),
  );
}

export function closeAdapterRegistry(): void {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  watcher?.close();
  watcher = null;
  modelCatalogWatcher?.close();
  modelCatalogWatcher = null;
  listeners.clear();
}
