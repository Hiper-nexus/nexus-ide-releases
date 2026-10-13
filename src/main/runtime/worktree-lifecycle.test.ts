import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { GitRunner, GitResult } from './git-command';
import {
  archiveWorktree,
  checkWorktreeStatus,
  WorktreeDirtyStateError,
  WorktreeStatusUnknownError,
} from './worktree-lifecycle';

interface MockOutcome extends Partial<GitResult> {
  throws?: Error;
}

function makeMockRunner(handlers: Record<string, MockOutcome> = {}): GitRunner {
  return {
    run: vi.fn((_cwd: string, args: readonly string[]): GitResult => {
      const key = args.join(' ');
      const matchedKey = Object.keys(handlers).find((h) => key.includes(h));
      const res = matchedKey ? handlers[matchedKey] : undefined;
      if (res?.throws) {
        throw res.throws;
      }
      return {
        status: res?.status ?? 0,
        stdout: res?.stdout ?? '',
        stderr: res?.stderr ?? '',
      };
    }),
  };
}

// checkWorktreeStatus asks the filesystem whether the worktree exists before it
// asks git anything, so the clean/dirty/unverifiable cases need a real
// directory. A fabricated path would read as `missing` and never reach git.
const createdDirs: string[] = [];

function makeExistingWorktreeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-worktree-lifecycle-'));
  createdDirs.push(dir);
  return dir;
}

const MISSING_WORKTREE_PATH = join(tmpdir(), 'nexus-worktree-does-not-exist-8f2a1c');

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('checkWorktreeStatus', () => {
  test('returns clean when porcelain status is empty', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: '' },
    });

    const status = checkWorktreeStatus(makeExistingWorktreeDir(), runner);
    expect(status.state).toBe('clean');
    expect(status.dirtyFiles).toEqual([]);
  });

  test('returns dirty with file list when changes exist', () => {
    const runner = makeMockRunner({
      'status --porcelain': {
        stdout: ' M src/index.ts\n?? new-file.txt\n',
      },
    });

    const status = checkWorktreeStatus(makeExistingWorktreeDir(), runner);
    expect(status.state).toBe('dirty');
    expect(status.dirtyFiles).toEqual(['src/index.ts', 'new-file.txt']);
  });

  test('returns missing when the worktree directory is gone', () => {
    const runner = makeMockRunner();

    const status = checkWorktreeStatus(MISSING_WORKTREE_PATH, runner);
    expect(status.state).toBe('missing');
    expect(runner.run).not.toHaveBeenCalled();
  });

  test('returns unverifiable with the git failure reason instead of claiming clean', () => {
    const runner = makeMockRunner({
      'status --porcelain': {
        throws: new Error('fatal: Unable to create index.lock: File exists'),
      },
    });

    const status = checkWorktreeStatus(makeExistingWorktreeDir(), runner);
    expect(status.state).toBe('unverifiable');
    expect(status.reason).toContain('index.lock');
    expect(status.dirtyFiles).toEqual([]);
  });
});

