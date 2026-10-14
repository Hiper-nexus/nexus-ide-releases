import fsp from 'node:fs/promises';
import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
import { enqueuePostBootIdleTask, isPostBootIdleReady } from '../observability/post-boot-idle-queue';
import { readRegularFileCappedAsync } from '../redline/redline-safe-read';
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
  invalidateLookupInPathCache,
  onCliVersionLearned,
  resolveCliBinary,
  revalidateExecutable,
  refreshUserPath,
  getEffectivePath,
  warmCliBinaryVersions,
  type CliBinaryResolution,
} from '../path-resolver';
import { CLI_COMPATIBILITY_POLICIES } from './cli-compatibility';
import {
  applyDiscoveredEffortsToAdapter,
  applyDiscoveredModelsToAdapter,
  cliModelCacheDirectories,
  discoverCliModelsAndEfforts,
  discoverCliModelsAndEffortsAsync,
} from './cli-model-discovery';
import {
  MODEL_DISCOVERY_POLL_MS,
  onDiscoveredModelsChanged,
  refreshAllDiscoveredModels,
} from './model-discovery';
import { modelListAuthority } from './model-availability';
import { currentModelOffer, resolveAdapterModelOffer, setModelOfferBase } from './model-offer';
import {
  USER_MODEL_CATALOG_FILE,
  applyModelCatalogToAdapter,
  invalidateModelCatalogCache,
  isModelBlockedForAutoRouting,
  loadModelCatalog,
  loadModelCatalogAsync,
  modelCatalogInfo,
  modelInfoForAdapter,
  refreshRemoteModelCatalog,
  seedLocalModelCatalogFromPublished,
  type ModelCatalog,
} from './model-catalog';
import { newestInModelLine } from '../../shared/model-line';
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
  installationWarning?: string;
}

/**
 * Declared auth method for the renderer gate. Static metadata only — never
 * proof of a live session (herança Orca: cada CLI usa sua sessão nativa).
 */
/** F-1411: a declaração de bracketed paste que o renderer precisa (ausente = aceita). */
export function bracketedPasteForAdapter(adapter: Adapter): boolean | undefined {
  return adapter.kind === 'cli-pty' ? adapter.promptInjection?.bracketedPaste : undefined;
}

export function authMethodForAdapter(adapter: Adapter): string {
  return adapter.kind === 'api-provider' ? 'api_key' : adapter.auth.method;
}

/** Build a trimmed AdapterInfo safe to send to the renderer. */
export function toAdapterInfo(
  adapter: Adapter,
  resolution: AdapterBinResolution,
  origin: AdapterOrigin,
): AdapterInfo {
  const installCommand =
    adapter.kind !== 'api-provider'
      ? cliInstallCommandFor(adapter.id) ??
        compatibleManualInstallCommand(adapter.install.command)
      : null;
  const cliInstallationWarning = adapter.kind === 'cli-pty'
    ? resolution.installationWarning : undefined;
  const loginHint =
    adapter.kind !== 'api-provider' ? adapter.auth.loginHint : undefined;
  // F-990: a oferta sai do resolvedor (listagem viva autoritativa + custom do
  // operador), não da união estático ∪ catálogo ∪ descoberta.
  const offer = currentModelOffer(adapter);
  const modelList = [...offer.offered];
  const capabilities = adapterCapabilityMatrixForAdapter(adapter, origin);
  const authMethod = authMethodForAdapter(adapter);
  const bracketedPaste = bracketedPasteForAdapter(adapter);
  return {
    id: adapter.id,
    kind: adapter.kind,
    label: adapter.label,
    icon: adapter.icon,
    models: {
      ...adapter.models,
      list: modelList,
      default: offer.defaultModel,
      info: modelInfoForAdapter(loadModelCatalog(), adapter.id, modelList),
    },
    installed: resolution.installed,
    resolvedBinPath: resolution.binPath,
    ...(cliInstallationWarning ? { cliInstallationWarning } : {}),
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
    ...(typeof bracketedPaste === 'boolean' ? { bracketedPaste } : {}),
    autonomousWorkspaceWriteCapable: capabilities.governedWriter,
    orchestrationEvidence: orchestrationEvidenceForAdapter(adapter, origin),
    capabilities,
  };
}

// ── Registry state ──────────────────────────────────────────────────────────

