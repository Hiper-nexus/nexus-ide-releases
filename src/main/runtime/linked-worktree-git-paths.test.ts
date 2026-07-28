import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { linkedWorktreeGitWritePaths } from './linked-worktree-git-paths';

const created: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-worktree-paths-'));
  created.push(dir);
  return fs.realpathSync.native(dir);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function repoWithLinkedWorktree(): { repo: string; worktree: string } {
  const root = tempRoot();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '.');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  // The worktree lives OUTSIDE the repository, exactly like a Nexus task
  // worktree under project-runtime.
  const worktree = path.join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'task');
  return { repo, worktree };
}

afterEach(() => {
  while (created.length > 0) {
    fs.rmSync(created.pop()!, { recursive: true, force: true });
  }
});

describe('linkedWorktreeGitWritePaths', () => {
  it('grants the parent git subtrees a commit actually writes', () => {
    const { repo, worktree } = repoWithLinkedWorktree();

    const granted = linkedWorktreeGitWritePaths(worktree);

    const common = fs.realpathSync.native(path.join(repo, '.git'));
    expect(granted).toContain(
      fs.realpathSync.native(path.join(common, 'worktrees', 'wt')),
    );
    expect(granted).toContain(path.join(common, 'objects'));
    expect(granted).toContain(path.join(common, 'refs'));
    expect(granted).toContain(path.join(common, 'logs'));
  });

  it('never grants hooks or config: both would break the sandbox boundary', () => {
    const { repo, worktree } = repoWithLinkedWorktree();
    const common = fs.realpathSync.native(path.join(repo, '.git'));

    const granted = linkedWorktreeGitWritePaths(worktree);

    // hooks/ is arbitrary host code execution; config rewrites remotes/filters.
    expect(granted).not.toContain(path.join(common, 'hooks'));
    expect(granted).not.toContain(path.join(common, 'config'));
    // The whole .git must never be granted wholesale.
    expect(granted).not.toContain(common);
  });

  it('grants nothing for an ordinary checkout', () => {
    const root = tempRoot();
    const repo = path.join(root, 'plain');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '.');

    expect(linkedWorktreeGitWritePaths(repo)).toEqual([]);
  });

  it('grants nothing when the pointer is absent or unreadable', () => {
    const root = tempRoot();
    expect(linkedWorktreeGitWritePaths(path.join(root, 'missing'))).toEqual([]);

    const bogus = path.join(root, 'bogus');
    fs.mkdirSync(bogus);
    fs.writeFileSync(path.join(bogus, '.git'), 'not a gitdir pointer\n');
    expect(linkedWorktreeGitWritePaths(bogus)).toEqual([]);
  });

  it('grants nothing when the pointer targets a path that does not exist', () => {
    const root = tempRoot();
    const orphan = path.join(root, 'orphan');
    fs.mkdirSync(orphan);
    fs.writeFileSync(
      path.join(orphan, '.git'),
      `gitdir: ${path.join(root, 'nowhere', 'worktrees', 'x')}\n`,
    );

    expect(linkedWorktreeGitWritePaths(orphan)).toEqual([]);
  });
});
