import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  isMissionScopedSource,
  isProjectableMissionId,
  missionIdFromProjectionSource,
} from '../../shared/mission-id';
import { resolveSubdirUnderRoot } from '../security/scoped-workspace-fs';
import { writeFileAtomic } from '../util/atomic-write';

/**
 * Human-readable projection of the canonical SQLite/FTS5 memory — and, since
 * H4, a two-way surface: the *body* of a projection file is an input.
 *
 * What a file may say is still bounded. Identity is never self-asserted (the
 * declared id must equal the filename), provenance/kind/importance are never
 * read back, and a body only wins over SQLite when the frontmatter `updatedAt`
 * proves it was edited from the version the row still holds. Everything else —
 * planted files, impostors, damaged frontmatter, stale buffers — is repaired
 * or reaped exactly as before. Unrelated human Markdown without our canonical
 * marker stays untouched and invisible to the memory APIs.
 *
 * Ingestion itself lives in `nexus-memory-ingest.ts`; this module owns how a
 * projection is rendered, parsed and listed.
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
    const raw = m[1].trim();
    const pipeIdx = raw.indexOf('|');
    const target = (pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw).trim();
    if (target.length > 0) {
      out.add(target);
    }
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

/**
 * kind='mission' É o filtro do provider de busca de missões. Promover por mero
 * teste de substring sobre `source` deixava o chamador escolher em que missão a
 * nota aparece; só a forma canônica de atribuição conta (ver mission-id).
 */
function projectionKind(
  input: CanonicalMemoryProjectionInput,
): MemoryNote['kind'] {
  if (input.kind === 'decision') return 'decision';
  if (isMissionScopedSource(input.source)) return 'mission';
  if (/(?:^|:)(?:agent|pane):/.test(input.source ?? '')) return 'agent';
  return 'note';
}

/**
 * O antigo `/(?:^|:)mission:(.+)$/` devolvia o resto da string inteiro — `../x`
 * incluído — para um campo que a projeção de missão usa como identidade (e como
 * nome de arquivo). O charset é conferido antes de o id sair daqui.
 */
function projectionMissionId(source: string | null): string | undefined {
  return missionIdFromProjectionSource(source);
}

