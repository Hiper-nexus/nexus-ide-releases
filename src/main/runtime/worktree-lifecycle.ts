// NOT WIRED: this module has no production call sites. Its only importers are
// worktree-metadata.ts, mission-worktree-orchestrator.ts and its own test.
// Production worktree removal goes through worktree-removal-safety.ts instead.
// See docs/qa/items/F-404.md before wiring it up.
import { existsSync } from 'node:fs';
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

/**
 * `missing` and `unverifiable` are different facts and must not collapse into
 * one another. A directory that is already gone is a known state where removal
 * is moot and prune is the right action. A `git status` that failed for any
 * other reason — index.lock held by a concurrent agent, timeout, permissions,
 * corruption — means we do not know, and "do not know" never authorises a
 * destructive operation. Same rule as the ptyd endpoint-ownership protocol in
 * docs/architecture/pty-daemon-spec.md: never collapse "don't know" into a
 * terminal answer.
 */
export type WorktreeStatusState = 'clean' | 'dirty' | 'missing' | 'unverifiable';

export interface WorktreeStatusCheck {
  readonly state: WorktreeStatusState;
  readonly dirtyFiles: readonly string[];
  /** Present only when state is `unverifiable`. */
  readonly reason?: string;
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

export class WorktreeStatusUnknownError extends Error {
  readonly reason: string;
  constructor(worktreePath: string, reason: string) {
    super(
      `worktree at "${worktreePath}" could not be verified as clean (${reason}); refusing to remove. Pass force: true to override.`,
    );
    this.name = 'WorktreeStatusUnknownError';
    this.reason = reason;
  }
}

/**
 * Check if an isolated worktree is completely clean and safe for archiving/removal.
 */
export function checkWorktreeStatus(
  worktreePath: string,
  runner: GitRunner = new ProcessGitRunner(),
): WorktreeStatusCheck {
  if (!existsSync(worktreePath)) {
    return Object.freeze({
      state: 'missing',
      dirtyFiles: Object.freeze([]),
    });
  }

  let result;
  try {
    result = runner.run(
      worktreePath,
      ['status', '--porcelain', '-uall'],
      { allowFailure: false },
    );
  } catch (err) {
    return Object.freeze({
      state: 'unverifiable',
      dirtyFiles: Object.freeze([]),
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  const lines = result.stdout
    .split('\n')
    .filter((l) => l.length >= 3);

  if (lines.length === 0) {
    return Object.freeze({ state: 'clean', dirtyFiles: Object.freeze([]) });
  }

  const files = lines.map((line) => {
    // porcelain status format: "XY <path>" where X and Y are 1 char each (can be space)
    return line.slice(3).trim();
  });

  return Object.freeze({
    state: 'dirty',
    dirtyFiles: Object.freeze(files),
  });
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

  // 1. Safety check. `dirty` and `unverifiable` both refuse; only `force` overrides.
  const status = checkWorktreeStatus(options.worktreePath, runner);
  if (!options.force) {
    if (status.state === 'dirty') {
      throw new WorktreeDirtyStateError(options.worktreePath, status.dirtyFiles);
    }
    if (status.state === 'unverifiable') {
      throw new WorktreeStatusUnknownError(
        options.worktreePath,
        status.reason ?? 'git status failed',
      );
    }
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
    // A worktree whose directory is already gone cannot be removed; prune still
    // clears the stale registration, which is the outcome the caller wanted.
    // Every other removal failure is real and must surface — returning ok:true
    // over a worktree that still exists would be a false success.
    if (status.state !== 'missing') {
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
