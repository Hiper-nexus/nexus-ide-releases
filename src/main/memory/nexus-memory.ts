import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  isMissionScopedSource,
  isProjectableMissionId,
  missionIdFromProjectionSource,
} from '../../shared/mission-id';
import { resolveSubdirUnderRoot } from '../security/scoped-workspace-fs';
import { writeFileAtomicAsync } from '../util/atomic-write';
import { FILE_PATH_TOKEN_RE } from './memory-links';

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
 *
 * F-764: todo escritor da projeção (e a assinatura) usa `fs.promises` — a
 * varredura O(N) e os fsync rodam no pool do libuv, nunca no event loop do
 * Main. O `signal` opcional interrompe a passada entre um passo e outro
 * quando o store fecha.
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
    /**
     * F-800: marca "a reverificar" (arquivo citado sumiu do checkout). Só
     * frontmatter: a linha segue ativa e o corpo não muda.
     */
    reverify: z.string().max(512).optional(),
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
async function ensureProjectionRoot(
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const real = await fs.promises.realpath(root);
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

/** Tipo de projeção de uma linha (o que decide o `INDEX-<kind>.md` do vault). */
export function projectionKindOf(
  input: Pick<CanonicalMemoryProjectionInput, 'kind' | 'source'>,
): MemoryNote['kind'] {
  return projectionKind(input as CanonicalMemoryProjectionInput);
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
    ...(input.reverify ? [`reverify: ${yamlString(input.reverify)}`] : []),
    '---',
    '',
    PROJECTION_BANNER,
    '',
    projectionBody(input),
    '',
  ].join('\n');
}

/**
 * Writes one row's projection under an already-proven root. Containment is
 * re-proved before *each* file, as the per-file call always did: a root
 * swapped for a symlink mid-pass must stop the pass, not redirect it.
 */
