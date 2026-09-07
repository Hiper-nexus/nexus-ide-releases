import { describe, expect, test, vi } from 'vitest';
import type { GitRunner, GitResult } from './git-command';
import {
  archiveWorktree,
  checkWorktreeStatus,
  WorktreeDirtyStateError,
} from './worktree-lifecycle';

function makeMockRunner(handlers: Record<string, Partial<GitResult>> = {}): GitRunner {
  return {
    run: vi.fn((_cwd: string, args: readonly string[]): GitResult => {
      const key = args.join(' ');
      const matchedKey = Object.keys(handlers).find((h) => key.includes(h));
      const res = matchedKey ? handlers[matchedKey] : undefined;
      return {
        status: res?.status ?? 0,
        stdout: res?.stdout ?? '',
        stderr: res?.stderr ?? '',
      };
    }),
  };
}

describe('checkWorktreeStatus', () => {
  test('returns clean when porcelain status is empty', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: '' },
    });

    const status = checkWorktreeStatus('/tmp/wt', runner);
    expect(status.isClean).toBe(true);
    expect(status.dirtyFiles).toEqual([]);
  });

  test('returns dirty with file list when changes exist', () => {
    const runner = makeMockRunner({
      'status --porcelain': {
        stdout: ' M src/index.ts\n?? new-file.txt\n',
      },
    });

    const status = checkWorktreeStatus('/tmp/wt', runner);
    expect(status.isClean).toBe(false);
    expect(status.dirtyFiles).toEqual(['src/index.ts', 'new-file.txt']);
  });
});

describe('archiveWorktree', () => {
  test('refuses to remove dirty worktree without force', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: ' M dirty.txt\n' },
    });

    expect(() =>
      archiveWorktree(
        { mainRepoPath: '/repo', worktreePath: '/tmp/wt' },
        runner,
      ),
    ).toThrow(WorktreeDirtyStateError);
  });

  test('successfully removes clean worktree and prunes', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: '' },
      'worktree remove': { stdout: '' },
      'worktree prune': { stdout: '' },
    });

    const result = archiveWorktree(
      { mainRepoPath: '/repo', worktreePath: '/tmp/wt' },
      runner,
    );

    expect(result.ok).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(
      '/repo',
      ['worktree', 'remove', '/tmp/wt'],
      expect.any(Object),
    );
    expect(runner.run).toHaveBeenCalledWith(
      '/repo',
      ['worktree', 'prune'],
      expect.any(Object),
    );
  });

  test('allows force removal when force: true is passed', () => {
    const runner = makeMockRunner({
      'status --porcelain': { stdout: '?? untracked.txt\n' },
      'worktree remove --force': { stdout: '' },
      'worktree prune': { stdout: '' },
    });

    const result = archiveWorktree(
      { mainRepoPath: '/repo', worktreePath: '/tmp/wt', force: true },
      runner,
    );

    expect(result.ok).toBe(true);
    expect(runner.run).toHaveBeenCalledWith(
      '/repo',
      ['worktree', 'remove', '--force', '/tmp/wt'],
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
        worktreePath: '/tmp/wt',
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
        worktreePath: '/tmp/wt',
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

  test('gracefully handles worktree path that does not exist on disk', () => {
    const runner = makeMockRunner({
      'worktree prune': { stdout: '' },
    });

    const result = archiveWorktree(
      {
        mainRepoPath: '/repo',
        worktreePath: '/tmp/nonexistent-wt-path-xyz',
      },
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