let registry = new Map<string, Adapter>();
let stopDiscoveryListener: (() => void) | null = null;
let adapterOrigins = new Map<string, AdapterOrigin>();
/** Discovery cache: installed flag + absolute bin path for spawn. */
let installedCache = new Map<string, AdapterBinResolution>();
const listeners = new Set<WebContents>();
let watcher: fs.FSWatcher | null = null;
let modelCatalogWatcher: fs.FSWatcher | null = null;
const cliModelWatchers: fs.FSWatcher[] = [];
let periodicRefresh: ReturnType<typeof setInterval> | null = null;
let registryController = new AbortController();
let registryEpoch = 0;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let cliVersionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let stopCliVersionListener: (() => void) | null = null;

// Atomic saves (write-temp + rename) fire 2-4 fs.watch events per file change,
// and each reload() walks PATH for every adapter — enough to stall the main
// thread. Collapse the burst into one reload after a short quiet period.
const WATCH_DEBOUNCE_MS = 100;
/**
 * Comandos cuja instalação ÚNICA também é sondada no aquecimento: o gate de
 * versão do Codex (`--dangerously-bypass-hook-trust`) lê o mesmo cache, e as
 * faixas de compatibilidade (F-992) avisam antes do spawn com a versão sondada.
 */
const VERSION_GATED_CLIS = [
  ...new Set(['codex', ...CLI_COMPATIBILITY_POLICIES.map((policy) => policy.bin)]),
];

function resolveAdapterBin(adapter: Adapter): AdapterBinResolution {
  if (adapter.kind === 'api-provider') {
    return { installed: true, binPath: null };
  }
  const hit = resolveBin(adapter.bin);
  return {
    installed: hit !== null,
    binPath: hit?.binPath ?? null,
    ...(hit?.installationWarning ? { installationWarning: hit.installationWarning } : {}),
  };
}

function refreshInstalledCache(): void {
  const next = new Map<string, AdapterBinResolution>();
  for (const [id, adapter] of registry) {
    next.set(id, resolveAdapterBin(adapter));
  }
  installedCache = next;
}

/**
 * F-217 (regra do operador 29/09): a CLI pode anunciar um modelo mais novo da
 * mesma linha do default catalogado (`gpt-6.2-sol` antes de qualquer catálogo
 * conhecê-lo). O default do pane passa a apontar para ele — mas só entre os
 * elegíveis (nunca api-only/deprecated). Sem default declarado, nada muda.
 */
export function applyNewestModelLineDefault(
  adapter: Adapter,
  catalog: ModelCatalog,
): Adapter {
  const current = adapter.models.default;
  if (!current?.trim()) return adapter;
  const newest = newestInModelLine(
    current,
    adapter.models.list.filter(
      (model) =>
        !isModelBlockedForAutoRouting(
          modelCatalogInfo(catalog, adapter.id, model),
        ),
    ),
  );
  if (newest === current) return adapter;
  return { ...adapter, models: { ...adapter.models, default: newest } };
}

/**
 * Composição de modelos no reload. CLI sem listagem (`bundled`) segue a união
 * de sempre (estático ∪ cache ∪ catálogo); CLI que lista recebe a oferta
 * autoritativa — o resto do Main (squad, failover, spawn) lê este registro.
 */
function composeAdapterModels(
  adapter: Adapter,
  discovered: ReadonlyMap<string, readonly string[]>,
  efforts: ReadonlyMap<string, readonly string[]>,
  catalog: ModelCatalog,
): Adapter {
  const withEfforts = applyDiscoveredEffortsToAdapter(adapter, efforts);
  if (modelListAuthority(adapter.id) === 'bundled') {
    return applyNewestModelLineDefault(
      applyModelCatalogToAdapter(applyDiscoveredModelsToAdapter(withEfforts, discovered), catalog),
      catalog,
    );
  }
  const offer = resolveAdapterModelOffer(withEfforts, {
    catalog,
    cacheIds: discovered.get(adapter.id) ?? [],
  });
  return {
    ...withEfforts,
    models: { ...withEfforts.models, list: [...offer.offered], default: offer.defaultModel },
  };
}

