import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * aitmpl catalog (davila7/claude-code-templates) — the catalog install
 * mechanism:
 *
 *  - agents: GET raw.githubusercontent.com/.../cli-tool/components/agents/
 *    <slug>.md → written to ~/.claude/agents/<name>.md
 *  - skills: BFS over the GitHub Contents API starting at
 *    cli-tool/components/skills/<slug> → directory tree written to
 *    ~/.claude/skills/<name>
 *  - both skip silently when the target already exists
 *
 * Browsing/search uses a single git-tree fetch cached on disk (the "skills
 * cache"/"agents cache").
 */

const REPO = 'davila7/claude-code-templates';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const API_BASE = `https://api.github.com/repos/${REPO}`;
const USER_AGENT = 'nexus-ide';
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_FILE = path.join(os.homedir(), '.nexus', 'catalog-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SKILL_FILES = 200;

export type CatalogKind = 'agent' | 'skill';

export interface CatalogEntry {
  kind: CatalogKind;
  /** Repo slug, e.g. "ai-research/ai-agents-architect". */
  slug: string;
  name: string;
  category: string;
}

export interface CatalogIndex {
  fetchedAt: number;
  agents: CatalogEntry[];
  skills: CatalogEntry[];
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Catalog index (browse/search cache)
// ---------------------------------------------------------------------------

function parseTreePaths(paths: string[]): Omit<CatalogIndex, 'fetchedAt'> {
  const agents: CatalogEntry[] = [];
  const skills: CatalogEntry[] = [];
  for (const p of paths) {
    const agentMatch = /^cli-tool\/components\/agents\/(.+)\.md$/.exec(p);
    if (agentMatch) {
      const slug = agentMatch[1];
      const parts = slug.split('/');
      agents.push({
        kind: 'agent',
        slug,
        name: parts[parts.length - 1],
        category: parts.length > 1 ? parts[0] : 'general',
      });
      continue;
    }
    const skillMatch = /^cli-tool\/components\/skills\/(.+)\/SKILL\.md$/.exec(p);
    if (skillMatch) {
      const slug = skillMatch[1];
      const parts = slug.split('/');
      skills.push({
        kind: 'skill',
        slug,
        name: parts[parts.length - 1],
        category: parts.length > 1 ? parts[0] : 'general',
      });
    }
  }
  return { agents, skills };
}

function readCache(): CatalogIndex | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(raw?.agents) && Array.isArray(raw?.skills)) {
      return raw as CatalogIndex;
    }
  } catch {
    // Missing/corrupt cache.
  }
  return null;
}

function writeCache(index: CatalogIndex): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(index));
  } catch (err) {
    console.warn('[catalog] failed to write cache:', err);
  }
}

/** The browsable catalog index (cached 24h; refresh forces a re-fetch). */
export async function getCatalogIndex(refresh = false): Promise<{
  ok: boolean;
  index?: CatalogIndex;
  error?: string;
}> {
  const cached = readCache();
  if (!refresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ok: true, index: cached };
  }
  try {
    const res = await fetchWithTimeout(
      `${API_BASE}/git/trees/main?recursive=1`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { tree?: Array<{ path?: string }> };
    const paths = (body.tree ?? [])
      .map((t) => t.path)
      .filter((p): p is string => typeof p === 'string');
    const index: CatalogIndex = { fetchedAt: Date.now(), ...parseTreePaths(paths) };
    writeCache(index);
    return { ok: true, index };
  } catch (err) {
    // Offline / rate limited — serve the stale cache when we have one.
    if (cached) return { ok: true, index: cached };
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `catálogo indisponível: ${detail}` };
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** Slugs come from the catalog: path segments only, no traversal. */
function isSafeSlug(slug: string): boolean {
  return /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(slug) && !slug.includes('..');
}

export interface InstallResult {
  ok: boolean;
  skipped?: boolean;
  installed?: { name: string; path: string };
  error?: string;
}

async function installAgent(slug: string): Promise<InstallResult> {
  const home = os.homedir();
  const slugBase = path.basename(slug);
  const destName = slugBase.endsWith('.md') ? slugBase : `${slugBase}.md`;
  const targetPath = path.join(home, '.claude', 'agents', destName);
  if (fs.existsSync(targetPath)) return { ok: true, skipped: true };

  const resp = await fetchWithTimeout(
    `${RAW_BASE}/cli-tool/components/agents/${slug}.md`,
  );
  if (!resp.ok) {
    return { ok: false, error: `fetch failed: ${resp.status} ${resp.statusText}` };
  }
  await fs.promises.mkdir(path.join(home, '.claude', 'agents'), {
    recursive: true,
  });
  await fs.promises.writeFile(targetPath, await resp.text(), 'utf8');
  return { ok: true, installed: { name: destName, path: targetPath } };
}

interface ContentsEntry {
  type: string;
  name: string;
  path: string;
  download_url: string | null;
}

async function installSkill(slug: string): Promise<InstallResult> {
  const home = os.homedir();
  const slugBase = path.basename(slug);
  const targetDir = path.join(home, '.claude', 'skills', slugBase);
  if (fs.existsSync(targetDir)) return { ok: true, skipped: true };

  const queue = [
    {
      apiUrl: `${API_BASE}/contents/cli-tool/components/skills/${slug}`,
      localDir: targetDir,
    },
  ];
  let written = 0;
  while (queue.length > 0) {
    const { apiUrl, localDir } = queue.shift()!;
    const res = await fetchWithTimeout(apiUrl);
    if (!res.ok) {
      return { ok: false, error: `fetch failed: ${res.status} ${res.statusText}` };
    }
    const entries = (await res.json()) as ContentsEntry[];
    if (!Array.isArray(entries)) {
      return { ok: false, error: 'unexpected contents response' };
    }
    await fs.promises.mkdir(localDir, { recursive: true });
    for (const entry of entries) {
      // Names come from the GitHub API but are written locally — keep them
      // strictly inside the target dir.
      if (!entry.name || entry.name.includes('/') || entry.name.includes('..')) {
        continue;
      }
      if (entry.type === 'dir') {
        queue.push({
          apiUrl: `${API_BASE}/contents/${entry.path}`,
          localDir: path.join(localDir, entry.name),
        });
      } else if (entry.type === 'file' && entry.download_url) {
        if (++written > MAX_SKILL_FILES) {
          return { ok: false, error: 'skill too large (file cap exceeded)' };
        }
        const fileRes = await fetchWithTimeout(entry.download_url);
        if (!fileRes.ok) {
          return { ok: false, error: `fetch failed: ${fileRes.status}` };
        }
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        await fs.promises.writeFile(path.join(localDir, entry.name), buffer);
      }
    }
  }
  return { ok: true, installed: { name: slugBase, path: targetDir } };
}

/**
 * Install an agent (.md → ~/.claude/agents/) or a skill (dir →
 * ~/.claude/skills/) from the aitmpl catalog. Skips silently when the target
 * already exists.
 */
export async function installCatalogItem(input: {
  kind: CatalogKind;
  slug: string;
}): Promise<InstallResult> {
  if (!isSafeSlug(input.slug)) return { ok: false, error: 'invalid slug' };
  try {
    return input.kind === 'agent'
      ? await installAgent(input.slug)
      : await installSkill(input.slug);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: detail };
  }
}

