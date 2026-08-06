import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveSubdirUnderRoot } from '../security/scoped-workspace-fs';
import { writeFileAtomic } from '../util/atomic-write';

/**
 * Human-readable projection of the canonical SQLite/FTS5 memory.
 *
 * Files under `.nexus-memory/` are deliberately generated views, never an
 * ingestion source. A sync rewrites local edits from SQLite and only removes
 * stale files carrying our canonical marker; unrelated human Markdown is
 * preserved but ignored by the memory APIs.
 */

export const DEFAULT_MEMORY_DIR = '.nexus-memory';
export const CANONICAL_MEMORY_PROJECTION = 'sqlite-fts5';

const canonicalProjectionInputSchema = z
  .object({
    id: z.string().regex(/^mem-[A-Za-z0-9._:-]{1,123}$/),
    content: z.string().min(1).max(64_000),
    kind: z.enum(['fact', 'decision', 'preference', 'note']),
    scope: z.literal('workspace'),
    importance: z.number().int().min(1).max(5),
    source: z.string().max(256).nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type CanonicalMemoryProjectionInput = z.infer<
  typeof canonicalProjectionInputSchema
>;

export const memoryNoteSchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(256),
    kind: z.enum(['decision', 'mission', 'agent', 'note']).default('note'),
    body: z.string().max(64_000),
    wikilinks: z.array(z.string().max(256)).max(128).default([]),
    missionId: z.string().max(128).optional(),
    path: z.string().max(4096),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type MemoryNote = z.infer<typeof memoryNoteSchema>;

const WIKILINK_RE = /\[\[([^\]]{1,256})\]\]/g;

export function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    out.add(m[1].trim());
  }
  return [...out];
}

/**
 * Resolve memory directory under projectRoot via shared scoped-fs adapter.
 */
export function resolveMemoryRoot(
  projectRoot: string,
  dirname = DEFAULT_MEMORY_DIR,
): string {
  try {
    return resolveSubdirUnderRoot(projectRoot, dirname);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      msg.includes('subdirectory')
        ? 'memory root must be a subdirectory of project'
        : msg.includes('escape') || msg.includes('relative')
          ? msg.replace(/^directory/, 'memory dirname')
          : `memory root escaped project: ${msg}`,
    );
  }
}

/**
 * Create the projection root and re-prove containment *after* the mkdir.
 *
 * `resolveMemoryRoot` validates a path, but the write happens later: in that
 * window the directory can be swapped for a symlink, and `mkdirSync` with
 * `recursive: true` succeeds silently on a symlink-to-directory, redirecting
 * every subsequent write out of the project. Re-resolving here closes it.
 */
function ensureProjectionRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(root);
  if (real !== root) {
    throw new Error(`memory root escaped project: ${root}`);
  }
}

function projectionKind(
  input: CanonicalMemoryProjectionInput,
): MemoryNote['kind'] {
  if (input.kind === 'decision') return 'decision';
  if (/(?:^|:)mission:/.test(input.source ?? '')) return 'mission';
  if (/(?:^|:)(?:agent|pane):/.test(input.source ?? '')) return 'agent';
  return 'note';
}

function projectionMissionId(source: string | null): string | undefined {
  if (!source) return undefined;
  const match = /(?:^|:)mission:(.+)$/.exec(source);
  return match?.[1]?.slice(0, 128);
}

