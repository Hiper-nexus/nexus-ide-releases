/**
 * CoW / fast worktree materialization — grok-build xai-fast-worktree idea,
 * reimplemented for Nexus:
 * 1. Always create a correct linked worktree via `git worktree add`
 * 2. On macOS APFS (when NEXUS_COW_WORKTREE≠0), clonefile bulky dirs
 *    (node_modules, etc.) from the main checkout into the new worktree
 *
 * Pure helpers + injectable runners for tests.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitRunner } from './git-command';
import { GitCommandError } from './git-command';

export type WorktreeMaterializeMethod = 'clonefile' | 'git-worktree';

export interface MaterializeWorktreeInput {
  repositoryRoot: string;
  worktreePath: string;
  /** Full ref e.g. refs/heads/nexus/... */
  branchRef: string;
  headSha: string;
  git: GitRunner;
  /** Heavy dirs to CoW-copy after git worktree add (default: node_modules). */
  cowDirs?: readonly string[];
}

export interface MaterializeWorktreeResult {
  method: WorktreeMaterializeMethod;
  worktreePath: string;
  /** Which relative dirs were clonefile-copied (empty when pure git). */
  cowCopied: readonly string[];
}

/** Default bulky trees that git worktree does not share but CoW can. */
export const DEFAULT_COW_DIRS = ['node_modules'] as const;

function branchNameFromRef(branchRef: string): string {
  return branchRef.startsWith('refs/heads/')
    ? branchRef.slice('refs/heads/'.length)
    : branchRef;
}

/**
 * macOS APFS clonefile via `cp -c` (copy-on-write when filesystem supports it).
 * Returns false if unsupported or failed.
 */
export function tryClonefileCopy(
  source: string,
  dest: string,
  exec: typeof spawnSync = spawnSync,
): boolean {
  if (process.platform !== 'darwin') return false;
  if (!fs.existsSync(source)) return false;
  if (fs.existsSync(dest)) return false;
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const result = exec('cp', ['-cR', source, dest], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0 || !fs.existsSync(dest)) {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    return false;
  }
  return true;
}

/**
 * After a correct `git worktree add`, optionally CoW-copy heavy sibling dirs
 * from the main repository working tree (e.g. node_modules) so workers start
 * warm without a full npm install.
 */
export function cowCopyHeavyDirs(
  repositoryRoot: string,
  worktreePath: string,
  dirs: readonly string[] = DEFAULT_COW_DIRS,
  exec: typeof spawnSync = spawnSync,
): string[] {
  if (!cowWorktreeAvailable()) return [];
  const copied: string[] = [];
  for (const rel of dirs) {
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
    const src = path.join(repositoryRoot, rel);
    const dest = path.join(worktreePath, rel);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    if (tryClonefileCopy(src, dest, exec)) copied.push(rel.replaceAll('\\', '/'));
  }
  return copied;
}

/**
 * Materialize a linked git worktree, then optionally CoW heavy content.
 */
export function materializeGitWorktree(
  input: MaterializeWorktreeInput,
): MaterializeWorktreeResult {
  const branch = branchNameFromRef(input.branchRef);
  if (fs.existsSync(input.worktreePath)) {
    throw new Error('derived worktree path already exists');
  }

  const result = input.git.run(input.repositoryRoot, [
    'worktree',
    'add',
    '-b',
    branch,
    input.worktreePath,
    input.headSha,
  ]);
  if (result.status !== 0) {
    throw new GitCommandError(
      'Git could not create the task worktree',
      ['worktree', 'add', '-b', branch, input.worktreePath, input.headSha],
      result,
    );
  }

  const cowDirs = input.cowDirs ?? DEFAULT_COW_DIRS;
  const cowCopied = cowCopyHeavyDirs(
    input.repositoryRoot,
    input.worktreePath,
    cowDirs,
  );

  return {
    method: cowCopied.length > 0 ? 'clonefile' : 'git-worktree',
    worktreePath: input.worktreePath,
    cowCopied,
  };
}

/**
 * Pure detection: whether CoW clonefile is worth trying on this host.
 * Set NEXUS_COW_WORKTREE=0 to force-disable; default on when darwin.
 */
export function cowWorktreeAvailable(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' && process.env.NEXUS_COW_WORKTREE !== '0';
}
