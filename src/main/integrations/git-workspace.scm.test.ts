/**
 * Integration smoke: real git binary + AsyncProcessGitRunner for SCM UI helpers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  gitBranches,
  gitCheckoutBranch,
  gitCommitMessage,
  gitCurrentBranch,
  gitDiscard,
  gitFileDiff,
  gitLogOneline,
  gitScmStatus,
  gitStage,
  gitUnstage,
} from './git-workspace';

function run(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Nexus SCM Test',
      GIT_AUTHOR_EMAIL: 'scm-test@nexus.local',
      GIT_COMMITTER_NAME: 'Nexus SCM Test',
      GIT_COMMITTER_EMAIL: 'scm-test@nexus.local',
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
}

describe('git-workspace SCM integration (real git)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-scm-'));
    run(root, ['init', '-b', 'main']);
    run(root, ['config', 'user.name', 'Nexus SCM Test']);
    run(root, ['config', 'user.email', 'scm-test@nexus.local']);
    fs.writeFileSync(path.join(root, 'README.md'), '# scm\n');
    run(root, ['add', 'README.md']);
    run(root, ['commit', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('status → stage → unstage → stage → commit → log → fileDiff', async () => {
    expect(await gitCurrentBranch(root)).toBe('main');

    let status = await gitScmStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.clean).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.hasUpstream).toBe(false);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.hasUnresolvedConflicts).toBe(false);
    expect(status.defaultBranch).toBe('main');

    fs.writeFileSync(path.join(root, 'hello.ts'), 'export const n = 1;\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# scm\nchanged\n');

    status = await gitScmStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.clean).toBe(false);
    expect(status.untracked.map((f) => f.path)).toContain('hello.ts');
    expect(status.unstaged.map((f) => f.path)).toContain('README.md');

    const stageHello = await gitStage(root, ['hello.ts']);
    expect(stageHello).toEqual({ ok: true });

    status = await gitScmStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.staged.map((f) => f.path)).toContain('hello.ts');
    expect(status.untracked.map((f) => f.path)).not.toContain('hello.ts');

    const unstageHello = await gitUnstage(root, ['hello.ts']);
    expect(unstageHello).toEqual({ ok: true });

    status = await gitScmStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.staged.map((f) => f.path)).not.toContain('hello.ts');
    expect(status.untracked.map((f) => f.path)).toContain('hello.ts');

    expect(await gitStage(root, ['hello.ts', 'README.md'])).toEqual({ ok: true });

    const stagedDiff = await gitFileDiff(root, 'README.md', { staged: true });
    expect(stagedDiff.ok).toBe(true);
    if (!stagedDiff.ok) return;
    expect(stagedDiff.diff).toContain('changed');

    const untrackedDiff = await gitFileDiff(root, 'hello.ts', { untracked: true });
    expect(untrackedDiff).toMatchObject({ ok: true, untracked: true });

    const commit = await gitCommitMessage(root, 'feat: scm smoke');
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.summary.length).toBeGreaterThan(0);

    status = await gitScmStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.clean).toBe(true);

    const log = await gitLogOneline(root, 5);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.commits[0]?.subject).toBe('feat: scm smoke');
    expect(log.commits.some((c) => c.subject === 'init')).toBe(true);
  });

  it('rejects path traversal and empty commit message', async () => {
    expect((await gitStage(root, ['../escape.txt'])).ok).toBe(false);
    expect((await gitCommitMessage(root, '   ')).ok).toBe(false);
    expect((await gitFileDiff(root, '/etc/passwd')).ok).toBe(false);
  });

  it('branches → checkout -b → checkout existing → discard changes', async () => {
    let b = await gitBranches(root);
    expect(b.ok).toBe(true);
    expect(b.current).toBe('main');
    expect(b.branches).toContain('main');

    // Create and switch branch
    const created = await gitCheckoutBranch(root, 'feature-orca', true);
    expect(created).toEqual({ ok: true });
    expect(await gitCurrentBranch(root)).toBe('feature-orca');

    b = await gitBranches(root);
    expect(b.current).toBe('feature-orca');
    expect(b.branches).toContain('feature-orca');
    expect(b.branches).toContain('main');

    // Switch back to main
    const switched = await gitCheckoutBranch(root, 'main', false);
    expect(switched).toEqual({ ok: true });
    expect(await gitCurrentBranch(root)).toBe('main');

    // Discard modified file
    fs.writeFileSync(path.join(root, 'README.md'), '# modified\n');
    const statusMod = await gitScmStatus(root);
    expect(statusMod.ok).toBe(true);
    if (statusMod.ok) expect(statusMod.clean).toBe(false);
    const discarded = await gitDiscard(root, ['README.md']);
    expect(discarded).toEqual({ ok: true });
    const statusClean = await gitScmStatus(root);
    expect(statusClean.ok).toBe(true);
    if (statusClean.ok) expect(statusClean.clean).toBe(true);
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('# scm\n');
  });
});