function reload(): void {
  const catalog = loadModelCatalog();
  const { models: discovered, efforts: discoveredEfforts } = discoverCliModelsAndEfforts();
  const builtins = loadBuiltins();
  const userAdapters = loadUserAdapters();
  const baseAdapters = mergeAdapters(builtins, userAdapters);
  setModelOfferBase(baseAdapters, discovered);
  const userIds = new Set(userAdapters.map((adapter) => adapter.id));
  adapterOrigins = new Map(
    [...baseAdapters.keys()].map((id) => [
      id,
      userIds.has(id) ? 'user' : 'builtin',
    ]),
  );
  registry = new Map(
    [...baseAdapters.entries()].map(([id, adapter]) => [
      id,
      composeAdapterModels(adapter, discovered, discoveredEfforts, catalog),
    ]),
  );
  refreshInstalledCache();
}

async function reloadBudgeted(context: PeriodicTaskContext): Promise<void> {
  const epoch = registryEpoch;
  const previousRegistry = registry;
  const catalog = await context.wait(loadModelCatalogAsync());
  const { models: discovered, efforts } = await context.wait(discoverCliModelsAndEffortsAsync(undefined, context));
  const users: Adapter[] = [];
  let directory: Awaited<ReturnType<typeof fsp.opendir>> | null = null;
  try { directory = await fsp.opendir(USER_ADAPTER_DIR, { bufferSize: 32 }); } catch { /* No user definitions. */ }
  if (directory) {
    try {
      for (;;) {
        await context.checkpoint();
        const entry = await context.wait(directory.read());
        if (!entry) break;
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const file = path.join(USER_ADAPTER_DIR, entry.name);
        const read = await context.wait(readRegularFileCappedAsync(file, 1024 * 1024));
        if (read.kind !== 'text') continue;
        try { const adapter = parseAdapter(JSON.parse(read.text), file); if (adapter) users.push(adapter); }
        catch { /* A malformed definition contributes no capability. */ }
      }
    } finally { await directory.close(); }
  }
  const base = mergeAdapters(loadBuiltins(), users);
  const next = new Map<string, Adapter>();
  for (const [id, adapter] of base) {
    await context.checkpoint();
    next.set(id, composeAdapterModels(adapter, discovered, efforts, catalog));
  }
  if (registryEpoch !== epoch) return;
  context.assertCurrent();
  const origins = new Set(users.map((adapter) => adapter.id));
  const installations = new Map<string, AdapterBinResolution>();
  for (const [id, adapter] of next) {
    await context.checkpoint();
    if (registryEpoch !== epoch || registry !== previousRegistry) return;
    installations.set(id, resolveAdapterBin(adapter));
  }
  if (registryEpoch !== epoch || registry !== previousRegistry) return;
  registry = next;
  setModelOfferBase(base, discovered);
  adapterOrigins = new Map([...next.keys()].map((id) => [id, origins.has(id) ? 'user' : 'builtin']));
  installedCache = installations;
  invalidateAdapterHotCache();
  broadcast();
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

function runAdapterRegistryReload(): Promise<void> {
  if (registryController.signal.aborted) return Promise.resolve();
  invalidateModelCatalogCache();
  return runPeriodicTask('adapter-registry-reload', reloadBudgeted, { signal: registryController.signal }).catch((error) => {
    if (!registryController.signal.aborted) console.warn('[adapter-registry] refresh failed:', error);
  });
}

function scheduleReloadAndBroadcast(): void {
  registryEpoch++;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (!isPostBootIdleReady()) {
      enqueuePostBootIdleTask('adapter-registry-reload', () => runAdapterRegistryReload());
      return;
    }
    void runAdapterRegistryReload();
  }, WATCH_DEBOUNCE_MS);
}

/**
 * F-790/F-764: a sonda `--version` roda fora do Main. Quando ela aprende uma
 * versão, a escolha entre instalações duplicadas pode mudar — refaz o cache
 * de binários (só PATH, sem subprocesso) e avisa o renderer, uma vez por
 * rajada de sondas.
 */
function scheduleCliVersionRefresh(): void {
  registryEpoch++;
  if (cliVersionRefreshTimer) return;
  cliVersionRefreshTimer = setTimeout(() => {
    cliVersionRefreshTimer = null;
    refreshInstalledCache();
    invalidateAdapterHotCache();
    broadcast();
  }, WATCH_DEBOUNCE_MS);
  cliVersionRefreshTimer.unref?.();
}

