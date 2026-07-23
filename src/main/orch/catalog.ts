import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { scanComponentFiles, type ScanInput } from './skill-threat-scan';
import type {
  CatalogEntry,
  CatalogIndex,
  CatalogInstallOptions,
  CatalogInstallReview,
  CatalogKind,
  CatalogPreparedInstall,
  CatalogProvenance,
  InstallResult,
} from './catalog-contract';
export type {
  CatalogEntry,
  CatalogIndex,
  CatalogInstallOptions,
  CatalogInstallReview,
  CatalogKind,
  CatalogPreparedInstall,
  CatalogProvenance,
  InstalledItem,
  InstallResult,
} from './catalog-contract';
export {
  listHookHomes,
  listInstalledCatalogItems,
  listPluginFiles,
} from './catalog-installed';

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
const MAX_INSTALL_WALL_CLOCK_MS = 120_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SKILL_FILES = 200;
const MAX_SKILL_ENTRIES = 500;
const MAX_CONTENTS_REQUESTS = 256;
const MAX_SKILL_DEPTH = 20;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_COMMIT_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENTS_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TREE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const activeCatalogInstalls = new Set<string>();
let catalogIndexFlight: Promise<{
  ok: boolean;
  index?: CatalogIndex;
  error?: string;
}> | null = null;

function cacheFile(): string {
  return path.join(os.homedir(), '.nexus', 'catalog-cache.json');
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

function assertCatalogOperationLive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('catalog operation deadline exceeded');
  }
}

async function fetchResponseLimited(
  rawUrl: string,
  host: CatalogHost,
  maxBytes: number,
  operationSignal?: AbortSignal,
): Promise<{ response: Response; body: Buffer }> {
  assertCatalogOperationLive(operationSignal);
  const url = validatedCatalogUrl(rawUrl, host).href;
  const controller = new AbortController();
  const abortForOperation = (): void => {
    controller.abort(new Error('catalog operation deadline exceeded'));
  };
  operationSignal?.addEventListener('abort', abortForOperation, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('catalog request deadline exceeded')),
    FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'error',
    });
    assertCatalogOperationLive(operationSignal);
    if (response.redirected || !response.url || !sameUrl(response.url, url)) {
      throw new Error('unexpected catalog response URL');
    }
    // Keep the AbortController alive through body consumption. A peer that
    // sends headers and then stalls must not hold an install forever.
    const body = await readResponseLimited(response, maxBytes);
    assertCatalogOperationLive(operationSignal);
    return { response, body };
  } catch (error) {
    assertCatalogOperationLive(operationSignal);
    throw error;
  } finally {
    operationSignal?.removeEventListener('abort', abortForOperation);
    controller.abort();
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
  operationSignal?: AbortSignal,
): Promise<{ value: T; raw: Buffer }> {
  const { response, body: raw } = await fetchResponseLimited(
    url,
    'api.github.com',
    maxBytes,
    operationSignal,
  );
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  }
  try {
    return { value: JSON.parse(raw.toString('utf8')) as T, raw };
  } catch {
    throw new Error('unexpected catalog JSON response');
  }
}

