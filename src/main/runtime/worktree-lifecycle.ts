import {
  ProcessGitRunner,
  type GitRunner,
} from './git-command';
import { readWorktreeMetadata } from './worktree-metadata';

export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set([
  'main',
  'master',
  'develop',
  'dev',
  'trunk',
]);

export interface WorktreeStatusCheck {
  readonly isClean: boolean;
  readonly dirtyFiles: readonly string[];
}

export class WorktreeDirtyStateError extends Error {
  readonly dirtyFiles: readonly string[];
  constructor(worktreePath: string, dirtyFiles: readonly string[]) {
    super(
      `worktree at "${worktreePath}" contains uncommitted or untracked changes: ${dirtyFiles.join(', ')}`,
    );
    this.name = 'WorktreeDirtyStateError';
    this.dirtyFiles = Object.freeze([...dirtyFiles]);
  }
}

/**
 * Check if an isolated worktree is completely clean and safe for archiving/removal.
 */
export function checkWorktreeStatus(
  worktreePath: string,
  runner: GitRunner = new ProcessGitRunner(),
): WorktreeStatusCheck {
  try {
    const result = runner.run(
      worktreePath,
      ['status', '--porcelain', '-uall'],
      { allowFailure: false },
    );

    const lines = result.stdout
      .split('\n')
      .filter((l) => l.length >= 3);

    if (lines.length === 0) {
      return Object.freeze({ isClean: true, dirtyFiles: Object.freeze([]) });
    }

    const files = lines.map((line) => {
      // porcelain status format: "XY <path>" where X and Y are 1 char each (can be space)
      return line.slice(3).trim();
    });

    return Object.freeze({
      isClean: false,
      dirtyFiles: Object.freeze(files),
    });
  } catch {
    // If git status fails (e.g. directory already gone or invalid), consider clean to allow prune
    return Object.freeze({ isClean: true, dirtyFiles: Object.freeze([]) });
  }
}

export interface ArchiveWorktreeOptions {
  readonly mainRepoPath: string;
  readonly worktreePath: string;
  readonly branchName?: string;
  readonly deleteBranch?: boolean;
  readonly force?: boolean;
}

export interface ArchiveWorktreeResult {
  readonly ok: boolean;
  readonly worktreePath: string;
  readonly branchDeleted?: boolean;
}

/**
 * Safely removes a worktree and prunes dead worktree registrations.
 * Refuses to delete if dirty unless `force: true` is explicitly passed.
 */
export function archiveWorktree(
  options: ArchiveWorktreeOptions,
  runner: GitRunner = new ProcessGitRunner(),
): ArchiveWorktreeResult {
  const meta = readWorktreeMetadata(options.worktreePath);
  const branchName = options.branchName ?? meta?.branchName;

  // 1. Safety check
  const status = checkWorktreeStatus(options.worktreePath, runner);
  if (!status.isClean && !options.force) {
    throw new WorktreeDirtyStateError(options.worktreePath, status.dirtyFiles);
  }

  // 2. Remove worktree from main repo root
  const removeArgs = ['worktree', 'remove'];
  if (options.force) {
    removeArgs.push('--force');
  }
  removeArgs.push(options.worktreePath);

  try {
    runner.run(options.mainRepoPath, removeArgs, { allowFailure: false });
  } catch (err) {
    // If removal failed because the worktree directory is already deleted/missing,
    // continue to prune so the stale registration is cleaned up.
    if (!options.force && status.dirtyFiles.length > 0) {
      throw err;
    }
  }

  // 3. Prune stale worktrees (cleans up any orphaned registration)
  runner.run(options.mainRepoPath, ['worktree', 'prune'], { allowFailure: true });

  // 4. Optionally delete branch if requested (defend against deleting protected branches)
  let branchDeleted = false;
  if (
    options.deleteBranch &&
    branchName &&
    !PROTECTED_BRANCHES.has(branchName.toLowerCase())
  ) {
    const deleteArgs = options.force
      ? ['branch', '-D', branchName]
      : ['branch', '-d', branchName];
    try {
      runner.run(options.mainRepoPath, deleteArgs, { allowFailure: false });
      branchDeleted = true;
    } catch {
      // Non-fatal if branch cannot be deleted (e.g. unmerged and no force)
      branchDeleted = false;
    }
  }

  return Object.freeze({
    ok: true,
    worktreePath: options.worktreePath,
    branchDeleted,
  });
}