/** Aquecimento das versões das CLIs de IA; nunca rejeita. */
function warmAdapterCliVersions(): Promise<number> {
  return warmCliBinaryVersions({ alsoSingle: VERSION_GATED_CLIS }).catch(() => 0);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initAdapterRegistry(): void {
  registryEpoch++;
  registryController = new AbortController();
  fs.mkdirSync(NEXUS_DIR, { recursive: true });
  fs.mkdirSync(USER_ADAPTER_DIR, { recursive: true });
  // Seed ~/.nexus/model-catalog.json from the published JSON when missing so
  // this machine has grok-4.5 / fable api-only flags without waiting on network.
  if (seedLocalModelCatalogFromPublished()) {
    invalidateModelCatalogCache();
  }
  reload();
  // F-764: o inventário acima só lê versões já em cache (instalação duplicada
  // sem versão conhecida fica na ordem do PATH). As sondas rodam fora do Main;
  // quando voltam, o cache de binários é refeito e o renderer avisado.
  stopCliVersionListener ??= onCliVersionLearned(scheduleCliVersionRefresh);
  // F-990: a listagem viva mudou (ou falhou e caiu na última boa) → o
  // registro recompõe a oferta para spawn, squad e failover.
  stopDiscoveryListener ??= onDiscoveredModelsChanged(scheduleReloadAndBroadcast);

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

  enqueuePostBootIdleTask('adapter-model-refresh', async () => {
    if (registryController.signal.aborted) return;
    void warmAdapterCliVersions();
    await runPeriodicTask('adapter-model-refresh', async (context) => {
      await Promise.all([
        context.wait(refreshRemoteModelCatalog()),
        context.wait(refreshAllDiscoveredModels([...registry.keys()], undefined, context)),
      ]);
      if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
      }
      invalidateModelCatalogCache();
      await reloadBudgeted(context);
    }, { signal: registryController.signal, cadenceMs: MODEL_DISCOVERY_POLL_MS }).catch((error) => {
      if (!registryController.signal.aborted) console.warn('[adapter-registry] initial model refresh failed:', error);
    });
    if (registryController.signal.aborted) return;
    // Remote metadata is eventually consistent; CLI cache watchers provide the
    // immediate path (Claude/Codex/Grok). Polling covers providers that atomically
    // replace caches in directories the platform watcher cannot observe, and
    // re-asks CLIs that expose a live models command (see MODEL_DISCOVERY_INVENTORY).
    // Grok is cache-only: the poll re-reads ~/.grok/models_cache.json and never
    // spawns `grok models` (that CLI rotates the refresh token on every run).
    periodicRefresh ??= setInterval(() => {
      void runPeriodicTask('adapter-model-refresh', async (context) => {
        await context.wait(refreshAllDiscoveredModels([...registry.keys()], undefined, context));
        await context.wait(refreshRemoteModelCatalog());
        if (reloadTimer) {
          clearTimeout(reloadTimer);
          reloadTimer = null;
        }
        invalidateModelCatalogCache();
        await reloadBudgeted(context);
      }, { signal: registryController.signal, cadenceMs: MODEL_DISCOVERY_POLL_MS }).catch((error) => {
        if (!registryController.signal.aborted) console.warn('[adapter-registry] model refresh failed:', error);
      });
    }, MODEL_DISCOVERY_POLL_MS);
    periodicRefresh.unref?.();
  });
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
    installedCache.set(canonicalId, {
      installed: true,
      binPath: hit.binPath,
      ...(hit.installationWarning ? { installationWarning: hit.installationWarning } : {}),
    });
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
  invalidateLookupInPathCache();
  await refreshUserPath();
  // Reexame é pedido explícito (ou pós-atualização): espera as sondas, que
  // rodam fora do Main, e já devolve a instalação mais nova.
  await warmAdapterCliVersions();
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

export async function closeAdapterRegistry(): Promise<void> {
  registryEpoch++;
  registryController.abort(new Error('adapter registry stopped'));
  if (periodicRefresh) clearInterval(periodicRefresh);
  periodicRefresh = null;
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  if (cliVersionRefreshTimer) {
    clearTimeout(cliVersionRefreshTimer);
    cliVersionRefreshTimer = null;
  }
  stopCliVersionListener?.();
  stopCliVersionListener = null;
  stopDiscoveryListener?.();
  stopDiscoveryListener = null;
  watcher?.close();
  watcher = null;
  modelCatalogWatcher?.close();
  modelCatalogWatcher = null;
  listeners.clear();
  await Promise.all([stopPeriodicTask('adapter-model-refresh'), stopPeriodicTask('adapter-registry-reload')]);
}
