// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// (src/main/worktree-removal-safety.ts)
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: ORCA WorktreeMeta
// provenance replaced by WorktreeRecord-based Nexus provenance (records are
// main-owned via WorktreeStateStore CAS, so there is no legacy-evidence branch
// and no meta-update surface to sanitize); GitWorktreeInfo replaced by local
// RegisteredWorktreeInfo; Repo replaced by plain repo path; statement style.

import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path';
import type { WorktreeRecord } from './worktree-contract';
import { areWorktreePathsEqual } from './worktree-path-compare';
import {
  gitFileProvesOrphanedWorktreeDirectory,
  type ReadPath,
  type StatPath,
} from './worktree-orphan-gitdir-proof';

type PathOps = typeof posix;

/** Registered git worktree as reported by `git worktree list`. */
export interface RegisteredWorktreeInfo {
  readonly path: string;
  readonly isMainWorktree: boolean;
}

/**
 * Persisted Nexus creation provenance for a worktree directory. Only a durable
 * WorktreeRecord written by the runtime proves Nexus created the directory;
 * path shape is never authority.
 */
export type NexusWorktreeProvenance = Pick<
  WorktreeRecord,
  'createdAt' | 'missionId' | 'taskId' | 'workerId'
>;

export const ORPHANED_WORKTREE_DIRECTORY_MESSAGE =
  'Worktree is no longer registered with Git but its directory remains.';
export const UNREGISTERED_MISSING_WORKTREE_MESSAGE =
  'Worktree is no longer registered with Git and its directory is already gone.';

function getPathOps(...paths: string[]): PathOps {
  // Why: forward-slash UNC roots need win32 ops; POSIX joins collapse `//Server` to `/Server`.
  return paths.some(isWindowsAbsolutePathLike) ? win32 : posix;
}

