import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import {
  FILES_CHANNELS,
  listDirSchema,
  readFileSchema,
  writeFileSchema,
  type FileNode,
  type FileTreeResult,
  type ReadFileResult,
} from '../../shared/files-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { requireRendererWorkspaceScope } from './renderer-workspace-scope';

/**
 * File explorer backend — sandboxed to the invoking renderer's main-owned
 * workspace scope. Every relPath is resolved against its canonical root and
 * rejected if it escapes it, including through symlinks.
 */

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

function canonicalScopeRoot(
  scope: ProjectExecutionScope,
): DirectorySnapshot | null {
  const authorizedRoot = path.resolve(scope.rootRealPath);
  try {
    const rootStat = fs.lstatSync(authorizedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const realRoot = fs.realpathSync(authorizedRoot);
    if (path.relative(authorizedRoot, realRoot) !== '') return null;
    return { abs: realRoot, identity: identityOf(rootStat) };
  } catch {
    return null;
  }
}

function canonicalDirectory(
  root: DirectorySnapshot,
  requestedPath: string,
): DirectorySnapshot | null {
  try {
    const realPath = fs.realpathSync(requestedPath);
    if (
      path.relative(requestedPath, realPath) !== '' ||
      !isInsideRoot(root.abs, realPath)
    ) {
      return null;
    }
    const stat = fs.lstatSync(requestedPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return { abs: realPath, identity: identityOf(stat) };
  } catch {
    return null;
  }
}

function resolveLexicalPath(
  scope: ProjectExecutionScope,
  relPath: string,
): { root: DirectorySnapshot; abs: string } | null {
  const root = canonicalScopeRoot(scope);
  if (!root) return null;
  const abs = path.resolve(root.abs, relPath);
  if (!isInsideRoot(root.abs, abs)) return null;
  return { root, abs };
}

function isSafeRegularFile(stat: fs.Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isBoundaryCurrent(
  scope: ProjectExecutionScope,
  rootBefore: DirectorySnapshot,
  parentBefore: DirectorySnapshot,
  file: string,
): boolean {
  const root = canonicalScopeRoot(scope);
  if (!sameDirectory(root, rootBefore)) return false;
  const parent = root ? canonicalDirectory(root, path.dirname(file)) : null;
  return sameDirectory(parent, parentBefore);
}

function isListedDirectoryCurrent(
  scope: ProjectExecutionScope,
  rootBefore: DirectorySnapshot,
  directoryBefore: DirectorySnapshot,
): boolean {
  const root = canonicalScopeRoot(scope);
  if (!sameDirectory(root, rootBefore)) return false;
  const directory = root
    ? canonicalDirectory(root, directoryBefore.abs)
    : null;
  return sameDirectory(directory, directoryBefore);
}

function validateOpenedFile(
  scope: ProjectExecutionScope,
  rootBefore: DirectorySnapshot,
  parentBefore: DirectorySnapshot,
  file: string,
  fd: number,
  expectedBefore: fs.Stats | null,
): fs.Stats | null {
  const opened = fs.fstatSync(fd);
  if (!isSafeRegularFile(opened)) return null;
  if (expectedBefore && !hasIdentity(opened, identityOf(expectedBefore))) {
    return null;
  }

  if (!isBoundaryCurrent(scope, rootBefore, parentBefore, file)) return null;
  const current = lstatOrNull(file);
  if (!current || !isSafeRegularFile(current)) return null;
  if (!hasIdentity(current, identityOf(opened))) return null;
  return opened;
}

function safeListEntry(
  root: DirectorySnapshot,
  directory: string,
  name: string,
  relPath: string,
): FileNode | null {
  if (IGNORED.has(name)) return null;
  try {
    const entryPath = path.join(directory, name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) {
      if (!canonicalDirectory(root, entryPath)) return null;
      return { name, relPath, kind: 'dir' };
    }
    if (!isSafeRegularFile(stat)) return null;
    const realPath = fs.realpathSync(entryPath);
    if (path.relative(entryPath, realPath) !== '') return null;
    if (!isInsideRoot(root.abs, realPath)) return null;
    return { name, relPath, kind: 'file' };
  } catch {
    return null;
  }
}

function listDir(scope: ProjectExecutionScope, relPath: string): FileTreeResult {
  const resolved = resolveLexicalPath(scope, relPath);
  if (!resolved) return { ok: false, error: 'path outside workspace' };
  const directory = canonicalDirectory(resolved.root, resolved.abs);
  if (!directory) return { ok: false, error: 'path outside workspace' };
  try {
    const dirents = fs.readdirSync(directory.abs, { withFileTypes: true });
    if (!isListedDirectoryCurrent(scope, resolved.root, directory)) {
      return { ok: false, error: 'unsafe directory' };
    }
    const entries: FileNode[] = dirents
      .map((dirent) =>
        safeListEntry(
          resolved.root,
          directory.abs,
          dirent.name,
          path.posix.join(
            relPath.split(path.sep).join('/'),
            dirent.name,
          ),
        ),
      )
      .filter((entry): entry is FileNode => entry !== null)
      // Directories first, then alphabetical.
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    if (!isListedDirectoryCurrent(scope, resolved.root, directory)) {
      return { ok: false, error: 'unsafe directory' };
    }
    return { ok: true, entries };
  } catch {
    return { ok: false, error: 'list failed' };
  }
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  for (const byte of sample) {
    if (byte === 0) return true; // NUL byte → binary.
  }
  return false;
}

function readFile(
  scope: ProjectExecutionScope,
  relPath: string,
  hooks: FilesIpcTestHooks,
): ReadFileResult {
  const resolved = resolveLexicalPath(scope, relPath);
  if (!resolved) return { ok: false, error: 'path outside workspace' };
  const parent = canonicalDirectory(resolved.root, path.dirname(resolved.abs));
  if (!parent) return { ok: false, error: 'path outside workspace' };
  let fd: number | null = null;
  try {
    const before = fs.lstatSync(resolved.abs);
    if (before.isSymbolicLink()) {
      return { ok: false, error: 'path outside workspace' };
    }
    if (before.isDirectory()) return { ok: false, error: 'is a directory' };
    if (!isSafeRegularFile(before)) return { ok: false, error: 'unsafe file' };
    if (!isBoundaryCurrent(scope, resolved.root, parent, resolved.abs)) {
      return { ok: false, error: 'unsafe file' };
    }
    hooks.beforeOpen?.('read');
    fd = fs.openSync(resolved.abs, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
    const opened = validateOpenedFile(
      scope,
      resolved.root,
      parent,
      resolved.abs,
      fd,
      before,
    );
    if (!opened) return { ok: false, error: 'unsafe file' };
    if (opened.size > MAX_READ_BYTES) return { ok: true, tooLarge: true };
    const buffer = fs.readFileSync(fd);
    if (looksBinary(buffer)) return { ok: true, binary: true };
    return { ok: true, content: buffer.toString('utf8') };
  } catch {
    return { ok: false, error: 'unsafe file' };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function writeFile(
  scope: ProjectExecutionScope,
  relPath: string,
  content: string,
  hooks: FilesIpcTestHooks,
): { ok: boolean; error?: string } {
  const resolved = resolveLexicalPath(scope, relPath);
  if (!resolved) return { ok: false, error: 'path outside workspace' };
  const parent = canonicalDirectory(resolved.root, path.dirname(resolved.abs));
  if (!parent) return { ok: false, error: 'path outside workspace' };
  let fd: number | null = null;
  let created = false;
  let completed = false;
  try {
    const before = lstatOrNull(resolved.abs);
    if (before?.isSymbolicLink()) {
      return { ok: false, error: 'path outside workspace' };
    }
    if (before?.isDirectory()) return { ok: false, error: 'is a directory' };
    if (before && !isSafeRegularFile(before)) {
      return { ok: false, error: 'unsafe file' };
    }
    if (!isBoundaryCurrent(scope, resolved.root, parent, resolved.abs)) {
      return { ok: false, error: 'unsafe file' };
    }
    hooks.beforeOpen?.('write');
    const flags = before
      ? fs.constants.O_WRONLY | NOFOLLOW_FLAG
      : fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        NOFOLLOW_FLAG;
    fd = fs.openSync(resolved.abs, flags, PRIVATE_FILE_MODE);
    created = before === null;
    const opened = validateOpenedFile(
      scope,
      resolved.root,
      parent,
      resolved.abs,
      fd,
      before,
    );
    if (!opened) return { ok: false, error: 'unsafe file' };
    if (!isSafeRegularFile(fs.fstatSync(fd))) {
      return { ok: false, error: 'unsafe file' };
    }
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    completed = true;
    return { ok: true };
  } catch {
    return { ok: false, error: 'unsafe file' };
  } finally {
    if (fd !== null) {
      const opened = fs.fstatSync(fd);
      if (created && !completed) {
        try {
          const current = fs.lstatSync(resolved.abs);
          if (hasIdentity(current, identityOf(opened))) {
            fs.unlinkSync(resolved.abs);
          }
        } catch {
          // The safely-created file was already removed or moved.
        }
      }
      fs.closeSync(fd);
    }
  }
}

/**
 * Save pasted/dropped binary data (e.g. an image from the clipboard) into
 * ~/.nexus/dropped and return its absolute path, so it can be injected into a
 * pane's terminal.
 */
function saveDropped(
  name: string,
  base64: string,
): { ok: boolean; path?: string; error?: string } {
  try {
    const dir = path.join(os.homedir(), '.nexus', 'dropped');
    fs.mkdirSync(dir, { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'pasted';
    const stamped = `${Date.now().toString(36)}-${safeName}`;
    const file = path.join(dir, stamped);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'save failed' };
  }
}

export function registerFilesIpc(hooks: FilesIpcTestHooks = {}): void {
  ipcMain.handle(FILES_CHANNELS.saveDropped, (event, raw) => {
    requireRendererWorkspaceScope(event.sender);
    if (
      !raw ||
      typeof raw.name !== 'string' ||
      typeof raw.base64 !== 'string' ||
      raw.base64.length > 20_000_000
    ) {
      return { ok: false, error: 'invalid payload' };
    }
    return saveDropped(raw.name, raw.base64);
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

  ipcMain.handle(FILES_CHANNELS.write, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = writeFileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid payload' };
    return writeFile(scope, parsed.data.relPath, parsed.data.content, hooks);
  });
}