function projectionTitle(content: string, id: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine?.replace(/^#{1,6}\s*/, '').trim();
  return (title || `Memory ${id}`).slice(0, 256);
}

function yamlString(value: string | null): string {
  return JSON.stringify(value ?? '');
}

function canonicalProjectionPath(root: string, id: string): string {
  const parsedId = canonicalProjectionInputSchema.shape.id.parse(id);
  return path.join(root, `${parsedId}.md`);
}

function projectionMarkdown(
  input: CanonicalMemoryProjectionInput,
  kind: MemoryNote['kind'],
  missionId: string | undefined,
  title: string,
): string {
  return [
    '---',
    `id: ${input.id}`,
    `canonical: ${CANONICAL_MEMORY_PROJECTION}`,
    'generated: true',
    `kind: ${kind}`,
    `memoryKind: ${input.kind}`,
    `scope: ${input.scope}`,
    `importance: ${input.importance}`,
    `source: ${yamlString(input.source)}`,
    `missionId: ${yamlString(missionId ?? null)}`,
    `createdAt: ${input.createdAt}`,
    `updatedAt: ${input.updatedAt}`,
    '---',
    '',
    '<!-- Generated from Nexus SQLite memory. Local edits are overwritten. -->',
    '',
    `# ${title}`,
    '',
    input.content.replace(/^#{1,6}\s+[^\r\n]+\r?\n+/, ''),
    '',
  ].join('\n');
}

export function writeCanonicalMemoryProjection(
  projectRoot: string,
  rawInput: CanonicalMemoryProjectionInput,
  dirname = DEFAULT_MEMORY_DIR,
): MemoryNote {
  const input = canonicalProjectionInputSchema.parse(rawInput);
  const root = resolveMemoryRoot(projectRoot, dirname);
  ensureProjectionRoot(root);
  const filePath = canonicalProjectionPath(root, input.id);
  const kind = projectionKind(input);
  const missionId = projectionMissionId(input.source);
  const title = projectionTitle(input.content, input.id);
  const markdown = projectionMarkdown(input, kind, missionId, title);
  let isCurrent = false;
  try {
    isCurrent =
      fs.lstatSync(filePath).isFile() &&
      fs.readFileSync(filePath, 'utf8') === markdown;
  } catch {
    // Missing/unreadable/stale projection is repaired by the atomic write.
  }
  if (!isCurrent) writeFileAtomic(filePath, markdown);
  return memoryNoteSchema.parse({
    id: input.id,
    title,
    kind,
    body: input.content,
    wikilinks: extractWikilinks(input.content),
    missionId,
    path: filePath,
    updatedAt: input.updatedAt,
  });
}

const MEMORY_KINDS = new Set(['decision', 'mission', 'agent', 'note']);

function parseFrontmatter(raw: string): {
  kind: MemoryNote['kind'];
  missionId?: string;
  idFromFm?: string;
  canonical?: string;
} {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!fm) return { kind: 'note' };
  const block = fm[1];
  const kindRaw = /^kind:\s*(\S+)/m.exec(block)?.[1]?.trim();
  const kind =
    kindRaw && MEMORY_KINDS.has(kindRaw)
      ? (kindRaw as MemoryNote['kind'])
      : 'note';
  const missionRaw =
    /^missionId:\s*(.+)$/m.exec(block)?.[1]?.trim() || undefined;
  const missionId =
    missionRaw && missionRaw !== '""'
      ? missionRaw.replace(/^"|"$/g, '')
      : undefined;
  const idFromFm = /^id:\s*(\S+)/m.exec(block)?.[1]?.trim();
  const canonical = /^canonical:\s*(\S+)/m.exec(block)?.[1]?.trim();
  return {
    kind,
    missionId: missionId || undefined,
    idFromFm,
    canonical,
  };
}

function isCanonicalProjection(raw: string, expectedId?: string): boolean {
  const frontmatter = parseFrontmatter(raw);
  return (
    frontmatter.canonical === CANONICAL_MEMORY_PROJECTION &&
    (!expectedId || frontmatter.idFromFm === expectedId)
  );
}

/**
 * A projection is only itself when the declared id matches the filename the
 * writer derives from that same id. Without this the frontmatter alone decides
 * identity, so any planted file can claim a live memory's id — impersonating it
 * on read and slipping past the reaper (which only removes *inactive* ids).
 */
function projectionIdForFile(name: string, raw: string): string | null {
  if (!name.endsWith('.md')) return null;
  const fromName = name.slice(0, -'.md'.length);
  const frontmatter = parseFrontmatter(raw);
  if (frontmatter.canonical !== CANONICAL_MEMORY_PROJECTION) return null;
  if (frontmatter.idFromFm !== fromName) return null;
  return fromName;
}

export function removeCanonicalMemoryProjection(
  projectRoot: string,
  id: string,
  dirname = DEFAULT_MEMORY_DIR,
): boolean {
  const root = resolveMemoryRoot(projectRoot, dirname);
  const filePath = canonicalProjectionPath(root, id);
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) return false;
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!isCanonicalProjection(raw, id)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function syncCanonicalMemoryProjections(
  projectRoot: string,
  rawInputs: readonly CanonicalMemoryProjectionInput[],
  dirname = DEFAULT_MEMORY_DIR,
): void {
  const inputs = rawInputs.map((input) =>
    canonicalProjectionInputSchema.parse(input),
  );
  const activeIds = new Set(inputs.map((input) => input.id));
  const root = resolveMemoryRoot(projectRoot, dirname);
  ensureProjectionRoot(root);

  for (const input of inputs) {
    writeCanonicalMemoryProjection(projectRoot, input, dirname);
  }

  for (const name of fs.readdirSync(root)) {
    const filePath = path.join(root, name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) continue;
    // Sweep temp files orphaned by a crash between open() and rename();
    // nothing else ever reaps them and they accumulate without bound.
    if (/\.[0-9a-f]{16}\.tmp$/.test(name)) {
      fs.unlinkSync(filePath);
      continue;
    }
    if (!name.endsWith('.md')) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    const frontmatter = parseFrontmatter(raw);
    if (frontmatter.canonical !== CANONICAL_MEMORY_PROJECTION) continue;
    const id = projectionIdForFile(name, raw);
    // `id === null` here means the file carries our marker but its declared id
    // disagrees with its name — an impostor, removed regardless of activeIds.
    if (id === null || !activeIds.has(id)) {
      fs.unlinkSync(filePath);
    }
  }
}

export function listMemoryNotes(
  projectRoot: string,
  dirname = DEFAULT_MEMORY_DIR,
): MemoryNote[] {
  const root = resolveMemoryRoot(projectRoot, dirname);
  if (!fs.existsSync(root)) return [];
  const notes: MemoryNote[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.md')) continue;
    const filePath = path.join(root, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile()) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      const fm = parseFrontmatter(raw);
      if (fm.canonical !== CANONICAL_MEMORY_PROJECTION) continue;
      // Identity must be self-consistent: a file whose declared id disagrees
      // with its name is an impostor, never a memory.
      const id = projectionIdForFile(name, raw);
      if (id === null) continue;
      const title =
        /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() ?? name.replace(/\.md$/, '');
      const body = raw.replace(/^---[\s\S]*?---\s*/, '');
      notes.push(
        memoryNoteSchema.parse({
          id,
          title,
          kind: fm.kind,
          body: body.slice(0, 64_000),
          wikilinks: extractWikilinks(body),
          missionId: fm.missionId,
          path: filePath,
          updatedAt: Math.floor(stat.mtimeMs),
        }),
      );
    } catch {
      // skip corrupt
    }
  }
  return notes.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function searchMemory(
  projectRoot: string,
  query: string,
  dirname = DEFAULT_MEMORY_DIR,
): MemoryNote[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return listMemoryNotes(projectRoot, dirname).filter((n) => {
    const hay = `${n.title}\n${n.body}\n${n.wikilinks.join('\n')}`.toLowerCase();
    return hay.includes(q);
  });
}

export function backlinks(
  projectRoot: string,
  title: string,
  dirname = DEFAULT_MEMORY_DIR,
): MemoryNote[] {
  const t = title.toLowerCase();
  return listMemoryNotes(projectRoot, dirname).filter((n) =>
    n.wikilinks.some((w) => w.toLowerCase() === t),
  );
}

export function wikilinkCompletions(
  projectRoot: string,
  prefix: string,
  dirname = DEFAULT_MEMORY_DIR,
): string[] {
  const p = prefix.toLowerCase();
  return listMemoryNotes(projectRoot, dirname)
    .map((n) => n.title)
    .filter((t) => t.toLowerCase().startsWith(p))
    .slice(0, 20);
}