export function projectionTitle(content: string, id: string): string {
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

export function memoryProjectionPath(root: string, id: string): string {
  const parsedId = canonicalProjectionInputSchema.shape.id.parse(id);
  return path.join(root, `${parsedId}.md`);
}

const PROJECTION_BANNER =
  '<!-- Edit the body below: the next sync ingests it into the canonical ' +
  'SQLite memory. Frontmatter is identity — changing it only invalidates ' +
  'the file. -->';

function normalizeProjectionBody(raw: string): string {
  return raw.replaceAll('\r\n', '\n').trim();
}

/**
 * The visible text of a projection: title heading plus the content below it.
 *
 * Dirtiness is decided by comparing *this* against the body read back from
 * disk, never raw bytes against stored content. The renderer re-emits the
 * first heading as the title, so a memory stored without one round-trips to a
 * different string — byte comparison would report an operator edit on every
 * pass for every heading-less memory, and each pass would rewrite the row.
 */
export function projectionBody(input: CanonicalMemoryProjectionInput): string {
  const title = projectionTitle(input.content, input.id);
  return normalizeProjectionBody(
    `# ${title}\n\n${input.content.replace(/^#{1,6}\s+[^\r\n]+\r?\n+/, '')}`,
  );
}

/** Inverse of the renderer: the body an operator actually sees and edits. */
export function extractProjectionBody(raw: string): string {
  const withoutFrontmatter = raw.replace(
    /^---\r?\n[\s\S]*?\r?\n---[^\S\n]*\r?\n?/,
    '',
  );
  return normalizeProjectionBody(
    withoutFrontmatter.replace(/^\s*<!--[\s\S]*?-->[^\S\n]*\r?\n?/, ''),
  );
}

function projectionMarkdown(
  input: CanonicalMemoryProjectionInput,
  kind: MemoryNote['kind'],
  missionId: string | undefined,
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
    PROJECTION_BANNER,
    '',
    projectionBody(input),
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
  const filePath = memoryProjectionPath(root, input.id);
  const kind = projectionKind(input);
  const missionId = projectionMissionId(input.source);
  const title = projectionTitle(input.content, input.id);
  const markdown = projectionMarkdown(input, kind, missionId);
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

export interface ProjectionFrontmatter {
  kind: MemoryNote['kind'];
  missionId?: string;
  idFromFm?: string;
  canonical?: string;
  /** Row version this file was rendered from; the conflict token for input. */
  updatedAt?: number;
}

export function parseFrontmatter(raw: string): ProjectionFrontmatter {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!fm) return { kind: 'note' };
  const block = fm[1];
  const kindRaw = /^kind:\s*(\S+)/m.exec(block)?.[1]?.trim();
  const kind =
    kindRaw && MEMORY_KINDS.has(kindRaw)
      ? (kindRaw as MemoryNote['kind'])
      : 'note';
  // A identidade lida do frontmatter passa pelo mesmo charset da escrita: um
  // arquivo plantado satisfaz id == nome do arquivo e ainda declara o resto
  // livremente, e este campo é justamente o que a projeção de missão usa como
  // identidade (e como nome de arquivo). Só a forma citada que o escritor emite
  // conta: `missionId: null` sem aspas não é o id "null", é ausência de valor.
  //
  // `kind` fica como declarado de propósito — nota de missão escrita por agente
  // é legitimamente kind=mission SEM mission id (a provenance carrega
  // autoridade de sessão, não identidade de missão). Quem autentica o arquivo
  // é o marcador canônico + id == nome, e quem varre impostor é o reaper.
  const missionQuoted = /^missionId:\s*"([^"]*)"\s*$/m.exec(block)?.[1];
  const missionId = isProjectableMissionId(missionQuoted)
    ? missionQuoted
    : undefined;
  const idFromFm = /^id:\s*(\S+)/m.exec(block)?.[1]?.trim();
  const canonical = /^canonical:\s*(\S+)/m.exec(block)?.[1]?.trim();
  const updatedRaw = /^updatedAt:\s*(\d{1,15})\s*$/m.exec(block)?.[1];
  return {
    kind,
    missionId,
    idFromFm,
    canonical,
    ...(updatedRaw ? { updatedAt: Number(updatedRaw) } : {}),
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
  const filePath = memoryProjectionPath(root, id);
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

// ---------------------------------------------------------------------------
// Vault markdown legível (F-769): exportação one-shot para
// <workspace>/.nexus-memory/, fora do git (.gitignore próprio), abrindo
// direto como vault no Obsidian. É uma visão morta: a ingestão de edições
// só roda sobre raízes registradas em userData, e o checkout nunca é
// registrado — quem edita memória é o app, não o arquivo.
// ---------------------------------------------------------------------------

const VAULT_GITIGNORE = '*\n';
const VAULT_BANNER =
  '<!-- Cópia legível da memória canônica (SQLite), reescrita a cada ' +
  'exportação: edite a memória no app Nexus. Esta pasta abre como vault ' +
  'no Obsidian. -->';

const VAULT_INDEX_KINDS = ['decision', 'mission', 'agent', 'note'] as const;
const VAULT_INDEX_TITLES: Readonly<Record<MemoryNote['kind'], string>> = {
  decision: 'Decisões',
  mission: 'Missões',
  agent: 'Notas de agentes',
  note: 'Notas',
};

function vaultSlug(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'memoria';
}

/**
 * Nome legível e determinístico: slug do título + sufixo curto do id, para
 * que reexportações não criem um arquivo novo a cada sync nem colidam dois
 * títulos iguais.
 */
export function memoryVaultFileName(
  input: CanonicalMemoryProjectionInput,
): string {
  const parsedId = canonicalProjectionInputSchema.shape.id.parse(input.id);
  return `${vaultSlug(projectionTitle(input.content, parsedId))}-${parsedId.slice(4, 10)}.md`;
}

const FILE_PATH_TOKEN_RE =
  /(?<![\w@+.~:/[\]-])((?:[\w@+.~-]+\/)+[\w+.~-]+\.[A-Za-z0-9]{1,8})(?![\w\]|])/g;

/**
 * Envolve caminhos de arquivo citados no texto em wikilinks Obsidian
 * (`[[src/caminho.ts]]`). Wikilinks já existentes e URLs são preservados.
 */
export function linkifyFilePaths(content: string): string {
  return content
    .split(/(\[\[[^\]]{1,256}\]\])/g)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(FILE_PATH_TOKEN_RE, '[[$1]]'),
    )
    .join('');
}

function vaultNoteMarkdown(
  input: CanonicalMemoryProjectionInput,
  kind: MemoryNote['kind'],
  missionId: string | undefined,
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
    VAULT_BANNER,
    '',
    linkifyFilePaths(projectionBody(input)),
    '',
  ].join('\n');
}

function vaultIndexName(kind: MemoryNote['kind']): string {
  return `INDEX-${kind}.md`;
}

function vaultIndexMarkdown(
  kind: MemoryNote['kind'],
  entries: ReadonlyArray<{ file: string; title: string }>,
): string {
  const lines = entries.map(
    (entry) => `- [[${entry.file.replace(/\.md$/, '')}|${entry.title}]]`,
  );
  return [`# Índice — ${VAULT_INDEX_TITLES[kind]}`, '', ...lines, ''].join('\n');
}

