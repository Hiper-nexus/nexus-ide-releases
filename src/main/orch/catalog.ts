import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * aitmpl.com community catalog (davila7/claude-code-templates, 70+ agents) —
 * Overclock parity for `catalog_install`. Search hits the public catalog API;
 * install writes the component into ~/.nexus/plugins/catalog/<kind>/.
 * Fully network-optional: failures return a structured error, never throw
 * into the MCP transport.
 */

const SEARCH_URL = 'https://www.aitmpl.com/api/catalog/search';
const RAW_BASE =
  'https://raw.githubusercontent.com/davila7/claude-code-templates/main';
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 10;

export type CatalogKind = 'agent' | 'skill' | 'command';

export interface CatalogInstallInput {
  query?: string;
  kind?: CatalogKind;
  limit?: number;
  item?: string;
}

interface CatalogItem {
  name?: string;
  kind?: string;
  description?: string;
  path?: string;
  content?: string;
  [key: string]: unknown;
}

function catalogDir(): string {
  return path.join(os.homedir(), '.nexus', 'plugins', 'catalog');
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchCatalog(
  query: string,
  kind?: CatalogKind,
  limit = DEFAULT_LIMIT,
): Promise<CatalogItem[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', query);
  if (kind) url.searchParams.set('kind', kind);
  url.searchParams.set('limit', String(limit));
  const res = await fetchWithTimeout(url.toString());
  if (!res.ok) throw new Error(`catalog search failed: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  if (Array.isArray(body)) return body as CatalogItem[];
  const items = (body as { items?: unknown; results?: unknown }).items ??
    (body as { results?: unknown }).results;
  return Array.isArray(items) ? (items as CatalogItem[]) : [];
}

/** Only allow simple relative component names — no traversal, no absolutes. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._\/-]/g, '-');
  if (cleaned.includes('..') || path.isAbsolute(cleaned)) {
    throw new Error(`unsafe catalog item name: ${name}`);
  }
  return cleaned;
}

async function installItem(item: CatalogItem): Promise<{ installedTo: string }> {
  const name = safeName(String(item.name ?? 'component'));
  const kind = typeof item.kind === 'string' ? item.kind : 'agent';

  let content = typeof item.content === 'string' ? item.content : null;
  let ext = '.md';
  if (!content && typeof item.path === 'string') {
    const rawPath = safeName(item.path);
    const res = await fetchWithTimeout(`${RAW_BASE}/${rawPath}`);
    if (!res.ok) {
      throw new Error(`failed to download ${rawPath}: HTTP ${res.status}`);
    }
    content = await res.text();
    ext = path.extname(rawPath) || '.md';
  }
  if (!content) {
    throw new Error('catalog item has neither inline content nor a repo path');
  }

  const dir = path.join(catalogDir(), kind);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(name, path.extname(name));
  const target = path.join(dir, `${base}${ext}`);
  fs.writeFileSync(target, content, 'utf8');
  return { installedTo: target };
}

/** One locally installed catalog component (or user plugin file). */
export interface InstalledItem {
  kind: string;
  name: string;
  file: string;
  size: number;
  modifiedAt: number;
}

function scanDir(dir: string, kind: string): InstalledItem[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => {
        const file = path.join(dir, entry.name);
        const stat = fs.statSync(file);
        return {
          kind,
          name: path.basename(entry.name, path.extname(entry.name)),
          file,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        };
      });
  } catch {
    return []; // Directory absent — nothing installed.
  }
}

/** Everything installed under ~/.nexus/plugins/catalog/<kind>/. */
export function listInstalledCatalogItems(): InstalledItem[] {
  const root = catalogDir();
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => scanDir(path.join(root, entry.name), entry.name));
  } catch {
    return [];
  }
}

/** User plugin files (declarative adapters + voice configs). */
export function listPluginFiles(): InstalledItem[] {
  const pluginsRoot = path.join(os.homedir(), '.nexus', 'plugins');
  return [
    ...scanDir(path.join(pluginsRoot, 'adapters'), 'adapter'),
    ...scanDir(path.join(pluginsRoot, 'voice'), 'voice'),
    ...scanDir(path.join(pluginsRoot, 'themes'), 'theme'),
    ...scanDir(path.join(pluginsRoot, 'keybindings'), 'keybinding'),
  ];
}

/** Generated skill-gate hook homes (one per gated worker session). */
export function listHookHomes(): InstalledItem[] {
  const root = path.join(os.homedir(), '.nexus', 'ephemeral');
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(root, entry.name);
        const stat = fs.statSync(dir);
        return {
          kind: 'hook-home',
          name: entry.name,
          file: dir,
          size: 0,
          modifiedAt: stat.mtimeMs,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Search and/or install. With only `query`: returns matches. With `item`
 * (exact name from a previous search): installs it.
 */
export async function catalogInstall(input: CatalogInstallInput): Promise<{
  ok: boolean;
  results?: CatalogItem[];
  installedTo?: string;
  error?: string;
}> {
  try {
    if (input.item) {
      const matches = await searchCatalog(input.item, input.kind, 5);
      const exact =
        matches.find((m) => m.name === input.item) ?? matches[0] ?? null;
      if (!exact) return { ok: false, error: `no catalog item: ${input.item}` };
      const { installedTo } = await installItem(exact);
      return { ok: true, installedTo };
    }
    if (input.query) {
      const results = await searchCatalog(
        input.query,
        input.kind,
        input.limit ?? DEFAULT_LIMIT,
      );
      return { ok: true, results };
    }
    return { ok: false, error: 'provide query (search) or item (install)' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `catalog unavailable: ${detail}` };
  }
}
