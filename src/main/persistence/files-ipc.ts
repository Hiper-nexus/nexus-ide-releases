import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ipcMain } from 'electron';
import {
  FILES_CHANNELS,
  importDroppedUriSchema,
  listDirSchema,
  readFileSchema,
  searchFilesSchema,
  writeFileSchema,
  type FileNode,
  type FileTreeResult,
  type ReadFileResult,
  type SearchFilesResult,
} from '../../shared/files-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  DROPPED_ATTACHMENT_MAX_BASE64_CHARS,
  importWorkspaceMissionAttachment,
  saveDroppedFile,
} from './dropped-files';
import { importDroppedUri } from './dropped-uri-import';
import { readClipboardFileUris } from './clipboard-file-uris';
import { convertHeicToJpeg, heicConvertPayloadBytes } from './heic-convert';
import { requireRendererWorkspaceScope } from './renderer-workspace-scope';
import { searchWorkspaceFiles } from '../orch/workspace-file-search';
import { forEachWithConcurrency } from '../util/concurrency';

/**
 * File explorer backend — sandboxed to the invoking renderer's main-owned
 * workspace scope. Every relPath is resolved against its canonical root and
 * rejected if it escapes it, including through symlinks.
 *
 * #21: nenhum IO síncrono no Main. `fs.promises` e o `fs.realpath` em JS
 * (promisify): o mesmo algoritmo do `realpathSync` — o `realpath(3)` nativo
 * corrige a caixa no APFS e mudaria a comparação com a raiz autorizada.
 */
const fsp = fs.promises;
const realpath = promisify(fs.realpath);

const MAX_READ_BYTES = 2_000_000;
const IGNORED = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'out',
  '.vite',
  '.DS_Store',
]);
const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;
/**
 * L5: um FIFO trocado entre o lstat e o open prenderia uma thread do pool do
 * libuv para sempre (open de FIFO espera a outra ponta). Com O_NONBLOCK o
 * open volta na hora e o fstat seguinte recusa o que não é arquivo regular.
 */
const NONBLOCK_FLAG = fs.constants.O_NONBLOCK ?? 0;
/** L4: lstat simultâneos por listagem; o pool do libuv tem 4 threads. */
const LIST_LSTAT_CONCURRENCY = 32;
const PRIVATE_FILE_MODE = 0o600;

type DescriptorOperation = 'read' | 'write';

export interface FilesIpcTestHooks {
  /** Deterministic race hook. Production never supplies this. */
  beforeOpen?: (operation: DescriptorOperation) => void;
}

interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface DirectorySnapshot {
  readonly abs: string;
  readonly identity: PathIdentity;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function identityOf(stat: fs.Stats): PathIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function hasIdentity(stat: fs.Stats, identity: PathIdentity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function sameDirectory(
  left: DirectorySnapshot | null,
  right: DirectorySnapshot,
): boolean {
  return (
    left !== null &&
    left.abs === right.abs &&
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino
  );
}

async function canonicalScopeRoot(
  scope: ProjectExecutionScope,
): Promise<DirectorySnapshot | null> {
  const authorizedRoot = path.resolve(scope.rootRealPath);
  try {
    const rootStat = await fsp.lstat(authorizedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const realRoot = await realpath(authorizedRoot);
    if (path.relative(authorizedRoot, realRoot) !== '') return null;
    return { abs: realRoot, identity: identityOf(rootStat) };
  } catch {
    return null;
  }
}

async function canonicalDirectory(
  root: DirectorySnapshot,
  requestedPath: string,
): Promise<DirectorySnapshot | null> {
  try {
    const realPath = await realpath(requestedPath);
    if (
      path.relative(requestedPath, realPath) !== '' ||
      !isInsideRoot(root.abs, realPath)
    ) {
      return null;
    }
    const stat = await fsp.lstat(requestedPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return { abs: realPath, identity: identityOf(stat) };
  } catch {
    return null;
  }
}

async function resolveLexicalPath(
  scope: ProjectExecutionScope,
  relPath: string,
): Promise<{ root: DirectorySnapshot; abs: string } | null> {
  const root = await canonicalScopeRoot(scope);
  if (!root) return null;
  const abs = path.resolve(root.abs, relPath);
  if (!isInsideRoot(root.abs, abs)) return null;
  return { root, abs };
}

function isSafeRegularFile(stat: fs.Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

async function lstatOrNull(file: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function isBoundaryCurrent(
  scope: ProjectExecutionScope,
  rootBefore: DirectorySnapshot,
  parentBefore: DirectorySnapshot,
  file: string,
): Promise<boolean> {
  const root = await canonicalScopeRoot(scope);
  if (!sameDirectory(root, rootBefore)) return false;
  const parent = root ? await canonicalDirectory(root, path.dirname(file)) : null;
  return sameDirectory(parent, parentBefore);
}

async function isListedDirectoryCurrent(
  scope: ProjectExecutionScope,
  rootBefore: DirectorySnapshot,
  directoryBefore: DirectorySnapshot,
): Promise<boolean> {
  const root = await canonicalScopeRoot(scope);
  if (!sameDirectory(root, rootBefore)) return false;
  const directory = root
    ? await canonicalDirectory(root, directoryBefore.abs)
    : null;
  return sameDirectory(directory, directoryBefore);
}

async function validateOpenedFile(
  scope: ProjectExecutionScope,
  rootBefore: DirectorySnapshot,
  parentBefore: DirectorySnapshot,
  file: string,
  handle: FileHandle,
  expectedBefore: fs.Stats | null,
): Promise<fs.Stats | null> {
  const opened = await handle.stat();
  if (!isSafeRegularFile(opened)) return null;
  if (expectedBefore && !hasIdentity(opened, identityOf(expectedBefore))) {
    return null;
  }

  if (!(await isBoundaryCurrent(scope, rootBefore, parentBefore, file))) return null;
  const current = await lstatOrNull(file);
  if (!current || !isSafeRegularFile(current)) return null;
  if (!hasIdentity(current, identityOf(opened))) return null;
  return opened;
}

/**
 * Entrada direta de uma pasta JÁ canônica (realpath = ela mesma, dentro da
 * raiz): um nome do readdir que não é symlink resolve para `pasta/nome`, logo
 * também dentro da raiz. O realpath por entrada (até 2 por item, um lstat por
 * componente do caminho) era redundante; a pasta é revalidada antes e depois
 * da listagem. Arquivo continua exigindo regular de link único.
 */
async function safeListEntry(
  directory: string,
  dirent: fs.Dirent,
  relPath: string,
): Promise<FileNode | null> {
  const { name } = dirent;
  if (IGNORED.has(name) || dirent.isSymbolicLink()) return null;
  try {
    const stat = await fsp.lstat(path.join(directory, name));
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) return { name, relPath, kind: 'dir' };
    return isSafeRegularFile(stat) ? { name, relPath, kind: 'file' } : null;
  } catch {
    return null;
  }
}

/** Também usado pela Remote Bridge (F-1014) com o escopo do checkout do pane. */
export async function listDir(
  scope: ProjectExecutionScope,
  relPath: string,
): Promise<FileTreeResult> {
  const resolved = await resolveLexicalPath(scope, relPath);
  if (!resolved) return { ok: false, error: 'path outside workspace' };
  const directory = await canonicalDirectory(resolved.root, resolved.abs);
  if (!directory) return { ok: false, error: 'path outside workspace' };
  try {
    const dirents = await fsp.readdir(directory.abs, { withFileTypes: true });
    if (!(await isListedDirectoryCurrent(scope, resolved.root, directory))) {
      return { ok: false, error: 'unsafe directory' };
    }
    const prefix = relPath.split(path.sep).join('/');
    const listed: FileNode[] = [];
    await forEachWithConcurrency(dirents, LIST_LSTAT_CONCURRENCY, async (dirent) => {
      const entry = await safeListEntry(directory.abs, dirent, path.posix.join(prefix, dirent.name));
      if (entry) listed.push(entry);
    });
    const entries = listed
      // Directories first, then alphabetical.
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    if (!(await isListedDirectoryCurrent(scope, resolved.root, directory))) {
      return { ok: false, error: 'unsafe directory' };
    }
    return { ok: true, entries };
  } catch {
    return { ok: false, error: 'list failed' };
  }
}

export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  for (const byte of sample) {
    if (byte === 0) return true; // NUL byte → binary.
  }
  return false;
}

async function readFile(
  scope: ProjectExecutionScope,
  relPath: string,
  hooks: FilesIpcTestHooks,
): Promise<ReadFileResult> {
  const resolved = await resolveLexicalPath(scope, relPath);
  if (!resolved) return { ok: false, error: 'path outside workspace' };
  const parent = await canonicalDirectory(resolved.root, path.dirname(resolved.abs));
  if (!parent) return { ok: false, error: 'path outside workspace' };
  let handle: FileHandle | null = null;
  try {
    const before = await fsp.lstat(resolved.abs);
    if (before.isSymbolicLink()) {
      return { ok: false, error: 'path outside workspace' };
    }
    if (before.isDirectory()) return { ok: false, error: 'is a directory' };
    if (!isSafeRegularFile(before)) return { ok: false, error: 'unsafe file' };
    if (!(await isBoundaryCurrent(scope, resolved.root, parent, resolved.abs))) {
      return { ok: false, error: 'unsafe file' };
    }
    hooks.beforeOpen?.('read');
    handle = await fsp.open(resolved.abs, fs.constants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG);
    const opened = await validateOpenedFile(
      scope,
      resolved.root,
      parent,
      resolved.abs,
      handle,
      before,
    );
    if (!opened) return { ok: false, error: 'unsafe file' };
    if (opened.size > MAX_READ_BYTES) return { ok: true, tooLarge: true };
    const buffer = await handle.readFile();
    if (looksBinary(buffer)) return { ok: true, binary: true };
    return { ok: true, content: buffer.toString('utf8') };
  } catch {
    return { ok: false, error: 'unsafe file' };
  } finally {
    await handle?.close();
  }
}

async function writeFile(
  scope: ProjectExecutionScope,
  relPath: string,
  content: string,
  hooks: FilesIpcTestHooks,
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveLexicalPath(scope, relPath);
  if (!resolved) return { ok: false, error: 'path outside workspace' };
  const parent = await canonicalDirectory(resolved.root, path.dirname(resolved.abs));
  if (!parent) return { ok: false, error: 'path outside workspace' };
  let handle: FileHandle | null = null;
  let created = false;
  let completed = false;
  try {
    const before = await lstatOrNull(resolved.abs);
    if (before?.isSymbolicLink()) {
      return { ok: false, error: 'path outside workspace' };
    }
    if (before?.isDirectory()) return { ok: false, error: 'is a directory' };
    if (before && !isSafeRegularFile(before)) {
      return { ok: false, error: 'unsafe file' };
    }
    if (!(await isBoundaryCurrent(scope, resolved.root, parent, resolved.abs))) {
      return { ok: false, error: 'unsafe file' };
    }
    hooks.beforeOpen?.('write');
    const flags = before
      ? fs.constants.O_WRONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG
      : fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        NOFOLLOW_FLAG |
        NONBLOCK_FLAG;
    handle = await fsp.open(resolved.abs, flags, PRIVATE_FILE_MODE);
    created = before === null;
    const opened = await validateOpenedFile(
      scope,
      resolved.root,
      parent,
      resolved.abs,
      handle,
      before,
    );
    if (!opened) return { ok: false, error: 'unsafe file' };
    if (!isSafeRegularFile(await handle.stat())) {
      return { ok: false, error: 'unsafe file' };
    }
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    completed = true;
    return { ok: true };
  } catch {
    return { ok: false, error: 'unsafe file' };
  } finally {
    if (handle !== null) {
      try {
        if (created && !completed) {
          const opened = await handle.stat();
          const current = await fsp.lstat(resolved.abs);
          if (hasIdentity(current, identityOf(opened))) {
            await fsp.unlink(resolved.abs);
          }
        }
      } catch {
        // The safely-created file was already removed or moved.
      } finally {
        await handle.close();
      }
    }
  }
}

/**
 * Mod+P da paleta: o mesmo motor do `nexus_file_search`, preso à raiz canônica
 * do workspace de quem chamou (nunca a um caminho vindo do renderer). Todo
 * termo, sem caixa, precisa aparecer no caminho relativo.
 */
async function searchFiles(
  scope: ProjectExecutionScope,
  query: string,
): Promise<SearchFilesResult> {
  const root = await canonicalScopeRoot(scope);
  if (!root) return { ok: false, error: 'unsafe workspace' };
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const result = await searchWorkspaceFiles(
    root.abs,
    query,
    { maxResults: 200, maxFiles: 20_000, maxDirectories: 2_000, timeoutMs: 1_500 },
    (relativePath) => {
      const lower = relativePath.toLowerCase();
      // ponytail: o walk ainda desce em dist/out (custa orçamento); só o
      // resultado é filtrado. Subir o filtro para o walk se virar gargalo.
      return (
        !relativePath.split('/').some((segment) => IGNORED.has(segment)) &&
        terms.every((term) => lower.includes(term))
      );
    },
  );
  return { ok: true, files: result.files, truncated: result.truncated };
}

export function registerFilesIpc(hooks: FilesIpcTestHooks = {}): void {
  ipcMain.handle(FILES_CHANNELS.saveDropped, (event, raw) => {
    requireRendererWorkspaceScope(event.sender);
    if (
      !raw ||
      typeof raw.name !== 'string' ||
      raw.name.length > 512 ||
      typeof raw.base64 !== 'string' ||
      raw.base64.length > DROPPED_ATTACHMENT_MAX_BASE64_CHARS
    ) {
      return { ok: false, error: 'invalid payload' };
    }
    return saveDroppedFile(raw.name, raw.base64);
  });

  ipcMain.handle(FILES_CHANNELS.importMissionAttachment, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    if (
      !raw ||
      typeof raw.name !== 'string' ||
      raw.name.length > 512 ||
      typeof raw.base64 !== 'string' ||
      raw.base64.length > DROPPED_ATTACHMENT_MAX_BASE64_CHARS
    ) {
      return { ok: false, error: 'invalid payload' };
    }
    return importWorkspaceMissionAttachment(
      scope.rootRealPath,
      raw.name,
      raw.base64,
    ).then((result) => {
      if (!result.ok) {
        // F-582: o motivo sai no log do Main (nunca bytes/base64) — sem isto a
        // recusa virava o toast genérico do renderer e a causa sumia.
        console.warn(
          '[files] mission attachment import failed:',
          result.error,
        );
      }
      return result;
    });
  });

  // Drop sem `File`: o renderer só tem o endereço (`file://` ou http(s)).
  // O scope é exigido de forma síncrona para falhar fechado como os vizinhos.
  ipcMain.handle(FILES_CHANNELS.importDroppedUri, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = importDroppedUriSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid payload' };
    return Promise.resolve(
      importDroppedUri(scope.rootRealPath, parsed.data.uri),
    ).then((result) => {
      if (!result.ok) {
        console.warn(
          '[files] mission attachment import failed:',
          result.error,
        );
      }
      return result;
    });
  });

  // Paste sem `File` materializado: Finder/Explorer só põe referências de
  // arquivo no pasteboard do sistema (public.file-url / FileNameW). O Main
  // devolve só os endereços file:// — nunca conteúdo (F-582).
  ipcMain.handle(FILES_CHANNELS.clipboardFileUris, (event) => {
    requireRendererWorkspaceScope(event.sender);
    return { uris: readClipboardFileUris() };
  });

  // HEIC/HEIF → JPEG com o decoder do sistema. Só bytes entram e saem; o
  // Main valida tamanho e pixels antes do processo filho (heic-convert.ts).
  ipcMain.handle(FILES_CHANNELS.convertHeicToJpeg, (event, raw) => {
    requireRendererWorkspaceScope(event.sender);
    const bytes = heicConvertPayloadBytes(raw);
    if (!bytes) {
      return { ok: false, reason: 'unreadable', error: 'Conteúdo HEIC inválido.' };
    }
    return convertHeicToJpeg(bytes).then((result) => {
      if (!result.ok) {
        console.warn('[files] HEIC conversion failed:', result.reason);
      }
      return result;
    });
  });

  ipcMain.handle(FILES_CHANNELS.list, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = listDirSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid path' };
    return listDir(scope, parsed.data.relPath);
  });

  ipcMain.handle(FILES_CHANNELS.read, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = readFileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid path' };
    return readFile(scope, parsed.data.relPath, hooks);
  });

  ipcMain.handle(FILES_CHANNELS.search, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = searchFilesSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid query' };
    return searchFiles(scope, parsed.data.query).catch(() => ({
      ok: false,
      error: 'search failed',
    }));
  });

  ipcMain.handle(FILES_CHANNELS.write, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = writeFileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid payload' };
    return writeFile(scope, parsed.data.relPath, parsed.data.content, hooks);
  });
}
