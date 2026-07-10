import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  isInsidePath,
  resolvePathCandidateForScope,
  resolveRootForScope,
} from './workspace-path';

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = fs.constants.O_RDONLY | NO_FOLLOW;
const MUTATE_FLAGS = fs.constants.O_RDWR | NO_FOLLOW;
const CREATE_FLAGS =
  fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW;

export interface WorkspaceFileHandle {
  absolutePath: string;
  fd: number;
  stat: fs.Stats;
  close(): void;
}

interface WorkspaceTextUpdate<T> {
  content: string;
  result: T;
}

interface OpenedFile {
  absolutePath: string;
  fd: number;
  stat: fs.Stats;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function relativeLabel(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath) || '.';
}

function assertDirectory(root: string, absolutePath: string): void {
  const label = relativeLabel(root, absolutePath);
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`symbolic link is not allowed in workspace path: ${label}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`path component is not a directory: ${label}`);
  }
  const real = fs.realpathSync(absolutePath);
  if (!isInsidePath(root, real)) {
    throw new Error(`path escapes workspace: ${label}`);
  }
}

function inspectPathComponents(
  root: string,
  absolutePath: string,
): { exists: boolean; missingIndex: number } {
  const relative = path.relative(root, absolutePath);
  const parts = relative === '' ? [] : relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { exists: false, missingIndex: index };
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `symbolic link is not allowed in workspace path: ${relativeLabel(root, current)}`,
      );
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(
        `path component is not a directory: ${relativeLabel(root, current)}`,
      );
    }
  }
  return { exists: true, missingIndex: parts.length };
}

function ensureParentDirectories(root: string, absolutePath: string): void {
  const parent = path.dirname(absolutePath);
  const relative = path.relative(root, parent);
  const parts = relative === '' ? [] : relative.split(path.sep).filter(Boolean);
  let current = root;
  assertDirectory(root, current);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      assertDirectory(root, current);
      continue;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    assertDirectory(root, current);
  }
}

/**
 * Create a directory inside the bound workspace without following symlinks in
 * any existing path component. This is intentionally narrower than
 * `mkdir({ recursive: true })`, which cannot bind validation to the scoped
 * workspace one component at a time.
 */
export function ensureWorkspaceDirectory(
  scope: ProjectExecutionScope,
  relativePath: string,
): { created: boolean } {
  const root = resolveRootForScope(scope);
  const absolutePath = resolvePathCandidateForScope(scope, relativePath);
  if (absolutePath === root) return { created: false };

  const inspected = inspectPathComponents(root, absolutePath);
  if (inspected.exists) {
    assertDirectory(root, absolutePath);
    return { created: false };
  }

  ensureParentDirectories(root, path.join(absolutePath, '.nexus-directory-probe'));
  assertDirectory(root, absolutePath);
  return { created: true };
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertDescriptor(
  scope: ProjectExecutionScope,
  absolutePath: string,
  fd: number,
): fs.Stats {
  const root = resolveRootForScope(scope);
  const descriptorStat = fs.fstatSync(fd);
  const label = relativeLabel(root, absolutePath);
  if (!descriptorStat.isFile()) {
    throw new Error(`workspace path is not a regular file: ${label}`);
  }
  if (descriptorStat.nlink !== 1) {
    throw new Error(`workspace file must not be a hardlink: ${label}`);
  }

  const pathStat = fs.lstatSync(absolutePath);
  if (pathStat.isSymbolicLink()) {
    throw new Error(`symbolic link is not allowed in workspace path: ${label}`);
  }
  if (!pathStat.isFile()) {
    throw new Error(`workspace path is not a regular file: ${label}`);
  }
  const real = fs.realpathSync(absolutePath);
  if (!isInsidePath(root, real)) {
    throw new Error(`path escapes workspace: ${label}`);
  }
  if (!sameInode(descriptorStat, pathStat)) {
    throw new Error(`workspace file changed while it was being opened: ${label}`);
  }
  return descriptorStat;
}

function openError(error: unknown, relativePath: string): never {
  if (errorCode(error) === 'ELOOP') {
    throw new Error(`symbolic link is not allowed in workspace path: ${relativePath}`);
  }
  throw error;
}

function openExisting(
  scope: ProjectExecutionScope,
  relativePath: string,
  mutable: boolean,
): OpenedFile {
  const root = resolveRootForScope(scope);
  const absolutePath = resolvePathCandidateForScope(scope, relativePath);
  const inspected = inspectPathComponents(root, absolutePath);
  if (!inspected.exists) throw new Error(`file not found: ${relativePath}`);
  const beforeOpen = fs.lstatSync(absolutePath);
  if (beforeOpen.isSymbolicLink()) {
    throw new Error(`symbolic link is not allowed in workspace path: ${relativePath}`);
  }
  if (!beforeOpen.isFile()) {
    throw new Error(`workspace path is not a regular file: ${relativePath}`);
  }

  let fd: number;
  try {
    fd = fs.openSync(absolutePath, mutable ? MUTATE_FLAGS : READ_FLAGS);
  } catch (error) {
    openError(error, relativePath);
  }
  try {
    const stat = assertDescriptor(scope, absolutePath, fd);
    if (!sameInode(beforeOpen, stat)) {
      throw new Error(
        `workspace file changed while it was being opened: ${relativePath}`,
      );
    }
    return { absolutePath, fd, stat };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function handleFor(opened: OpenedFile): WorkspaceFileHandle {
  let isClosed = false;
  return {
    ...opened,
    close() {
      if (isClosed) return;
      isClosed = true;
      fs.closeSync(opened.fd);
    },
  };
}

export function openWorkspaceFileForRead(
  scope: ProjectExecutionScope,
  relativePath: string,
): WorkspaceFileHandle {
  return handleFor(openExisting(scope, relativePath, false));
}

export function readWorkspaceTextFile(
  scope: ProjectExecutionScope,
  relativePath: string,
  encoding: BufferEncoding = 'utf8',
): { content: string; size: number } {
  const handle = openWorkspaceFileForRead(scope, relativePath);
  try {
    return {
      content: fs.readFileSync(handle.fd, { encoding }),
      size: handle.stat.size,
    };
  } finally {
    handle.close();
  }
}

function writeAll(fd: number, content: string, encoding: BufferEncoding): number {
  const buffer = Buffer.from(content, encoding);
  fs.ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = fs.writeSync(
      fd,
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (written <= 0) throw new Error('workspace file write made no progress');
    offset += written;
  }
  fs.fsyncSync(fd);
  return buffer.byteLength;
}

function replaceOpenedContents(
  scope: ProjectExecutionScope,
  opened: OpenedFile,
  content: string,
  encoding: BufferEncoding,
): number {
  assertDescriptor(scope, opened.absolutePath, opened.fd);
  return writeAll(opened.fd, content, encoding);
}

function unlinkCreatedFileIfOwned(absolutePath: string, fd: number): void {
  try {
    const descriptorStat = fs.fstatSync(fd);
    const pathStat = fs.lstatSync(absolutePath);
    if (!pathStat.isSymbolicLink() && sameInode(descriptorStat, pathStat)) {
      fs.unlinkSync(absolutePath);
    }
  } catch {
    // Cleanup is best-effort; never risk unlinking a path whose identity changed.
  }
}

function createNew(
  scope: ProjectExecutionScope,
  relativePath: string,
): OpenedFile {
  const root = resolveRootForScope(scope);
  const absolutePath = resolvePathCandidateForScope(scope, relativePath);
  ensureParentDirectories(root, absolutePath);
  inspectPathComponents(root, path.dirname(absolutePath));

  let fd: number;
  try {
    fd = fs.openSync(absolutePath, CREATE_FLAGS, 0o666);
  } catch (error) {
    openError(error, relativePath);
  }
  try {
    const stat = assertDescriptor(scope, absolutePath, fd);
    return { absolutePath, fd, stat };
  } catch (error) {
    unlinkCreatedFileIfOwned(absolutePath, fd);
    fs.closeSync(fd);
    throw error;
  }
}

export function writeWorkspaceTextFile(
  scope: ProjectExecutionScope,
  relativePath: string,
  content: string,
  encoding: BufferEncoding = 'utf8',
): { existed: boolean; written: number } {
  const root = resolveRootForScope(scope);
  const absolutePath = resolvePathCandidateForScope(scope, relativePath);
  const inspected = inspectPathComponents(root, absolutePath);
  let opened: OpenedFile;
  let existed = inspected.exists;

  if (existed) {
    opened = openExisting(scope, relativePath, true);
  } else {
    try {
      opened = createNew(scope, relativePath);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      existed = true;
      opened = openExisting(scope, relativePath, true);
    }
  }

  try {
    return {
      existed,
      written: replaceOpenedContents(scope, opened, content, encoding),
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Durable same-directory replacement for small authority/configuration files.
 * The fully written temporary inode is descriptor-validated before one atomic
 * rename makes it visible at the scoped path.
 */
export function replaceWorkspaceTextFileAtomically(
  scope: ProjectExecutionScope,
  relativePath: string,
  content: string,
  encoding: BufferEncoding = 'utf8',
): { existed: boolean; written: number } {
  const root = resolveRootForScope(scope);
  const absolutePath = resolvePathCandidateForScope(scope, relativePath);
  ensureParentDirectories(root, absolutePath);
  const inspected = inspectPathComponents(root, absolutePath);
  const existed = inspected.exists;
  let priorStat: fs.Stats | undefined;
  if (existed) {
    const prior = openExisting(scope, relativePath, false);
    priorStat = prior.stat;
    fs.closeSync(prior.fd);
  }

  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.nexus-tmp-${randomUUID()}`,
  );
  let fd = -1;
  let isRenamed = false;
  try {
    fd = fs.openSync(temporaryPath, CREATE_FLAGS, 0o600);
    assertDescriptor(scope, temporaryPath, fd);
    const written = writeAll(fd, content, encoding);
    assertDescriptor(scope, temporaryPath, fd);

    const current = inspectPathComponents(root, absolutePath);
    if (existed) {
      if (!current.exists || !priorStat) {
        throw new Error(`workspace file changed before atomic replacement: ${relativePath}`);
      }
      const currentStat = fs.lstatSync(absolutePath);
      if (currentStat.isSymbolicLink() || !sameInode(priorStat, currentStat)) {
        throw new Error(`workspace file changed before atomic replacement: ${relativePath}`);
      }
    } else if (current.exists) {
      throw new Error(`workspace file appeared before atomic creation: ${relativePath}`);
    }

    fs.renameSync(temporaryPath, absolutePath);
    isRenamed = true;
    assertDescriptor(scope, absolutePath, fd);
    fsyncDirectory(path.dirname(absolutePath));
    fs.closeSync(fd);
    fd = -1;
    return { existed, written };
  } catch (error) {
    if (fd >= 0) {
      if (!isRenamed) unlinkCreatedFileIfOwned(temporaryPath, fd);
      fs.closeSync(fd);
    } else {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Best effort cleanup of our unlinked temporary name.
      }
    }
    throw error;
  }
}