// ---------------------------------------------------------------------------
// Installed listings (settings drawer AGENTS/SKILLS/PLUGINS/HOOKS)
// ---------------------------------------------------------------------------

/** One locally installed catalog component (or user plugin file). */
export interface InstalledItem {
  kind: string;
  name: string;
  file: string;
  size: number;
  modifiedAt: number;
}

function scanDir(
  dir: string,
  kind: string,
  opts: { dirs?: boolean; ext?: string } = {},
): InstalledItem[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => {
        if (entry.name.startsWith('.')) return false;
        if (opts.dirs) return entry.isDirectory();
        if (opts.ext) return entry.isFile() && entry.name.endsWith(opts.ext);
        return entry.isFile();
      })
      .map((entry) => {
        const file = path.join(dir, entry.name);
        const stat = fs.statSync(file);
        return {
          kind,
          name: entry.isDirectory()
            ? entry.name
            : path.basename(entry.name, path.extname(entry.name)),
          file,
          size: entry.isDirectory() ? 0 : stat.size,
          modifiedAt: stat.mtimeMs,
        };
      });
  } catch {
    return []; // Directory absent — nothing installed.
  }
}

function uniqueInstalledItems(items: InstalledItem[]): InstalledItem[] {
  const seen = new Set<string>();
  const out: InstalledItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Installed catalog components. Components install into the CLI's real
 * namespace (~/.claude) — that's what we scan; the legacy
 * ~/.nexus/plugins/catalog dir is included for anything installed by older
 * builds.
 */
export function listInstalledCatalogItems(): InstalledItem[] {
  const home = os.homedir();
  const legacyRoot = path.join(home, '.nexus', 'plugins', 'catalog');
  const legacy = (() => {
    try {
      return fs
        .readdirSync(legacyRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => scanDir(path.join(legacyRoot, entry.name), entry.name));
    } catch {
      return [];
    }
  })();
  return uniqueInstalledItems([
    ...scanDir(path.join(home, '.claude', 'agents'), 'agent', { ext: '.md' }),
    ...scanDir(path.join(home, '.claude', 'skills'), 'skill', { dirs: true }),
    ...scanDir(path.join(home, '.agents', 'skills'), 'skill', { dirs: true }),
    ...scanDir(path.join(home, '.codex', 'skills'), 'skill', { dirs: true }),
    ...scanDir(path.join(home, '.gemini', 'config', 'skills'), 'skill', {
      dirs: true,
    }),
    ...scanDir(path.join(home, '.gemini', 'antigravity', 'skills'), 'skill', {
      dirs: true,
    }),
    ...scanDir(path.join(home, '.kimi-code', 'skills'), 'skill', { dirs: true }),
    ...scanDir(path.join(home, '.grok', 'skills'), 'skill', { dirs: true }),
    ...legacy,
  ]);
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
  return scanDir(path.join(os.homedir(), '.nexus', 'ephemeral'), 'hook-home', {
    dirs: true,
  });
}
