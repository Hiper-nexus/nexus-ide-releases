/**
 * CoW / fast worktree materialization — grok-build xai-fast-worktree idea,
 * reimplemented for Nexus:
 * 1. Always create a correct linked worktree via `git worktree add`
 * 2. On macOS APFS (when NEXUS_COW_WORKTREE≠0), clonefile bulky dirs
 *    (node_modules, etc.) from the main checkout into the new worktree
 *
 * Pure helpers + injectable runners for tests. CoW copy is async so the
 * Electron main process is not blocked on `cp -cR`.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitRunner } from './git-command';
import { GitCommandError } from './git-command';
import { removeTreeSync } from '../util/remove-tree';

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

export type ClonefileExecSync = typeof spawnSync;
export type ClonefileExecAsync = (
  command: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number },
) => Promise<{ readonly status: number | null }>;

function branchNameFromRef(branchRef: string): string {
  return branchRef.startsWith('refs/heads/')
    ? branchRef.slice('refs/heads/'.length)
    : branchRef;
}

async function defaultClonefileExecAsync(
  command: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number },
): Promise<{ readonly status: number | null }> {
  return await new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ status: null });
    }, options.timeout);
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: code });
    });
  });
}

/**
 * macOS APFS clonefile via `cp -c` (copy-on-write when filesystem supports it).
 * Async — does not block the Electron main event loop.
 */
export async function tryClonefileCopy(
  source: string,
  dest: string,
  exec: ClonefileExecAsync = defaultClonefileExecAsync,
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  if (!fs.existsSync(source)) return false;
  if (fs.existsSync(dest)) return false;
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const result = await exec('cp', ['-cR', source, dest], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0 || !fs.existsSync(dest)) {
    try {
      removeTreeSync(dest, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    return false;
  }
  return true;
}

/**
 * Sync clonefile for unit tests that inject spawnSync. Prefer tryClonefileCopy.
 */
export function tryClonefileCopySync(
  source: string,
  dest: string,
  exec: ClonefileExecSync = spawnSync,
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
      removeTreeSync(dest, { recursive: true, force: true });
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
export async function cowCopyHeavyDirs(
  repositoryRoot: string,
  worktreePath: string,
  dirs: readonly string[] = DEFAULT_COW_DIRS,
  exec: ClonefileExecAsync = defaultClonefileExecAsync,
): Promise<string[]> {
  if (!cowWorktreeAvailable()) return [];
  const copied: string[] = [];
  for (const rel of dirs) {
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
    const src = path.join(repositoryRoot, rel);
    const dest = path.join(worktreePath, rel);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    if (await tryClonefileCopy(src, dest, exec)) {
      copied.push(rel.replaceAll('\\', '/'));
    }
  }
  return copied;
}

/** Sync variant for tests that disable CoW or inject sync runners. */
export function cowCopyHeavyDirsSync(
  repositoryRoot: string,
  worktreePath: string,
  dirs: readonly string[] = DEFAULT_COW_DIRS,
  exec: ClonefileExecSync = spawnSync,
): string[] {
  if (!cowWorktreeAvailable()) return [];
  const copied: string[] = [];
  for (const rel of dirs) {
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
    const src = path.join(repositoryRoot, rel);
    const dest = path.join(worktreePath, rel);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    if (tryClonefileCopySync(src, dest, exec)) {
      copied.push(rel.replaceAll('\\', '/'));
    }
  }
  return copied;
}

/**
 * Materialize a linked git worktree, then optionally CoW heavy content.
 */
export async function materializeGitWorktree(
  input: MaterializeWorktreeInput,
): Promise<MaterializeWorktreeResult> {
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
  const cowCopied = await cowCopyHeavyDirs(
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