async function writeProjectionFile(
  root: string,
  input: CanonicalMemoryProjectionInput,
  signal?: AbortSignal,
): Promise<MemoryNote> {
  await ensureProjectionRoot(root, signal);
  const filePath = memoryProjectionPath(root, input.id);
  const kind = projectionKind(input);
  const missionId = projectionMissionId(input.source);
  const title = projectionTitle(input.content, input.id);
  const markdown = projectionMarkdown(input, kind, missionId);
  await writeFileIfChanged(filePath, markdown, signal);
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

export async function writeCanonicalMemoryProjection(
  projectRoot: string,
  rawInput: CanonicalMemoryProjectionInput,
  dirname = DEFAULT_MEMORY_DIR,
  signal?: AbortSignal,
): Promise<MemoryNote> {
  return writeCanonicalMemoryProjectionAt(
    resolveMemoryRoot(projectRoot, dirname),
    rawInput,
    signal,
  );
}

/**
 * Same write under a memory root already resolved by `resolveMemoryRoot`.
 * The containment check is synchronous: a batch resolves it once instead of
 * once per id, keeping O(ids) blocking syscalls off the Main thread.
 */
export async function writeCanonicalMemoryProjectionAt(
  memoryRoot: string,
  rawInput: CanonicalMemoryProjectionInput,
  signal?: AbortSignal,
): Promise<MemoryNote> {
  return writeProjectionFile(
    memoryRoot,
    canonicalProjectionInputSchema.parse(rawInput),
    signal,
  );
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

export async function removeCanonicalMemoryProjection(
  projectRoot: string,
  id: string,
  dirname = DEFAULT_MEMORY_DIR,
): Promise<boolean> {
  return removeCanonicalMemoryProjectionAt(
    resolveMemoryRoot(projectRoot, dirname),
    id,
  );
}

/** Removal under an already-resolved memory root (see the `At` writer). */
export async function removeCanonicalMemoryProjectionAt(
  memoryRoot: string,
  id: string,
): Promise<boolean> {
  const filePath = memoryProjectionPath(memoryRoot, id);
  // The root was resolved before an await: re-prove it still is itself
  // (not swapped for a symlink) before unlinking anything under it.
  const real = await fs.promises.realpath(memoryRoot).catch(() => null);
  if (real !== memoryRoot) return false;
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const raw = await fs.promises.readFile(filePath, 'utf8');
  if (!isCanonicalProjection(raw, id)) return false;
  await fs.promises.unlink(filePath);
  return true;
}

export async function syncCanonicalMemoryProjections(
  projectRoot: string,
  rawInputs: readonly CanonicalMemoryProjectionInput[],
  dirname = DEFAULT_MEMORY_DIR,
  signal?: AbortSignal,
): Promise<void> {
  const inputs = rawInputs.map((input) =>
    canonicalProjectionInputSchema.parse(input),
  );
  const activeIds = new Set(inputs.map((input) => input.id));
  const root = resolveMemoryRoot(projectRoot, dirname);
  await ensureProjectionRoot(root, signal);

  for (const input of inputs) {
    await writeProjectionFile(root, input, signal);
  }

  for (const name of await fs.promises.readdir(root)) {
    signal?.throwIfAborted();
    const filePath = path.join(root, name);
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile()) continue;
    // Sweep temp files orphaned by a crash between open() and rename();
    // nothing else ever reaps them and they accumulate without bound.
    if (/\.[0-9a-f]{16}\.tmp$/.test(name)) {
      await fs.promises.unlink(filePath);
      continue;
    }
    if (!name.endsWith('.md')) continue;
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const frontmatter = parseFrontmatter(raw);
    if (frontmatter.canonical !== CANONICAL_MEMORY_PROJECTION) continue;
    const id = projectionIdForFile(name, raw);
    // `id === null` here means the file carries our marker but its declared id
    // disagrees with its name — an impostor, removed regardless of activeIds.
    if (id === null || !activeIds.has(id)) {
      await fs.promises.unlink(filePath);
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

/**
 * Envolve caminhos de arquivo citados no texto em wikilinks Obsidian
 * (`[[src/caminho.ts]]`). Wikilinks já existentes e URLs são preservados.
 * O padrão de caminho é o mesmo das arestas do SQLite (memory-links): o que
 * vira link aqui é o que vira `file:` lá.
 */
export function linkifyFilePaths(content: string): string {
  return content
    .split(/(\[\[[^\]]{1,256}\]\])/g)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(FILE_PATH_TOKEN_RE, '[[$1]]'),
    )
    .join('');
}

/** Nome do hub de missão no vault (`missao-<id>.md`); o id já passou pelo charset. */
export function missionHubFileName(missionId: string): string {
  return `missao-${missionId}.md`;
}

const MISSION_LINE_RE = /^(Mission:[ \t]+)([a-z0-9][a-z0-9-]{0,63})[ \t]*$/gm;

/**
 * Wikilink automático de `[[missão]]` (F-801): a linha `Mission: <id>` dos
 * eventos trusted aponta para o hub da missão, e a nota atribuída pelo
 * operador (`operator:mission:<id>`) ganha a mesma ligação no fim do corpo.
 * Devolve também os ids de missão ligados, para o export montar os hubs.
 */
export function linkifyMissions(
  body: string,
  missionIdFromSource: string | undefined,
): { readonly body: string; readonly missionIds: readonly string[] } {
  const ids = new Set<string>();
  let out = body.replace(MISSION_LINE_RE, (_match, label: string, id: string) => {
    if (!isProjectableMissionId(id)) return `${label}${id}`;
    ids.add(id);
    return `${label}[[${missionHubFileName(id).replace(/\.md$/, '')}|${id}]]`;
  });
  if (missionIdFromSource && !ids.has(missionIdFromSource)) {
    ids.add(missionIdFromSource);
    out += `\n\nMissão: [[${missionHubFileName(missionIdFromSource).replace(/\.md$/, '')}|${missionIdFromSource}]]`;
  }
  return { body: out, missionIds: [...ids] };
}

function vaultNoteMarkdown(
  input: CanonicalMemoryProjectionInput,
  kind: MemoryNote['kind'],
  missionId: string | undefined,
): { readonly markdown: string; readonly missionIds: readonly string[] } {
  const linked = linkifyMissions(linkifyFilePaths(projectionBody(input)), missionId);
  const markdown = [
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
    ...(input.reverify ? [`reverify: ${yamlString(input.reverify)}`] : []),
    '---',
    '',
    VAULT_BANNER,
    '',
    linked.body,
    '',
  ].join('\n');
  return { markdown, missionIds: linked.missionIds };
}

/**
 * Hub de uma missão: uma nota gerada por missão com a lista das memórias que
 * a citam. É o nó que o grafo do Obsidian mostra ligando as entregas de uma
 * mesma missão; leva o marcador canônico para ser colhido quando a missão
 * deixa de ter memória ativa.
 */
function missionHubMarkdown(
  missionId: string,
  entries: ReadonlyArray<{ file: string; title: string }>,
): string {
  return [
    '---',
    `id: hub-${missionId}`,
    `canonical: ${CANONICAL_MEMORY_PROJECTION}`,
    'generated: true',
    'kind: mission',
    `missionId: ${yamlString(missionId)}`,
    '---',
    '',
    VAULT_BANNER,
    '',
    `# Missão ${missionId}`,
    '',
    ...entries.map((entry) => `- [[${entry.file.replace(/\.md$/, '')}|${entry.title}]]`),
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

/** Rewrites only what moved: an unchanged file keeps its mtime (anti onChange loop). */
async function writeFileIfChanged(
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let isCurrent = false;
  try {
    isCurrent =
      (await fs.promises.lstat(filePath)).isFile() &&
      (await fs.promises.readFile(filePath, 'utf8')) === content;
  } catch {
    // Missing/unreadable/stale file is repaired by the atomic write.
  }
  if (isCurrent) return;
  signal?.throwIfAborted();
  await writeFileAtomicAsync(filePath, content);
}

/**
 * Exporta a memória ativa do workspace como vault markdown legível: nomes de
 * arquivo por slug do título, um `INDEX-<kind>.md` por tipo, wikilinks
 * automáticos para caminhos de arquivo citados e `.gitignore` próprio —
 * nada aqui entra no git. Arquivos gerados que saíram do conjunto ativo são
 * colhidos; markdown sem o marcador canônico (nota humana solta na pasta)
 * fica intacto.
 */
export async function exportMemoryVault(
  projectRoot: string,
  rawInputs: readonly CanonicalMemoryProjectionInput[],
  dirname = DEFAULT_MEMORY_DIR,
  signal?: AbortSignal,
): Promise<string> {
  const inputs = rawInputs.map((input) =>
    canonicalProjectionInputSchema.parse(input),
  );
  const root = resolveMemoryRoot(projectRoot, dirname);
  await ensureProjectionRoot(root, signal);
  await writeFileIfChanged(path.join(root, '.gitignore'), VAULT_GITIGNORE, signal);

  const active = new Set<string>();
  const byKind = new Map<
    MemoryNote['kind'],
    Array<{ file: string; title: string }>
  >();
  const byMission = new Map<string, Array<{ file: string; title: string }>>();
  for (const input of inputs) {
    const name = memoryVaultFileName(input);
    const kind = projectionKind(input);
    const note = vaultNoteMarkdown(
      input,
      kind,
      projectionMissionId(input.source),
    );
    active.add(name);
    await writeFileIfChanged(path.join(root, name), note.markdown, signal);
    const title = projectionTitle(input.content, input.id);
    const entries = byKind.get(kind) ?? [];
    entries.push({ file: name, title });
    byKind.set(kind, entries);
    for (const missionId of note.missionIds) {
      const hub = byMission.get(missionId) ?? [];
      hub.push({ file: name, title });
      byMission.set(missionId, hub);
    }
  }

  for (const kind of VAULT_INDEX_KINDS) {
    const entries = byKind.get(kind);
    if (!entries) continue;
    const name = vaultIndexName(kind);
    active.add(name);
    await writeFileIfChanged(
      path.join(root, name),
      vaultIndexMarkdown(kind, entries),
      signal,
    );
  }

  // F-801: um hub por missão — o nó que liga as memórias de uma mesma missão.
  for (const [missionId, entries] of byMission) {
    const name = missionHubFileName(missionId);
    active.add(name);
    await writeFileIfChanged(
      path.join(root, name),
      missionHubMarkdown(missionId, entries),
      signal,
    );
  }

  for (const name of await fs.promises.readdir(root)) {
    signal?.throwIfAborted();
    const filePath = path.join(root, name);
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile()) continue;
    // Sweep temp files orphaned by a crash between open() and rename().
    if (/\.[0-9a-f]{16}\.tmp$/.test(name)) {
      await fs.promises.unlink(filePath);
      continue;
    }
    if (!name.endsWith('.md') || active.has(name)) continue;
    if (
      VAULT_INDEX_KINDS.some((kind) => name === vaultIndexName(kind)) ||
      parseFrontmatter(await fs.promises.readFile(filePath, 'utf8'))
        .canonical === CANONICAL_MEMORY_PROJECTION
    ) {
      await fs.promises.unlink(filePath);
    }
  }
  return root;
}

/** Entrada de índice/hub do vault: a própria linha, de onde saem nome e título. */
export interface VaultIndexEntry {
  readonly record: CanonicalMemoryProjectionInput;
}

export interface MemoryVaultDelta {
  /** Linhas ativas cujo arquivo deve ser (re)escrito. */
  readonly changed: readonly CanonicalMemoryProjectionInput[];
  /** Linhas esquecidas/substituídas cujo arquivo deve sair. */
  readonly removed: readonly CanonicalMemoryProjectionInput[];
  /** Índices dos tipos afetados, já com TODAS as entradas ativas do tipo. */
  readonly indexes: ReadonlyMap<MemoryNote['kind'], readonly VaultIndexEntry[]>;
  /** Hubs das missões afetadas, já com TODAS as notas ativas da missão. */
  readonly hubs: ReadonlyMap<string, readonly VaultIndexEntry[]>;
}

/** Remove um arquivo gerado do vault se ele ainda for o que o escritor emitiu. */
async function removeVaultGeneratedFile(filePath: string): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const raw = await fs.promises.readFile(filePath, 'utf8');
  if (parseFrontmatter(raw).canonical !== CANONICAL_MEMORY_PROJECTION) return false;
  await fs.promises.unlink(filePath);
  return true;
}

function indexEntriesOf(
  entries: readonly VaultIndexEntry[],
): Array<{ file: string; title: string }> {
  return entries.map(({ record }) => ({
    file: memoryVaultFileName(record),
    title: projectionTitle(record.content, record.id),
  }));
}

/**
 * Exportação INCREMENTAL do vault (F-807): só as notas do lote, os índices
 * dos tipos afetados e os hubs das missões afetadas — O(lote + índice), não
 * O(N notas). A exportação completa (`exportMemoryVault`) fica para a
 * primeira passada de uma raiz no processo e para a reconciliação explícita.
 */
export async function exportMemoryVaultIncremental(
  projectRoot: string,
  delta: MemoryVaultDelta,
  dirname = DEFAULT_MEMORY_DIR,
  signal?: AbortSignal,
): Promise<string> {
  const root = resolveMemoryRoot(projectRoot, dirname);
  await ensureProjectionRoot(root, signal);
  await writeFileIfChanged(path.join(root, '.gitignore'), VAULT_GITIGNORE, signal);

  for (const raw of delta.changed) {
    const input = canonicalProjectionInputSchema.parse(raw);
    const note = vaultNoteMarkdown(input, projectionKind(input), projectionMissionId(input.source));
    await writeFileIfChanged(path.join(root, memoryVaultFileName(input)), note.markdown, signal);
  }
  for (const raw of delta.removed) {
    signal?.throwIfAborted();
    const input = canonicalProjectionInputSchema.parse(raw);
    await removeVaultGeneratedFile(path.join(root, memoryVaultFileName(input)));
  }
  for (const [kind, entries] of delta.indexes) {
    signal?.throwIfAborted();
    const filePath = path.join(root, vaultIndexName(kind));
    if (entries.length === 0) {
      await fs.promises.unlink(filePath).catch(() => undefined);
      continue;
    }
    await writeFileIfChanged(filePath, vaultIndexMarkdown(kind, indexEntriesOf(entries)), signal);
  }
  for (const [missionId, entries] of delta.hubs) {
    signal?.throwIfAborted();
    if (!isProjectableMissionId(missionId)) continue;
    const filePath = path.join(root, missionHubFileName(missionId));
    if (entries.length === 0) {
      await removeVaultGeneratedFile(filePath);
      continue;
    }
    await writeFileIfChanged(
      filePath,
      missionHubMarkdown(missionId, indexEntriesOf(entries)),
      signal,
    );
  }
  return root;
}

function signatureOf(
  entries: ReadonlyArray<{ name: string; stat: fs.Stats | null }>,
): string {
  return entries
    .filter((entry) => entry.stat?.isFile())
    .map((entry) => `${entry.name}:${entry.stat!.mtimeMs}:${entry.stat!.size}`)
    .join('|');
}

/**
 * Cheap staleness token for a projection directory: one readdir plus an lstat
 * per candidate, no file contents. Everything that can change what the
 * directory *means* — a create, a rename, a reap, an in-place edit — moves a
 * name, an mtime or a size.
 *
 * F-764: a passada da projeção recalcula este token a cada lote; era O(N)
 * síncrono por gravação. Aqui o readdir e os lstat rodam no pool do libuv.
 */
export async function projectionSignature(
  projectRoot: string,
  dirname = DEFAULT_MEMORY_DIR,
): Promise<string> {
  let root: string;
  try {
    root = resolveMemoryRoot(projectRoot, dirname);
  } catch {
    return 'unresolvable';
  }
  let names: string[];
  try {
    names = (await fs.promises.readdir(root))
      .filter((name) => name.endsWith('.md'))
      .sort();
  } catch {
    return 'absent';
  }
  const entries = await Promise.all(
    names.map(async (name) => ({
      name,
      // Vanished mid-scan (null): the next signature reflects it.
      stat: await fs.promises.lstat(path.join(root, name)).catch(() => null),
    })),
  );
  return signatureOf(entries);
}

/** Same token, for the synchronous listing cache of the read path. */
function projectionSignatureSync(projectRoot: string, dirname: string): string {
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
  return signatureOf(
    names.map((name) => {
      try {
        return { name, stat: fs.lstatSync(path.join(root, name)) };
      } catch {
        // Vanished mid-scan; the next signature reflects it.
        return { name, stat: null };
      }
    }),
  );
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
  const signature = projectionSignatureSync(projectRoot, dirname);
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

