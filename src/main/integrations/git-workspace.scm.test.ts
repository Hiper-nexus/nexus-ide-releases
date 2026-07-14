/**
 * Integration smoke: real git binary + ProcessGitRunner for SCM UI helpers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  gitCommitMessage,
  gitCurrentBranch,
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

  it('status → stage → unstage → stage → commit → log → fileDiff', () => {
    expect(gitCurrentBranch(root)).toBe('main');

    let status = gitScmStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.clean).toBe(true);
    expect(status.branch).toBe('main');

    fs.writeFileSync(path.join(root, 'hello.ts'), 'export const n = 1;\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# scm\nchanged\n');

    status = gitScmStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.clean).toBe(false);
    expect(status.untracked.map((f) => f.path)).toContain('hello.ts');
    expect(status.unstaged.map((f) => f.path)).toContain('README.md');

    const stageHello = gitStage(root, ['hello.ts']);
    expect(stageHello).toEqual({ ok: true });

    status = gitScmStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.staged.map((f) => f.path)).toContain('hello.ts');
    expect(status.untracked.map((f) => f.path)).not.toContain('hello.ts');

    const unstageHello = gitUnstage(root, ['hello.ts']);
    expect(unstageHello).toEqual({ ok: true });

    status = gitScmStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.staged.map((f) => f.path)).not.toContain('hello.ts');
    expect(status.untracked.map((f) => f.path)).toContain('hello.ts');

    expect(gitStage(root, ['hello.ts', 'README.md'])).toEqual({ ok: true });

    const stagedDiff = gitFileDiff(root, 'README.md', { staged: true });
    expect(stagedDiff.ok).toBe(true);
    if (!stagedDiff.ok) return;
    expect(stagedDiff.diff).toContain('changed');

    const untrackedDiff = gitFileDiff(root, 'hello.ts', { untracked: true });
    expect(untrackedDiff).toMatchObject({ ok: true, untracked: true });

    const commit = gitCommitMessage(root, 'feat: scm smoke');
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.summary.length).toBeGreaterThan(0);

    status = gitScmStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.clean).toBe(true);

    const log = gitLogOneline(root, 5);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.commits[0]?.subject).toBe('feat: scm smoke');
    expect(log.commits.some((c) => c.subject === 'init')).toBe(true);
  });

  it('rejects path traversal and empty commit message', () => {
    expect(gitStage(root, ['../escape.txt']).ok).toBe(false);
    expect(gitCommitMessage(root, '   ').ok).toBe(false);
    expect(gitFileDiff(root, '/etc/passwd').ok).toBe(false);
  });
});
