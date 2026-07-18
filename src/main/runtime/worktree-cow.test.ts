import { describe, expect, it, vi } from 'vitest';
import {
  cowCopyHeavyDirs,
  cowWorktreeAvailable,
  materializeGitWorktree,
  tryClonefileCopy,
} from './worktree-cow';

describe('worktree-cow', () => {
  it('reports cow availability on darwin unless disabled', () => {
    const prev = process.env.NEXUS_COW_WORKTREE;
    delete process.env.NEXUS_COW_WORKTREE;
    expect(cowWorktreeAvailable('darwin')).toBe(true);
    expect(cowWorktreeAvailable('linux')).toBe(false);
    process.env.NEXUS_COW_WORKTREE = '0';
    expect(cowWorktreeAvailable('darwin')).toBe(false);
    if (prev === undefined) delete process.env.NEXUS_COW_WORKTREE;
    else process.env.NEXUS_COW_WORKTREE = prev;
  });

  it('tryClonefileCopy returns false on non-darwin without running cp', () => {
    if (process.platform === 'darwin') {
      expect(typeof tryClonefileCopy).toBe('function');
      return;
    }
    expect(tryClonefileCopy('/tmp/a', '/tmp/b')).toBe(false);
  });

  it('materializeGitWorktree uses git worktree add then reports method', () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const result = materializeGitWorktree({
      repositoryRoot: '/repo',
      worktreePath: `/tmp/nexus-cow-test-${Date.now()}-missing`,
      branchRef: 'refs/heads/nexus/task-1',
      headSha: 'abc123',
      git: { run } as never,
      cowDirs: [], // skip clonefile side effects in unit test
    });
    expect(run).toHaveBeenCalledWith('/repo', [
      'worktree',
      'add',
      '-b',
      'nexus/task-1',
      expect.stringContaining('nexus-cow-test'),
      'abc123',
    ]);
    expect(result.method).toBe('git-worktree');
    expect(result.cowCopied).toEqual([]);
  });

  it('cowCopyHeavyDirs returns empty when CoW disabled', () => {
    const prev = process.env.NEXUS_COW_WORKTREE;
    process.env.NEXUS_COW_WORKTREE = '0';
    expect(cowCopyHeavyDirs('/a', '/b')).toEqual([]);
    if (prev === undefined) delete process.env.NEXUS_COW_WORKTREE;
    else process.env.NEXUS_COW_WORKTREE = prev;
  });
});