async function resolveCommitSha(operationSignal?: AbortSignal): Promise<string> {
  const url = `${API_BASE}/commits/main`;
  const { value } = await fetchJson<{ sha?: unknown }>(
    url,
    MAX_COMMIT_RESPONSE_BYTES,
    operationSignal,
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

/** Unlike existsSync, this treats dangling symlinks as occupied targets. */
function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
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
  if (catalogIndexFlight) return catalogIndexFlight;
  const flight = (async () => {
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
  })();
  catalogIndexFlight = flight;
  try {
    return await flight;
  } finally {
    if (catalogIndexFlight === flight) catalogIndexFlight = null;
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

interface CatalogInstallExecutionOptions extends CatalogInstallOptions {
  readonly operationSignal: AbortSignal;
}

function assertInstallLive(options: CatalogInstallExecutionOptions): void {
  assertCatalogOperationLive(options.operationSignal);
  options.assertCurrentAuthority?.();
}

async function awaitInstallOperation<T>(
  pending: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  assertCatalogOperationLive(signal);
  // Native confirmation dialogs cannot be programmatically dismissed. When
  // the automated deadline expires, keep the install lane occupied until the
  // physical modal settles, then reject its now-stale answer. Releasing the
  // lane on abort would allow a second overlapping dialog whose late click
  // misleadingly appears to authorize a different install.
  const value = await pending;
  assertCatalogOperationLive(signal);
  return value;
}

function catalogTarget(kind: CatalogKind, slug: string): {
  name: string;
  targetPath: string;
} {
  const slugBase = path.basename(slug);
  if (kind === 'agent') {
    const name = slugBase.endsWith('.md') ? slugBase : `${slugBase}.md`;
    return {
      name,
      targetPath: path.join(os.homedir(), '.claude', 'agents', name),
    };
  }
  return {
    name: slugBase,
    targetPath: path.join(os.homedir(), '.claude', 'skills', slugBase),
  };
}

/** Read-only source candidate. It never refreshes/fetches or writes: the
 * renderer must first browse a main-validated cached catalog snapshot. */
export function reviewCatalogInstall(input: {
  kind: CatalogKind;
  slug: string;
}): { ok: true; candidate: CatalogInstallReview } | { ok: false; error: string } {
  if (!isSafeSlug(input.slug)) return { ok: false, error: 'invalid slug' };
  const cached = readCache();
  if (!cached?.provenance?.commitSha) {
    return {
      ok: false,
      error: 'catálogo sem snapshot local; atualize a lista antes de instalar',
    };
  }
  const entries = input.kind === 'agent' ? cached.agents : cached.skills;
  const entry = entries.find(
    (candidate) =>
      candidate.kind === input.kind && candidate.slug === input.slug,
  );
  if (!entry) {
    return { ok: false, error: 'item ausente do snapshot de catálogo revisado' };
  }
  const target = catalogTarget(input.kind, input.slug);
  return {
    ok: true,
    candidate: Object.freeze({
      kind: input.kind,
      slug: input.slug,
      name: target.name,
      repository: REPO,
      commitSha: cached.provenance.commitSha,
      targetPath: target.targetPath,
      alreadyInstalled: pathEntryExists(target.targetPath),
    }),
  };
}

function selectedCommit(
  options: CatalogInstallExecutionOptions,
): Promise<string> {
  assertInstallLive(options);
  if (options.expectedCommitSha !== undefined) {
    if (!COMMIT_SHA_PATTERN.test(options.expectedCommitSha)) {
      return Promise.reject(new Error('invalid expected catalog commit'));
    }
    return Promise.resolve(options.expectedCommitSha);
  }
  return resolveCommitSha(options.operationSignal);
}

async function approvePreparedInstall(
  candidate: CatalogPreparedInstall,
  options: CatalogInstallExecutionOptions,
): Promise<boolean> {
  assertInstallLive(options);
  const pending = options.beforePublish?.(candidate);
  const approved =
    pending && typeof (pending as PromiseLike<boolean>).then === 'function'
      ? await awaitInstallOperation(
          pending as PromiseLike<boolean>,
          options.operationSignal,
        )
      : pending;
  assertInstallLive(options);
  return approved !== false;
}

async function installAgent(
  slug: string,
  options: CatalogInstallExecutionOptions,
): Promise<InstallResult> {
  assertInstallLive(options);
  const { name: destName, targetPath } = catalogTarget('agent', slug);
  if (pathEntryExists(targetPath)) return { ok: true, skipped: true };

  const commitSha = await selectedCommit(options);
  assertInstallLive(options);
  const repoPath = `cli-tool/components/agents/${slug}.md`;
  const url = rawFileUrl(repoPath, commitSha);
  const { response, body: payload } = await fetchResponseLimited(
    url,
    'raw.githubusercontent.com',
    MAX_FILE_BYTES,
    options.operationSignal,
  );
  assertInstallLive(options);
  if (!response.ok) {
    return {
      ok: false,
      error: `fetch failed: ${response.status} ${response.statusText}`,
    };
  }

  // H1 content-trust gate: refuse to publish unambiguously malicious content
  // (credential exfiltration, reverse shell, pipe-to-shell). Automatic and
  // fail-closed — no prompt, no effect on agent autonomy.
  const scan = scanComponentFiles([{ name: destName, buffer: payload }]);
  assertInstallLive(options);
  if (scan.blocked) {
    return {
      ok: false,
      error: `componente bloqueado por segurança (conteúdo potencialmente malicioso): ${scan.blockReason}`,
    };
  }

  const parent = path.dirname(targetPath);
  assertInstallLive(options);
  await fs.promises.mkdir(parent, {
    recursive: true,
    mode: 0o700,
  });
  assertInstallLive(options);
  const stagingDir = await fs.promises.mkdtemp(
    path.join(parent, `.${destName}.staging-`),
  );
  try {
    assertInstallLive(options);
    const stagedFile = path.join(stagingDir, 'payload');
    await fs.promises.writeFile(stagedFile, payload, {
      flag: 'wx',
      mode: 0o600,
    });
    assertInstallLive(options);
    const provenance: CatalogProvenance = {
      repository: REPO,
      commitSha,
      sha256: sha256(payload),
      fileCount: 1,
      totalBytes: payload.byteLength,
      ...(scan.warnings.length > 0 ? { warnings: scan.warnings } : {}),
    };
    const approved = await approvePreparedInstall(
      Object.freeze({
        kind: 'agent',
        slug,
        name: destName,
        repository: REPO,
        commitSha,
        targetPath,
        alreadyInstalled: false,
        sha256: provenance.sha256!,
        fileCount: 1,
        totalBytes: payload.byteLength,
        warnings: Object.freeze([...(scan.warnings ?? [])]),
      }),
      options,
    );
    if (!approved) return { ok: false, error: 'user_denied' };
    const stagedStat = await fs.promises.lstat(stagedFile);
    const stagedPayload = await fs.promises.readFile(stagedFile);
    if (
      !stagedStat.isFile() ||
      stagedStat.isSymbolicLink() ||
      stagedPayload.byteLength !== payload.byteLength ||
      sha256(stagedPayload) !== provenance.sha256
    ) {
      throw new Error('staged catalog payload changed after review');
    }
    assertInstallLive(options);
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
      provenance,
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

async function verifyStagedSkill(
  stagingDir: string,
  rootRepoPath: string,
  expectedFiles: readonly {
    repoPath: string;
    digest: string;
    bytes: number;
  }[],
): Promise<void> {
  const actual = new Map<string, { digest: string; bytes: number }>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, {
      withFileTypes: true,
    })) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error('staged catalog skill contains a symlink');
      }
      if (stat.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error('staged catalog skill contains a non-regular entry');
      }
      const relative = path
        .relative(stagingDir, absolute)
        .split(path.sep)
        .join('/');
      if (
        !relative ||
        relative.startsWith('../') ||
        path.isAbsolute(relative)
      ) {
        throw new Error('staged catalog skill escaped its root');
      }
      const body = await fs.promises.readFile(absolute);
      actual.set(`${rootRepoPath}/${relative}`, {
        digest: sha256(body),
        bytes: body.byteLength,
      });
    }
  };
  await visit(stagingDir);
  if (actual.size !== expectedFiles.length) {
    throw new Error('staged catalog skill file set changed after review');
  }
  for (const expected of expectedFiles) {
    const observed = actual.get(expected.repoPath);
    if (
      !observed ||
      observed.digest !== expected.digest ||
      observed.bytes !== expected.bytes
    ) {
      throw new Error('staged catalog skill payload changed after review');
    }
  }
}

