import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { WebContents } from 'electron';
import { adapterSchema } from '../../shared/adapter-types';
import type { Adapter, AdapterInfo } from '../../shared/adapter-types';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { ADAPTER_CHANNELS } from '../../shared/channels';
import { getCustomModels } from './custom-models';

const USER_ADAPTER_DIR = path.join(os.homedir(), '.nexus', 'plugins', 'adapters');

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

/** Check whether the CLI binary for an adapter is available on PATH. */
function isBinInstalled(bin: string): boolean {
  // `which` doesn't exist on Windows; `where` is the equivalent lookup.
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(lookup, [bin], { stdio: 'pipe', encoding: 'utf-8' });
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
  return {
    id: adapter.id,
    kind: adapter.kind,
    label: adapter.label,
    icon: adapter.icon,
    models: {
      ...adapter.models,
      list: [...adapter.models.list, ...custom],
    },
    installed,
    installCommand,
    loginHint,
    idleTimeoutMs: resolveIdleTimeoutMs(adapter),
  };
}

// ── Registry state ──────────────────────────────────────────────────────────

let registry = new Map<string, Adapter>();
let installedCache = new Map<string, boolean>();
const listeners = new Set<WebContents>();
let watcher: fs.FSWatcher | null = null;
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
  registry = mergeAdapters(loadBuiltins(), loadUserAdapters());
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

// ── Public API ───────────────────────────────────────────────────────────────

export function initAdapterRegistry(): void {
  fs.mkdirSync(USER_ADAPTER_DIR, { recursive: true });
  reload();

  try {
    watcher = fs.watch(USER_ADAPTER_DIR, { persistent: false }, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        reload();
        broadcast();
      }, WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', (err) => {
      console.error('[adapter-registry] watcher error:', err);
    });
  } catch (err) {
    // fs.watch can fail in some sandboxed or network-mounted dirs — hot-reload
    // is best-effort; the registry still works without it.
    console.warn('[adapter-registry] hot-reload unavailable:', err);
  }
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
  listeners.clear();
}