function writeFileIfChanged(filePath: string, content: string): void {
  let isCurrent = false;
  try {
    isCurrent =
      fs.lstatSync(filePath).isFile() &&
      fs.readFileSync(filePath, 'utf8') === content;
  } catch {
    // Missing/unreadable/stale file is repaired by the atomic write.
  }
  if (!isCurrent) writeFileAtomic(filePath, content);
}

/**
 * Exporta a memória ativa do workspace como vault markdown legível: nomes de
 * arquivo por slug do título, um `INDEX-<kind>.md` por tipo, wikilinks
 * automáticos para caminhos de arquivo citados e `.gitignore` próprio —
 * nada aqui entra no git. Arquivos gerados que saíram do conjunto ativo são
 * colhidos; markdown sem o marcador canônico (nota humana solta na pasta)
 * fica intacto.
 */
export function exportMemoryVault(
  projectRoot: string,
  rawInputs: readonly CanonicalMemoryProjectionInput[],
  dirname = DEFAULT_MEMORY_DIR,
): string {
  const inputs = rawInputs.map((input) =>
    canonicalProjectionInputSchema.parse(input),
  );
  const root = resolveMemoryRoot(projectRoot, dirname);
  ensureProjectionRoot(root);
  writeFileIfChanged(path.join(root, '.gitignore'), VAULT_GITIGNORE);

  const active = new Set<string>();
  const byKind = new Map<
    MemoryNote['kind'],
    Array<{ file: string; title: string }>
  >();
  for (const input of inputs) {
    const name = memoryVaultFileName(input);
    const kind = projectionKind(input);
    const markdown = vaultNoteMarkdown(
      input,
      kind,
      projectionMissionId(input.source),
    );
    active.add(name);
    writeFileIfChanged(path.join(root, name), markdown);
    const entries = byKind.get(kind) ?? [];
    entries.push({ file: name, title: projectionTitle(input.content, input.id) });
    byKind.set(kind, entries);
  }

  for (const kind of VAULT_INDEX_KINDS) {
    const entries = byKind.get(kind);
    if (!entries) continue;
    const name = vaultIndexName(kind);
    active.add(name);
    writeFileIfChanged(path.join(root, name), vaultIndexMarkdown(kind, entries));
  }

  for (const name of fs.readdirSync(root)) {
    const filePath = path.join(root, name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) continue;
    // Sweep temp files orphaned by a crash between open() and rename().
    if (/\.[0-9a-f]{16}\.tmp$/.test(name)) {
      fs.unlinkSync(filePath);
      continue;
    }
    if (!name.endsWith('.md') || active.has(name)) continue;
    if (
      VAULT_INDEX_KINDS.some((kind) => name === vaultIndexName(kind)) ||
      parseFrontmatter(fs.readFileSync(filePath, 'utf8')).canonical ===
        CANONICAL_MEMORY_PROJECTION
    ) {
      fs.unlinkSync(filePath);
    }
  }
  return root;
}

/**
 * Cheap staleness token for a projection directory: one readdir plus an lstat
 * per candidate, no file contents. Everything that can change what the
 * directory *means* — a create, a rename, a reap, an in-place edit — moves a
 * name, an mtime or a size.
 */
export function projectionSignature(
  projectRoot: string,
  dirname = DEFAULT_MEMORY_DIR,
): string {
  let root: string;
  try {
    root = resolveMemoryRoot(projectRoot, dirname);
  } catch {
    return 'unresolvable';
  }
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return 'absent';
  }
  const parts: string[] = [];
  for (const name of names) {
    try {
      const stat = fs.lstatSync(path.join(root, name));
      if (!stat.isFile()) continue;
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      // Vanished mid-scan; the next signature reflects it.
    }
  }
  return parts.join('|');
}

interface ProjectionScan {
  readonly signature: string;
  readonly notes: readonly MemoryNote[];
}

/**
 * One entry per live workspace; the cap only keeps a long-lived main process
 * from accumulating entries for roots nobody reads anymore.
 */
const MAX_CACHED_PROJECTION_SCANS = 16;
const scanCache = new Map<string, ProjectionScan>();

function cacheScan(key: string, scan: ProjectionScan): void {
  scanCache.delete(key);
  scanCache.set(key, scan);
  while (scanCache.size > MAX_CACHED_PROJECTION_SCANS) {
    const oldest = scanCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    scanCache.delete(oldest);
  }
}

export interface ProjectionCounts {
  readonly notes: number;
  readonly byKind: Readonly<Record<MemoryNote['kind'], number>>;
  /** True when the answer came from the stat cache, with no file re-read. */
  readonly cached: boolean;
}

