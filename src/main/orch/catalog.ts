import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * aitmpl catalog (davila7/claude-code-templates) — the catalog install
 * mechanism:
 *
 *  - resolve the upstream default branch to an immutable commit SHA
 *  - agents: GET raw.githubusercontent.com/.../<sha>/.../<slug>.md
 *  - skills: BFS over the GitHub Contents API with ?ref=<sha>
 *  - downloads are bounded and staged privately, then published atomically
 *  - both skip silently when the target already exists
 *
 * Browsing/search uses a single git-tree fetch cached on disk (the "skills
 * cache"/"agents cache").
 */

const REPO = 'davila7/claude-code-templates';
const API_BASE = `https://api.github.com/repos/${REPO}`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}`;
const USER_AGENT = 'nexus-ide';
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SKILL_FILES = 200;
const MAX_SKILL_ENTRIES = 500;
const MAX_SKILL_DEPTH = 20;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_COMMIT_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENTS_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TREE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function cacheFile(): string {
  return path.join(os.homedir(), '.nexus', 'catalog-cache.json');
}

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
  /** Immutable source used to build this snapshot. */
  provenance?: CatalogProvenance;
}

export interface CatalogProvenance {
  repository: string;
  commitSha: string;
  /** SHA-256 of the index response or installed payload set. */
  sha256?: string;
  fileCount?: number;
  totalBytes?: number;
}

type CatalogHost = 'api.github.com' | 'raw.githubusercontent.com';

function validatedCatalogUrl(raw: string, host: CatalogHost): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('unexpected catalog URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== host ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new Error('unexpected catalog URL');
  }
  return url;
}

function sameUrl(actual: string, expected: string): boolean {
  try {
    return new URL(actual).href === new URL(expected).href;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(
  rawUrl: string,
  host: CatalogHost,
): Promise<Response> {
  const url = validatedCatalogUrl(rawUrl, host).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'error',
    });
    if (response.redirected || !response.url || !sameUrl(response.url, url)) {
      throw new Error('unexpected catalog response URL');
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseLimited(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new Error('invalid catalog content length');
    }
    if (Number(declaredLength) > maxBytes) {
      throw new Error('catalog response too large (byte limit exceeded)');
    }
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error('catalog response too large (byte limit exceeded)');
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error('catalog response too large (byte limit exceeded)');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

async function fetchJson<T>(
  url: string,
  maxBytes: number,
): Promise<{ value: T; raw: Buffer }> {
  const response = await fetchWithTimeout(url, 'api.github.com');
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  }
  const raw = await readResponseLimited(response, maxBytes);
  try {
    return { value: JSON.parse(raw.toString('utf8')) as T, raw };
  } catch {
    throw new Error('unexpected catalog JSON response');
  }
}

async function resolveCommitSha(): Promise<string> {
  const url = `${API_BASE}/commits/main`;
  const { value } = await fetchJson<{ sha?: unknown }>(
    url,
    MAX_COMMIT_RESPONSE_BYTES,
  );
  if (typeof value?.sha !== 'string' || !COMMIT_SHA_PATTERN.test(value.sha)) {
    throw new Error('catalog returned an invalid commit SHA');
  }
  return value.sha;
}

function encodedRepoPath(repoPath: string): string {
  return repoPath.split('/').map(encodeURIComponent).join('/');
}

function contentsUrl(repoPath: string, commitSha: string): string {
  const url = new URL(`${API_BASE}/contents/${encodedRepoPath(repoPath)}`);
  url.searchParams.set('ref', commitSha);
  return url.href;
}

function rawFileUrl(repoPath: string, commitSha: string): string {
  return `${RAW_BASE}/${commitSha}/${encodedRepoPath(repoPath)}`;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
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
    const skillMatch = /^cli-tool\/components\/skills\/(.+)\/SKILL\.md$/.exec(
      p,
    );
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
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (
      typeof raw?.fetchedAt === 'number' &&
      Array.isArray(raw?.agents) &&
      Array.isArray(raw?.skills) &&
      raw?.provenance?.repository === REPO &&
      typeof raw?.provenance?.commitSha === 'string' &&
      COMMIT_SHA_PATTERN.test(raw.provenance.commitSha)
    ) {
      return raw as CatalogIndex;
    }
  } catch {
    // Missing/corrupt cache.
  }
  return null;
}

function writeCache(index: CatalogIndex): void {
  const target = cacheFile();
  const parent = path.dirname(target);
  const temp = path.join(
    parent,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(index), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, target);
  } catch (err) {
    console.warn('[catalog] failed to write cache:', err);
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best effort cleanup; the cache itself is never partially replaced.
    }
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
    const commitSha = await resolveCommitSha();
    const treeUrl = `${API_BASE}/git/trees/${commitSha}?recursive=1`;
    const { value: body, raw } = await fetchJson<{
      truncated?: unknown;
      tree?: Array<{ path?: string }>;
    }>(treeUrl, MAX_TREE_RESPONSE_BYTES);
    if (body.truncated !== false) {
      throw new Error('catalog tree response is incomplete');
    }
    if (!Array.isArray(body.tree) || body.tree.length > MAX_TREE_ENTRIES) {
      throw new Error('catalog tree entry limit exceeded');
    }
    const paths = (body.tree ?? [])
      .map((t) => t.path)
      .filter((p): p is string => typeof p === 'string');
    const index: CatalogIndex = {
      fetchedAt: Date.now(),
      ...parseTreePaths(paths),
      provenance: {
        repository: REPO,
        commitSha,
        sha256: sha256(raw),
        fileCount: paths.length,
        totalBytes: raw.byteLength,
      },
    };
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
  const segments = slug.split('/');
  return (
    slug.length <= 512 &&
    segments.length <= MAX_SKILL_DEPTH &&
    segments.every(
      (segment) =>
        /^[a-zA-Z0-9._-]+$/.test(segment) &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('..'),
    )
  );
}

export interface InstallResult {
  ok: boolean;
  skipped?: boolean;
  installed?: { name: string; path: string };
  provenance?: CatalogProvenance;
  error?: string;
}

async function installAgent(slug: string): Promise<InstallResult> {
  const home = os.homedir();
  const slugBase = path.basename(slug);
  const destName = slugBase.endsWith('.md') ? slugBase : `${slugBase}.md`;
  const targetPath = path.join(home, '.claude', 'agents', destName);
  if (fs.existsSync(targetPath)) return { ok: true, skipped: true };

  const commitSha = await resolveCommitSha();
  const repoPath = `cli-tool/components/agents/${slug}.md`;
  const url = rawFileUrl(repoPath, commitSha);
  const response = await fetchWithTimeout(url, 'raw.githubusercontent.com');
  if (!response.ok) {
    return {
      ok: false,
      error: `fetch failed: ${response.status} ${response.statusText}`,
    };
  }
  const payload = await readResponseLimited(response, MAX_FILE_BYTES);
  const parent = path.dirname(targetPath);
  await fs.promises.mkdir(parent, {
    recursive: true,
    mode: 0o700,
  });
  const stagingDir = await fs.promises.mkdtemp(
    path.join(parent, `.${destName}.staging-`),
  );
  try {
    const stagedFile = path.join(stagingDir, 'payload');
    await fs.promises.writeFile(stagedFile, payload, {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      // A hard link publishes the complete same-filesystem payload atomically
      // and, unlike rename(), never overwrites a target created concurrently.
      await fs.promises.link(stagedFile, targetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: true, skipped: true };
      }
      throw err;
    }
    return {
      ok: true,
      installed: { name: destName, path: targetPath },
      provenance: {
        repository: REPO,
        commitSha,
        sha256: sha256(payload),
        fileCount: 1,
        totalBytes: payload.byteLength,
      },
    };
  } finally {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
  }
}

interface ContentsEntry {
  type?: unknown;
  name?: unknown;
  path?: unknown;
  download_url?: unknown;
}

function isSafeEntryName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

function aggregateSkillDigest(
  files: Array<{ repoPath: string; digest: string; bytes: number }>,
): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) =>
    a.repoPath.localeCompare(b.repoPath),
  )) {
    hash.update(file.repoPath);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(file.digest);
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function installSkill(slug: string): Promise<InstallResult> {
  const home = os.homedir();
  const slugBase = path.basename(slug);
  const targetDir = path.join(home, '.claude', 'skills', slugBase);
  if (fs.existsSync(targetDir)) return { ok: true, skipped: true };

  const commitSha = await resolveCommitSha();
  const parent = path.dirname(targetDir);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  const stagingDir = await fs.promises.mkdtemp(
    path.join(parent, `.${slugBase}.staging-`),
  );
  const rootRepoPath = `cli-tool/components/skills/${slug}`;
  const queue = [
    {
      repoPath: rootRepoPath,
      localDir: stagingDir,
      depth: 0,
    },
  ];
  const seenEntries = new Set<string>();
  const files: Array<{ repoPath: string; digest: string; bytes: number }> = [];
  let entryCount = 0;
  let totalBytes = 0;

  try {
    while (queue.length > 0) {
      const { repoPath, localDir, depth } = queue.shift()!;
      if (depth > MAX_SKILL_DEPTH) {
        throw new Error('skill too deep (depth cap exceeded)');
      }
      const apiUrl = contentsUrl(repoPath, commitSha);
      const { value: entries } = await fetchJson<ContentsEntry[]>(
        apiUrl,
        MAX_CONTENTS_RESPONSE_BYTES,
      );
      if (!Array.isArray(entries)) {
        throw new Error('unexpected contents response');
      }
      await fs.promises.mkdir(localDir, { recursive: true, mode: 0o700 });
      for (const entry of entries) {
        entryCount += 1;
        if (entryCount > MAX_SKILL_ENTRIES) {
          throw new Error('skill too large (entry cap exceeded)');
        }
        if (
          !entry ||
          !isSafeEntryName(entry.name) ||
          typeof entry.path !== 'string' ||
          entry.path !== `${repoPath}/${entry.name}` ||
          !entry.path.startsWith(`${rootRepoPath}/`) ||
          seenEntries.has(entry.path)
        ) {
          throw new Error('unexpected catalog entry path');
        }
        const entryName = entry.name;
        const entryPath = entry.path;
        seenEntries.add(entryPath);

        if (entry.type === 'dir') {
          queue.push({
            repoPath: entryPath,
            localDir: path.join(localDir, entryName),
            depth: depth + 1,
          });
          continue;
        }
        if (entry.type !== 'file' || typeof entry.download_url !== 'string') {
          throw new Error('unexpected catalog entry type');
        }
        if (files.length + 1 > MAX_SKILL_FILES) {
          throw new Error('skill too large (file cap exceeded)');
        }

        const expectedUrl = rawFileUrl(entryPath, commitSha);
        validatedCatalogUrl(entry.download_url, 'raw.githubusercontent.com');
        if (!sameUrl(entry.download_url, expectedUrl)) {
          throw new Error('unexpected catalog download URL');
        }
        const remainingBytes = MAX_TOTAL_BYTES - totalBytes;
        if (remainingBytes <= 0) {
          throw new Error('skill too large (total byte limit exceeded)');
        }
        const fileResponse = await fetchWithTimeout(
          expectedUrl,
          'raw.githubusercontent.com',
        );
        if (!fileResponse.ok) {
          throw new Error(`fetch failed: ${fileResponse.status}`);
        }
        const buffer = await readResponseLimited(
          fileResponse,
          Math.min(MAX_FILE_BYTES, remainingBytes),
        );
        totalBytes += buffer.byteLength;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new Error('skill too large (total byte limit exceeded)');
        }
        files.push({
          repoPath: entryPath,
          digest: sha256(buffer),
          bytes: buffer.byteLength,
        });
        await fs.promises.writeFile(path.join(localDir, entryName), buffer, {
          flag: 'wx',
          mode: 0o600,
        });
      }
    }

    if (fs.existsSync(targetDir)) return { ok: true, skipped: true };
    try {
      await fs.promises.rename(stagingDir, targetDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        return { ok: true, skipped: true };
      }
      throw err;
    }
    return {
      ok: true,
      installed: { name: slugBase, path: targetDir },
      provenance: {
        repository: REPO,
        commitSha,
        sha256: aggregateSkillDigest(files),
        fileCount: files.length,
        totalBytes,
      },
    };
  } finally {
    // If rename succeeded this path no longer exists. On every failure, all
    // downloaded files remain invisible in staging and are removed here.
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
  }
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