async function installSkill(
  slug: string,
  options: CatalogInstallExecutionOptions,
): Promise<InstallResult> {
  assertInstallLive(options);
  const { name: slugBase, targetPath: targetDir } = catalogTarget('skill', slug);
  if (pathEntryExists(targetDir)) return { ok: true, skipped: true };

  const commitSha = await selectedCommit(options);
  assertInstallLive(options);
  const parent = path.dirname(targetDir);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  assertInstallLive(options);
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
  const scanInputs: ScanInput[] = [];
  let entryCount = 0;
  let contentsRequests = 0;
  let totalBytes = 0;

  try {
    while (queue.length > 0) {
      assertInstallLive(options);
      const { repoPath, localDir, depth } = queue.shift()!;
      if (depth > MAX_SKILL_DEPTH) {
        throw new Error('skill too deep (depth cap exceeded)');
      }
      contentsRequests += 1;
      if (contentsRequests > MAX_CONTENTS_REQUESTS) {
        throw new Error('skill too large (contents request cap exceeded)');
      }
      const apiUrl = contentsUrl(repoPath, commitSha);
      const { value: entries } = await fetchJson<ContentsEntry[]>(
        apiUrl,
        MAX_CONTENTS_RESPONSE_BYTES,
        options.operationSignal,
      );
      assertInstallLive(options);
      if (!Array.isArray(entries)) {
        throw new Error('unexpected contents response');
      }
      await fs.promises.mkdir(localDir, { recursive: true, mode: 0o700 });
      assertInstallLive(options);
      for (const entry of entries) {
        assertInstallLive(options);
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
        const { response: fileResponse, body: buffer } = await fetchResponseLimited(
          expectedUrl,
          'raw.githubusercontent.com',
          Math.min(MAX_FILE_BYTES, remainingBytes),
          options.operationSignal,
        );
        assertInstallLive(options);
        if (!fileResponse.ok) {
          throw new Error(`fetch failed: ${fileResponse.status}`);
        }
        totalBytes += buffer.byteLength;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new Error('skill too large (total byte limit exceeded)');
        }
        files.push({
          repoPath: entryPath,
          digest: sha256(buffer),
          bytes: buffer.byteLength,
        });
        scanInputs.push({ name: entryPath, buffer });
        await fs.promises.writeFile(path.join(localDir, entryName), buffer, {
          flag: 'wx',
          mode: 0o600,
        });
        assertInstallLive(options);
      }
    }

    // H1 content-trust gate: scan all downloaded files before publishing. A
    // blocking finding aborts the install (staging is cleaned in `finally`).
    const scan = scanComponentFiles(scanInputs);
    assertInstallLive(options);
    if (scan.blocked) {
      return {
        ok: false,
        error: `componente bloqueado por segurança (conteúdo potencialmente malicioso): ${scan.blockReason}`,
      };
    }

    const digest = aggregateSkillDigest(files);
    const provenance: CatalogProvenance = {
      repository: REPO,
      commitSha,
      sha256: digest,
      fileCount: files.length,
      totalBytes,
      ...(scan.warnings.length > 0 ? { warnings: scan.warnings } : {}),
    };
    const approved = await approvePreparedInstall(
      Object.freeze({
        kind: 'skill',
        slug,
        name: slugBase,
        repository: REPO,
        commitSha,
        targetPath: targetDir,
        alreadyInstalled: false,
        sha256: digest,
        fileCount: files.length,
        totalBytes,
        warnings: Object.freeze([...(scan.warnings ?? [])]),
      }),
      options,
    );
    if (!approved) return { ok: false, error: 'user_denied' };
    await verifyStagedSkill(stagingDir, rootRepoPath, files);
    assertInstallLive(options);
    if (pathEntryExists(targetDir)) return { ok: true, skipped: true };
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
      provenance,
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
}, options: CatalogInstallOptions = {}): Promise<InstallResult> {
  if (!isSafeSlug(input.slug)) return { ok: false, error: 'invalid slug' };
  const target = catalogTarget(input.kind, input.slug).targetPath;
  if (pathEntryExists(target)) return { ok: true, skipped: true };
  if (activeCatalogInstalls.size >= 1 || activeCatalogInstalls.has(target)) {
    return { ok: false, error: 'catalog_install_busy' };
  }
  const requestedTimeout =
    options.operationTimeoutMs ?? MAX_INSTALL_WALL_CLOCK_MS;
  if (
    !Number.isSafeInteger(requestedTimeout) ||
    requestedTimeout <= 0
  ) {
    return { ok: false, error: 'invalid catalog operation deadline' };
  }
  const operationController = new AbortController();
  const operationTimer = setTimeout(
    () =>
      operationController.abort(
        new Error('catalog operation deadline exceeded'),
      ),
    Math.min(requestedTimeout, MAX_INSTALL_WALL_CLOCK_MS),
  );
  operationTimer.unref?.();
  const executionOptions: CatalogInstallExecutionOptions = {
    ...options,
    operationSignal: operationController.signal,
  };
  activeCatalogInstalls.add(target);
  try {
    return input.kind === 'agent'
      ? await installAgent(input.slug, executionOptions)
      : await installSkill(input.slug, executionOptions);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: detail };
  } finally {
    clearTimeout(operationTimer);
    operationController.abort();
    activeCatalogInstalls.delete(target);
  }
}