function containsPath(parentPath: string, childPath: string, pathOps: PathOps): boolean {
  const relativePath = pathOps.relative(parentPath, childPath);
  // Why: `..name` is a valid child name; only `..` and `../...` escape.
  return (
    relativePath === '' ||
    (!!relativePath &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${pathOps.sep}`) &&
      !pathOps.isAbsolute(relativePath))
  );
}

export function isDangerousWorktreeRemovalPath(worktreePath: string, repoPath: string): boolean {
  if (!worktreePath.trim()) {
    return true;
  }

  if (areWorktreePathsEqual(worktreePath, repoPath)) {
    return true;
  }

  const pathOps = getPathOps(worktreePath, repoPath);
  const resolvedWorktreePath = pathOps.resolve(worktreePath);
  const rootPath = pathOps.parse(resolvedWorktreePath).root;
  if (resolvedWorktreePath === rootPath) {
    return true;
  }

  const resolvedRepoPath = pathOps.resolve(repoPath);
  if (containsPath(resolvedWorktreePath, resolvedRepoPath, pathOps)) {
    return true;
  }

  const homePath = homedir();
  if (!!homePath && containsPath(resolvedWorktreePath, pathOps.resolve(homePath), pathOps)) {
    return true;
  }

  return isLikelyPosixHomeDirectory(resolvedWorktreePath, pathOps);
}

function isLikelyPosixHomeDirectory(resolvedWorktreePath: string, pathOps: PathOps): boolean {
  if (pathOps !== posix) {
    return false;
  }
  return (
    resolvedWorktreePath === '/home' ||
    resolvedWorktreePath === '/root' ||
    /^\/home\/[^/]+$/.test(resolvedWorktreePath) ||
    /^\/Users\/[^/]+$/.test(resolvedWorktreePath)
  );
}

export function getRegisteredDeletableWorktree(
  repoPath: string,
  requestedWorktreePath: string,
  worktrees: readonly RegisteredWorktreeInfo[],
): RegisteredWorktreeInfo {
  const worktree = findRegisteredDeletableWorktree(repoPath, requestedWorktreePath, worktrees);
  if (!worktree) {
    throw new Error(`Refusing to delete unregistered worktree path: ${requestedWorktreePath}`);
  }
  return worktree;
}

export function findRegisteredDeletableWorktree(
  repoPath: string,
  requestedWorktreePath: string,
  worktrees: readonly RegisteredWorktreeInfo[],
): RegisteredWorktreeInfo | null {
  const worktree = worktrees.find((item) => areWorktreePathsEqual(item.path, requestedWorktreePath));
  if (!worktree) {
    return null;
  }
  if (worktree.isMainWorktree || isDangerousWorktreeRemovalPath(worktree.path, repoPath)) {
    throw new Error(`Refusing to delete protected worktree path: ${worktree.path}`);
  }
  assertWorktreeDoesNotContainRegisteredWorktree(worktree.path, worktrees);
  return worktree;
}

export function assertWorktreeDoesNotContainRegisteredWorktree(
  worktreePath: string,
  worktrees: readonly RegisteredWorktreeInfo[],
): void {
  const nestedWorktree = worktrees.find((item) => {
    if (areWorktreePathsEqual(item.path, worktreePath)) {
      return false;
    }
    return containsPath(worktreePath, item.path, getPathOps(worktreePath, item.path));
  });
  if (nestedWorktree) {
    // Why: `git worktree remove --force` treats nested worktrees as ordinary
    // untracked directories and deletes their working files while leaving Git
    // with a prunable child worktree record.
    throw new Error(
      `Refusing to delete worktree because it contains another registered worktree: ${nestedWorktree.path}`,
    );
  }
}

export async function canSafelyRemoveOrphanedWorktreeDirectory(
  worktreePath: string,
  repoPath: string,
  statPath: StatPath = lstat,
  readPath: ReadPath = (path) => readFile(path, 'utf8'),
): Promise<boolean> {
  if (isDangerousWorktreeRemovalPath(worktreePath, repoPath)) {
    return false;
  }

  const pathOps = getPathOps(worktreePath, repoPath);
  const gitFilePath = pathOps.join(worktreePath, '.git');
  return gitFileProvesOrphanedWorktreeDirectory({
    gitFilePath,
    worktreePath,
    repoPath,
    pathOps,
    statPath,
    readPath,
  });
}

export function canCleanupUnregisteredNexusWorktreeDirectory(args: {
  record: NexusWorktreeProvenance | null | undefined;
}): boolean {
  // Why: path shape alone is not authority; users can create plain Git
  // worktrees inside Nexus workspace directories too.
  return hasNexusCreationProvenance(args.record);
}

export async function canCleanupUnregisteredNexusLeftoverDirectory(args: {
  record: NexusWorktreeProvenance | null | undefined;
  worktreePath: string;
  runtimeWorktreePath: string;
  repoPath: string;
  runtimeRepoPath: string;
  registeredWorktrees: readonly RegisteredWorktreeInfo[];
  statPath: StatPath;
  isGitRepository: (runtimeWorktreePath: string) => Promise<boolean>;
}): Promise<boolean> {
  // Why: this recovery state has already lost the worktree .git marker, so the
  // existing .git-file orphan proof cannot establish ownership. Without a
  // surviving .git file, path shape alone is too weak to prove ownership for
  // recursive deletion; require persisted Nexus-created evidence.
  if (!hasNexusCreationProvenance(args.record)) {
    return false;
  }

  if (
    isDangerousWorktreeRemovalPath(args.worktreePath, args.repoPath) ||
    isDangerousWorktreeRemovalPath(args.runtimeWorktreePath, args.runtimeRepoPath)
  ) {
    return false;
  }

  assertWorktreeDoesNotContainRegisteredWorktree(args.worktreePath, args.registeredWorktrees);

  const targetEntry = await args.statPath(args.runtimeWorktreePath).catch(() => null);
  if (!isDirectoryStat(targetEntry)) {
    return false;
  }

  const pathOps = getPathOps(args.runtimeWorktreePath, args.runtimeRepoPath);
  const gitMarkerPath = pathOps.join(args.runtimeWorktreePath, '.git');
  try {
    await args.statPath(gitMarkerPath);
    return false;
  } catch (error) {
    if (!isMissingPathError(error)) {
      return false;
    }
  }

  return !(await args.isGitRepository(args.runtimeWorktreePath));
}

function hasNexusCreationProvenance(
  record: NexusWorktreeProvenance | null | undefined,
): boolean {
  return (
    typeof record?.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    record.createdAt > 0 &&
    !!record.missionId &&
    !!record.taskId &&
    !!record.workerId
  );
}

function isMissingPathError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true;
  }

  let message = '';
  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === 'object' && 'message' in error) {
    message = String((error as { message: unknown }).message);
  } else if (typeof error === 'string') {
    message = error;
  }
  return /\b(ENOENT|ENOTDIR)\b|no such file or directory|cannot find (?:the )?(?:file|path)|(?:file|path) not found/i.test(
    message,
  );
}

function isDirectoryStat(stat: unknown): boolean {
  const entry =
    stat && typeof stat === 'object'
      ? (stat as { isDirectory?: () => boolean; isSymbolicLink?: () => boolean; type?: unknown })
      : null;
  if (!entry) {
    return false;
  }
  if (entry.isSymbolicLink?.() === true || entry.type === 'symlink') {
    return false;
  }
  return entry.isDirectory?.() === true || entry.type === 'directory';
}

export async function isWorktreePathMissing(
  worktreePath: string,
  statPath: (path: string) => Promise<unknown> = lstat,
): Promise<boolean> {
  try {
    await statPath(worktreePath);
    return false;
  } catch (error) {
    return isMissingPathError(error);
  }
}
