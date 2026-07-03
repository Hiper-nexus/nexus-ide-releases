import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { WebContents } from 'electron';
import { adapterSchema } from '../../shared/adapter-types';
import type { Adapter, AdapterInfo } from '../../shared/adapter-types';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { ADAPTER_CHANNELS } from '../../shared/channels';

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
  try {
    execFileSync('which', [bin], { stdio: 'pipe', encoding: 'utf-8' });
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
  return {
    id: adapter.id,
    kind: adapter.kind,
    label: adapter.label,
    icon: adapter.icon,
    models: adapter.models,
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

function broadcast(): void {
  const info = listAdapterInfos();
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(ADAPTER_CHANNELS.changed, info);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initAdapterRegistry(): void {
  fs.mkdirSync(USER_ADAPTER_DIR, { recursive: true });
  reload();

  try {
    watcher = fs.watch(USER_ADAPTER_DIR, { persistent: false }, () => {
      reload();
      broadcast();
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

export function listAdapterInfos(): AdapterInfo[] {
  return [...registry.values()].map((a) =>
    toAdapterInfo(a, installedCache.get(a.id) ?? false),
  );
}

export function closeAdapterRegistry(): void {
  watcher?.close();
  watcher = null;
  listeners.clear();
}