/**
 * Status with counts and without a full read: the directory is walked only to
 * prove nothing moved. Callers that merely want totals must never pay for the
 * whole-directory parse that `listMemoryNotes` does.
 */
export function projectionCounts(
  projectRoot: string,
  dirname = DEFAULT_MEMORY_DIR,
): ProjectionCounts {
  const { notes, cached } = readProjectionNotes(projectRoot, dirname);
  const byKind: Record<MemoryNote['kind'], number> = {
    decision: 0,
    mission: 0,
    agent: 0,
    note: 0,
  };
  for (const note of notes) byKind[note.kind] += 1;
  return Object.freeze({
    notes: notes.length,
    byKind: Object.freeze(byKind),
    cached,
  });
}

/** Test-only: the cache is keyed by content signature, never by time. */
export function resetProjectionScanCache(): void {
  scanCache.clear();
}

function readProjectionNotes(
  projectRoot: string,
  dirname: string,
): { readonly notes: readonly MemoryNote[]; readonly cached: boolean } {
  const key = `${projectRoot}\0${dirname}`;
  const signature = projectionSignature(projectRoot, dirname);
  const hit = scanCache.get(key);
  if (hit?.signature === signature) return { notes: hit.notes, cached: true };
  const notes = Object.freeze(scanProjectionNotes(projectRoot, dirname));
  cacheScan(key, { signature, notes });
  return { notes, cached: false };
}

export function listMemoryNotes(
  projectRoot: string,
  dirname = DEFAULT_MEMORY_DIR,
): MemoryNote[] {
  return [...readProjectionNotes(projectRoot, dirname).notes];
}

function scanProjectionNotes(
  projectRoot: string,
  dirname: string,
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

const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'all', 'and', 'any', 'are',
  'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'could', 'did', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'here', 'how', 'into', 'itself',
  'just', 'more', 'most', 'other', 'over', 'same', 'should', 'some', 'such',
  'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until',
  'very', 'was', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'whom', 'why', 'with', 'would', 'para', 'como', 'mais', 'pelo', 'pela',
  'este', 'esta', 'isso', 'aquilo', 'onde', 'quando', 'quem',
]);

function extractDistinctiveTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

export function listOrphans(
  projectRoot: string,
  dirname = DEFAULT_MEMORY_DIR,
): MemoryNote[] {
  const allNotes = listMemoryNotes(projectRoot, dirname);
  const titles = new Set(allNotes.map((n) => n.title.toLowerCase()));

  // Count incoming resolved links
  const incoming = new Map<string, number>();
  for (const t of titles) incoming.set(t, 0);

  for (const n of allNotes) {
    for (const link of n.wikilinks) {
      const lower = link.toLowerCase();
      if (incoming.has(lower)) {
        incoming.set(lower, (incoming.get(lower) ?? 0) + 1);
      }
    }
  }

  // Orphan: 0 incoming AND 0 valid outgoing links
  return allNotes.filter((n) => {
    const inc = incoming.get(n.title.toLowerCase()) ?? 0;
    const validOut = n.wikilinks.filter((w) => titles.has(w.toLowerCase())).length;
    return inc === 0 && validOut === 0;
  });
}

export interface ConnectionSuggestion {
  readonly note: MemoryNote;
  readonly score: number;
  readonly sharedTerms: string[];
}

export function suggestConnections(
  projectRoot: string,
  identifier: string,
  limit = 5,
  dirname = DEFAULT_MEMORY_DIR,
): ConnectionSuggestion[] {
  const allNotes = listMemoryNotes(projectRoot, dirname);
  const targetLower = identifier.toLowerCase();
  const targetNote = allNotes.find(
    (n) => n.id === identifier || n.title.toLowerCase() === targetLower,
  );
  if (!targetNote) return [];

  const targetTokens = extractDistinctiveTokens(
    `${targetNote.title} ${targetNote.body}`,
  );
  if (targetTokens.size === 0) return [];
  const existingLinks = new Set(targetNote.wikilinks.map((w) => w.toLowerCase()));
  existingLinks.add(targetNote.title.toLowerCase());

  const suggestions: ConnectionSuggestion[] = [];

  for (const other of allNotes) {
    if (other.id === targetNote.id) continue;
    if (existingLinks.has(other.title.toLowerCase())) continue;

    const otherTokens = extractDistinctiveTokens(
      `${other.title} ${other.body}`,
    );

    const shared: string[] = [];
    for (const token of targetTokens) {
      if (otherTokens.has(token)) {
        shared.push(token);
      }
    }

    if (shared.length > 0) {
      suggestions.push({
        note: other,
        score: shared.length,
        sharedTerms: shared.slice(0, 4),
      });
    }
  }

  return suggestions
    .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt)
    .slice(0, limit);
}