export interface RemoveWorkspaceFileOptions {
  readonly expectedSha256?: string;
  readonly missingOk?: boolean;
}

export function removeWorkspaceFile(
  scope: ProjectExecutionScope,
  relativePath: string,
  options: RemoveWorkspaceFileOptions = {},
): boolean {
  const root = resolveRootForScope(scope);
  const absolutePath = resolvePathCandidateForScope(scope, relativePath);
  const inspected = inspectPathComponents(root, absolutePath);
  if (!inspected.exists) {
    if (options.missingOk) return false;
    throw new Error(`file not found: ${relativePath}`);
  }
  if (options.expectedSha256 && !/^[a-f0-9]{64}$/.test(options.expectedSha256)) {
    throw new Error('expected workspace file hash is invalid');
  }
  const opened = openExisting(scope, relativePath, false);
  let isClosed = false;
  try {
    if (options.expectedSha256) {
      const actual = createHash('sha256')
        .update(fs.readFileSync(opened.fd))
        .digest('hex');
      if (actual !== options.expectedSha256) {
        throw new Error(`workspace file hash changed before removal: ${relativePath}`);
      }
    }
    assertDescriptor(scope, absolutePath, opened.fd);
    if (process.platform === 'win32') {
      fs.closeSync(opened.fd);
      isClosed = true;
      const current = fs.lstatSync(absolutePath);
      if (current.isSymbolicLink() || !sameInode(opened.stat, current)) {
        throw new Error(`workspace file changed before removal: ${relativePath}`);
      }
    }
    fs.unlinkSync(absolutePath);
    fsyncDirectory(path.dirname(absolutePath));
    return true;
  } finally {
    if (!isClosed) fs.closeSync(opened.fd);
  }
}

export function updateWorkspaceTextFile<T>(
  scope: ProjectExecutionScope,
  relativePath: string,
  update: (current: string) => WorkspaceTextUpdate<T>,
  encoding: BufferEncoding = 'utf8',
): T {
  const opened = openExisting(scope, relativePath, true);
  try {
    const current = fs.readFileSync(opened.fd, { encoding });
    const next = update(current);
    replaceOpenedContents(scope, opened, next.content, encoding);
    return next.result;
  } finally {
    fs.closeSync(opened.fd);
  }
}