describe('archiveWorktree', () => {
  test('F-1429 parte 2: worktree adotada nunca é removida nem tem a branch apagada, nem com force', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: '' },
      'worktree remove': { stdout: '' },
      'worktree prune': { stdout: '' },
      'branch -D': { stdout: '' },
    });

    expect(() =>
      archiveWorktree(
        {
          mainRepoPath: '/repo',
          worktreePath: makeExistingWorktreeDir(),
          branchName: 'harvest/s243-fix',
          deleteBranch: true,
          force: true,
          adopted: true,
        },
        runner,
      ),
    ).toThrow(/adotada/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  test('refuses to remove dirty worktree without force', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: ' M dirty.txt\n' },
    });

    expect(() =>
      archiveWorktree(
        { mainRepoPath: '/repo', worktreePath: makeExistingWorktreeDir() },
        runner,
      ),
    ).toThrow(WorktreeDirtyStateError);
    expect(runner.run).not.toHaveBeenCalledWith(
      '/repo',
      expect.arrayContaining(['worktree', 'remove']),
      expect.any(Object),
    );
  });

  test('refuses to remove a worktree whose cleanliness could not be verified', () => {
    const runner = makeMockRunner({
      'status --porcelain': { throws: new Error('git status timed out') },
    });

    expect(() =>
      archiveWorktree(
        { mainRepoPath: '/repo', worktreePath: makeExistingWorktreeDir() },
        runner,
      ),
    ).toThrow(WorktreeStatusUnknownError);
    expect(runner.run).not.toHaveBeenCalledWith(
      '/repo',
      expect.arrayContaining(['worktree', 'remove']),
      expect.any(Object),
    );
  });

  test('force overrides an unverifiable status', () => {
    const runner = makeMockRunner({
      'status --porcelain': { throws: new Error('git status timed out') },
      'worktree remove --force': { stdout: '' },
      'worktree prune': { stdout: '' },
    });

    const result = archiveWorktree(
      { mainRepoPath: '/repo', worktreePath: makeExistingWorktreeDir(), force: true },
      runner,
    );

    expect(result.ok).toBe(true);
  });

  test('successfully removes clean worktree and prunes', () => {
    const worktreePath = makeExistingWorktreeDir();
    const runner = makeMockRunner({
      'status --porcelain': { stdout: '' },
      'worktree remove': { stdout: '' },
      'worktree prune': { stdout: '' },
    });

    const result = archiveWorktree({ mainRepoPath: '/repo', worktreePath }, runner);

    expect(result.ok).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(
      '/repo',
      ['worktree', 'remove', worktreePath],
      expect.any(Object),
    );
    expect(runner.run).toHaveBeenCalledWith(
      '/repo',
      ['worktree', 'prune'],
      expect.any(Object),
    );
  });

  test('surfaces a removal failure on a worktree that still exists', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: '' },
      'worktree remove': { throws: new Error('fatal: locked worktree') },
    });

    expect(() =>
      archiveWorktree(
        { mainRepoPath: '/repo', worktreePath: makeExistingWorktreeDir() },
        runner,
      ),
    ).toThrow('locked worktree');
  });

  test('allows force removal when force: true is passed', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: '?? untracked.txt\n' },
      'worktree remove --force': { stdout: '' },
      'worktree prune': { stdout: '' },
    });

    const result = archiveWorktree(
      { mainRepoPath: '/repo', worktreePath: makeExistingWorktreeDir(), force: true },
      runner,
    );

    expect(result.ok).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(
      '/repo',
      ['worktree', 'remove', '--force', expect.any(String)],
      expect.any(Object),
    );
  });

  test('deletes branch if requested and branchName provided', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: '' },
      'worktree remove': { stdout: '' },
      'worktree prune': { stdout: '' },
      'branch -d': { stdout: 'Deleted branch task/auth' },
    });

    const result = archiveWorktree(
      {
        mainRepoPath: '/repo',
        worktreePath: makeExistingWorktreeDir(),
        branchName: 'task/auth',
        deleteBranch: true,
      },
      runner,
    );

    expect(result.ok).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(
      '/repo',
      ['branch', '-d', 'task/auth'],
      expect.any(Object),
    );
  });

  test('refuses to delete protected branches like main even if requested', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: '' },
      'worktree remove': { stdout: '' },
      'worktree prune': { stdout: '' },
    });

    const result = archiveWorktree(
      {
        mainRepoPath: '/repo',
        worktreePath: makeExistingWorktreeDir(),
        branchName: 'main',
        deleteBranch: true,
      },
      runner,
    );

    expect(result.ok).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(runner.run).not.toHaveBeenCalledWith(
      '/repo',
      expect.arrayContaining(['branch']),
      expect.any(Object),
    );
  });

  test('prunes the stale registration when the worktree directory is already gone', () => {
    const runner = makeMockRunner({
      'worktree prune': { stdout: '' },
    });

    const result = archiveWorktree(
      { mainRepoPath: '/repo', worktreePath: MISSING_WORKTREE_PATH },
      runner,
    );

    expect(result.ok).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(
      '/repo',
      ['worktree', 'prune'],
      expect.any(Object),
    );
  });
});
