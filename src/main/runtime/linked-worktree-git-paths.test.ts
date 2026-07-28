import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { linkedWorktreeGitPaths } from './linked-worktree-git-paths';

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

describe('linkedWorktreeGitPaths', () => {
  it('makes the repository directory readable so git can resolve it', () => {
    const { repo, worktree } = repoWithLinkedWorktree();
    const common = fs.realpathSync.native(path.join(repo, '.git'));

    const paths = linkedWorktreeGitPaths(worktree);

    // Without this git reports `fatal: not a git repository` and the commit
    // never starts — measured against a real Seatbelt profile.
    expect(paths.readPaths).toContain(common);
    expect(paths.readPaths).toContain(
      fs.realpathSync.native(path.join(common, 'worktrees', 'wt')),
    );
  });

  it('grants write only on the subtrees a commit mutates', () => {
    const { repo, worktree } = repoWithLinkedWorktree();
    const common = fs.realpathSync.native(path.join(repo, '.git'));

    const { writePaths } = linkedWorktreeGitPaths(worktree);

    expect(writePaths).toContain(
      fs.realpathSync.native(path.join(common, 'worktrees', 'wt')),
    );
    expect(writePaths).toContain(path.join(common, 'objects'));
    expect(writePaths).toContain(path.join(common, 'refs'));
    expect(writePaths).toContain(path.join(common, 'logs'));
    // The repository directory itself is readable, never writable wholesale.
    expect(writePaths).not.toContain(common);
  });

  it('keeps hooks and config unwritable', () => {
    const { repo, worktree } = repoWithLinkedWorktree();
    const common = fs.realpathSync.native(path.join(repo, '.git'));

    const { writePaths, protectedPaths } = linkedWorktreeGitPaths(worktree);

    // hooks/ is arbitrary host code execution; config rewrites remotes/filters.
    expect(writePaths).not.toContain(path.join(common, 'hooks'));
    expect(writePaths).not.toContain(path.join(common, 'config'));
    expect(protectedPaths).toContain(path.join(common, 'hooks'));
    expect(protectedPaths).toContain(path.join(common, 'config'));
  });

  it('grants nothing for an ordinary checkout', () => {
    const root = tempRoot();
    const repo = path.join(root, 'plain');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '.');

    const paths = linkedWorktreeGitPaths(repo);

    expect(paths.readPaths).toEqual([]);
    expect(paths.writePaths).toEqual([]);
  });

  it('grants nothing when the pointer is absent or unreadable', () => {
    const root = tempRoot();
    expect(linkedWorktreeGitPaths(path.join(root, 'missing')).writePaths).toEqual(
      [],
    );

    const bogus = path.join(root, 'bogus');
    fs.mkdirSync(bogus);
    fs.writeFileSync(path.join(bogus, '.git'), 'not a gitdir pointer\n');
    expect(linkedWorktreeGitPaths(bogus).writePaths).toEqual([]);
  });

  it('grants nothing when the pointer targets a path that does not exist', () => {
    const root = tempRoot();
    const orphan = path.join(root, 'orphan');
    fs.mkdirSync(orphan);
    fs.writeFileSync(
      path.join(orphan, '.git'),
      `gitdir: ${path.join(root, 'nowhere', 'worktrees', 'x')}\n`,
    );

    const paths = linkedWorktreeGitPaths(orphan);

    expect(paths.readPaths).toEqual([]);
    expect(paths.writePaths).toEqual([]);
  });
});
