import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { WebContents } from 'electron';
import {
  adapterSchema,
  hasNexusMcpCapability,
} from '../../shared/adapter-types';
import type { Adapter, AdapterInfo } from '../../shared/adapter-types';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { ADAPTER_CHANNELS } from '../../shared/channels';
import { getCustomModels } from './custom-models';
import {
  applyDiscoveredEffortsToAdapter,
  applyDiscoveredModelsToAdapter,
  cliModelCacheDirectories,
  discoverCliEfforts,
  discoverCliModels,
} from './cli-model-discovery';
import {
  USER_MODEL_CATALOG_FILE,
  applyModelCatalogToAdapter,
  invalidateModelCatalogCache,
  loadModelCatalog,
  modelInfoForAdapter,
  refreshRemoteModelCatalog,
  seedLocalModelCatalogFromPublished,
} from './model-catalog';

const USER_ADAPTER_DIR = path.join(os.homedir(), '.nexus', 'plugins', 'adapters');
const NEXUS_DIR = path.join(os.homedir(), '.nexus');

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
  for (const a of builtins) merged.set(a.id, a);
  for (const a of user) merged.set(a.id, a);
  return merged;
}

/**
 * Resolve the login-shell PATH once per process lifetime.
 *
 * GUI apps launched from Finder/Dock/Spotlight inherit only a minimal PATH
 * (~100 bytes) that omits everything set in the user's shell profile
 * (~/.zprofile, ~/.bash_profile, .bashrc, nvm, volta, Homebrew…).  Spawning
 * the user's login shell with `-l` sources those profiles and gives us the
 * real PATH so `which` can find CLIs installed there.
 *
 * Cost: one synchronous shell spawn at first call (~50–300 ms), then zero —
 * the result is memoised for the process lifetime.
 */
const COMMON_MAC_LINUX_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
];

let _loginShellPath: string | null = null;
function resolveLoginShellPath(): string {
  if (_loginShellPath !== null) return _loginShellPath;
  if (process.platform === 'win32') {
    _loginShellPath = process.env.PATH ?? '';
    return _loginShellPath;
  }
  const shell = process.env.SHELL ?? '/bin/bash';
  let resolved = process.env.PATH ?? '';
  try {
    const out = execFileSync(shell, ['-l', '-c', 'printf "%s" "$PATH"'], {
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 5_000,
    });
    resolved = out.trim() || resolved;
  } catch {
    // Heavy profiles timing out won't lock out standard installations.
  }

  const paths = resolved.split(path.delimiter);
  for (const p of COMMON_MAC_LINUX_PATHS) {
    if (!paths.includes(p)) {
      paths.push(p);
    }
  }
  _loginShellPath = paths.join(path.delimiter);
  return _loginShellPath;
}

/** Check whether the CLI binary for an adapter is available on PATH. */
function isBinInstalled(bin: string): boolean {
  // `which` doesn't exist on Windows; `where` is the equivalent lookup.
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(lookup, [bin], { stdio: 'pipe', encoding: 'utf-8' });
    return true;
  } catch {
    // Fast path failed.  Packaged GUI apps on macOS/Linux inherit a minimal
    // PATH that skips login-shell entries.  Re-try with the full login-shell
    // PATH so the installed check succeeds for CLIs in ~/.local/bin,
    // /opt/homebrew/bin, nvm shims, volta, etc.
  }
  if (process.platform === 'win32') return false;
  const lsPath = resolveLoginShellPath();
  if (!lsPath || lsPath === (process.env.PATH ?? '')) return false;
  try {
    execFileSync(lookup, [bin], {
      stdio: 'pipe',
      encoding: 'utf-8',
      env: { ...process.env, PATH: lsPath },
    });
    return true;
  } catch {
    return false;
  }
}

function resolveIdleTimeoutMs(adapter: Adapter): number {
  if (adapter.kind !== 'cli-pty') return 0;
  const { idle } = adapter.stateParsing;
  return idle.type === 'timeout' ? idle.ms : 800;
}

/** Build a trimmed AdapterInfo safe to send to the renderer. */
function toAdapterInfo(adapter: Adapter, installed: boolean): AdapterInfo {
  const installCommand =
    adapter.kind === 'cli-pty' ? adapter.install.command : '';
  const loginHint =
    adapter.kind === 'cli-pty' ? adapter.auth.loginHint : undefined;
  // Merge user-added custom models so a CLI's newest models (added by hand)
  // appear everywhere the adapter's models show.
  const custom = getCustomModels(adapter.id).filter(
    (m) => !adapter.models.list.includes(m),
  );
  const modelList = [...adapter.models.list, ...custom];
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
    installed,
    installCommand,
    loginHint,
    idleTimeoutMs: resolveIdleTimeoutMs(adapter),
    orchestratorCapable:
      adapter.kind === 'cli-pty' &&
      hasNexusMcpCapability(adapter.quirks),
  };
}

// ── Registry state ──────────────────────────────────────────────────────────

let registry = new Map<string, Adapter>();
let installedCache = new Map<string, boolean>();
const listeners = new Set<WebContents>();
let watcher: fs.FSWatcher | null = null;
let modelCatalogWatcher: fs.FSWatcher | null = null;
const cliModelWatchers: fs.FSWatcher[] = [];
let periodicRefresh: ReturnType<typeof setInterval> | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

// Atomic saves (write-temp + rename) fire 2-4 fs.watch events per file change,
// and each reload() shells out `which <bin>` for every adapter — enough to stall
// the main thread. Collapse the burst into one reload after a short quiet period.
const WATCH_DEBOUNCE_MS = 100;

function refreshInstalledCache(): void {
  const next = new Map<string, boolean>();
  for (const [id, adapter] of registry) {
    const bin = adapter.kind === 'cli-pty' ? adapter.bin : null;
    next.set(id, bin ? isBinInstalled(bin) : true);
  }
  installedCache = next;
}

function reload(): void {
  const catalog = loadModelCatalog();
  const discovered = discoverCliModels();
  const discoveredEfforts = discoverCliEfforts();
  registry = mergeAdapters(loadBuiltins(), loadUserAdapters());
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

  // Remote metadata is eventually consistent; CLI cache watchers provide the
  // immediate path. Polling covers providers that atomically replace caches in
  // directories the platform watcher cannot observe.
  periodicRefresh ??= setInterval(() => {
    void refreshRemoteModelCatalog().finally(() => scheduleReloadAndBroadcast());
  }, 5 * 60_000);
  periodicRefresh.unref?.();
}

export function registerAdapterListener(wc: WebContents): void {
  listeners.add(wc);
}

export function unregisterAdapterListener(wc: WebContents): void {
  listeners.delete(wc);
}

export function getAdapter(id: string): Adapter | null {
  return registry.get(id) ?? null;
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
  if (bin.includes('/')) {
    try {
      return fs.statSync(bin).isFile();
    } catch {
      return false;
    }
  }
  return isBinInstalled(bin);
}

/**
 * Whether an adapter's CLI binary is currently resolvable on PATH. node-pty does
 * not throw for a missing bin on macOS — it spawns and immediately exits 1 — so
 * the spawn IPC must gate on this to surface an install hint instead of a bare
 * "process exited (code 1)".
 */
export function isAdapterInstalled(id: string): boolean {
  return installedCache.get(id) ?? false;
}

export function listAdapterInfos(): AdapterInfo[] {
  return [...registry.values()].map((a) =>
    toAdapterInfo(a, installedCache.get(a.id) ?? false),
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
