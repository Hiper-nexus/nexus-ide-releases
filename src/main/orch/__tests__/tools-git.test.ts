import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildGitTools } from '../tools-git';
import { execFileSync, execSync } from 'node:child_process';
import { testProjectScope } from './scope-fixture';

const workspace = vi.hoisted(() => ({ current: '' }));
vi.mock('../../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => workspace.current,
}));

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-git');
const wsDir = path.join(testDir, 'workspace');

describe('tools-git', () => {
  beforeAll(() => {
    workspace.current = wsDir;
    fs.mkdirSync(wsDir, { recursive: true });
    execSync('git init -b main', { cwd: wsDir });
    execSync('git config user.email "test@nexus.dev"', { cwd: wsDir });
    execSync('git config user.name "Test"', { cwd: wsDir });
    fs.writeFileSync(path.join(wsDir, 'readme.md'), '# Test\n', 'utf-8');
    execSync('git add readme.md', { cwd: wsDir });
    execSync('git commit -m "initial commit"', { cwd: wsDir });
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('nexus_git_status shows branch and status', async () => {
    const tools = buildGitTools();
    const status = tools.find((t) => t.name === 'nexus_git_status')!;
    const result = await status.handler({}, fakeCtx());
    expect(result).toHaveProperty('output');
    expect((result as { output: string }).output).toContain('main');
  });

  it('nexus_git_log returns commits', async () => {
    const tools = buildGitTools();
    const log = tools.find((t) => t.name === 'nexus_git_log')!;
    const result = await log.handler({ count: 5 }, fakeCtx()) as { commits: string[] };
    expect(result).toHaveProperty('commits');
    expect(result.commits.length).toBeGreaterThan(0);
  });

  it('nexus_git_diff shows empty diff', async () => {
    const tools = buildGitTools();
    const diff = tools.find((t) => t.name === 'nexus_git_diff')!;
    const result = await diff.handler({}, fakeCtx()) as { diff: string };
    expect(result).toHaveProperty('diff');
    expect(result.diff).toBe('');
  });

  it('nexus_git_branch_list shows branches', async () => {
    const tools = buildGitTools();
    const branch = tools.find((t) => t.name === 'nexus_git_branch_list')!;
    const result = await branch.handler({}, fakeCtx()) as { branches: string[] };
    expect(result).toHaveProperty('branches');
    expect(result.branches).toContain('main');
    expect(result).toHaveProperty('current', 'main');
  });

  it('nexus_git_branch_create throws for invalid name', async () => {
    const tools = buildGitTools();
    const create = tools.find((t) => t.name === 'nexus_git_branch_create')!;
    await expect(create.handler({}, fakeCtx())).rejects.toThrow();
  });

  it('passes git args without shell interpolation', async () => {
    const marker = path.join(wsDir, 'injection-marker');
    const tools = buildGitTools();
    const add = tools.find((t) => t.name === 'nexus_git_add')!;
    await expect(
      add.handler({ paths: ['missing; touch injection-marker'] }, fakeCtx()),
    ).rejects.toThrow();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    { remote: '--force' },
    { remote: '--delete' },
    { remote: '--mirror' },
    { remote: '-f' },
    { remote: '-d' },
    { remote: '--force-with-lease' },
    { branch: '--force' },
    { branch: '--delete' },
    { branch: '--mirror' },
    { branch: '-f' },
    { branch: '-d' },
    { branch: '--force-with-lease' },
    { branch: ':main' },
    { branch: '+refs/heads/main' },
    { branch: 'main:main' },
  ])('rejects dangerous git push args %o', async (args) => {
    const tools = buildGitTools();
    const push = tools.find((t) => t.name === 'nexus_git_push')!;
    await expect(push.handler(args, fakeCtx())).rejects.toThrow(
      /blocked push flag|cannot start|refspec|delete refspec|force refspec/,
    );
  });

  it('marks nexus_git_push as requiring confirmation', () => {
    const tools = buildGitTools();
    const push = tools.find((t) => t.name === 'nexus_git_push')!;
    expect(push.requiresConfirm).toBe(true);
  });

  it('rejects executable repository config before any Git tool runs', async () => {
    execFileSync('git', ['config', '--local', 'core.fsmonitor', 'malicious-command'], {
      cwd: wsDir,
    });
    const status = buildGitTools().find((tool) => tool.name === 'nexus_git_status')!;
    try {
      await expect(status.handler({}, fakeCtx())).rejects.toThrow(
        /executable Git config/i,
      );
    } finally {
      execFileSync('git', ['config', '--local', '--unset-all', 'core.fsmonitor'], {
        cwd: wsDir,
      });
    }
  });

  it('disables repository hooks even for a commit operation', async () => {
    const marker = path.join(wsDir, 'hook-executed');
    const hook = path.join(wsDir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nprintf blocked > "${marker.replace(/"/g, '\\"')}"\n`,
      { encoding: 'utf8', mode: 0o700 },
    );
    fs.writeFileSync(path.join(wsDir, 'safe-commit.txt'), 'safe\n', 'utf8');
    execFileSync('git', ['add', 'safe-commit.txt'], { cwd: wsDir });
    const commit = buildGitTools().find((tool) => tool.name === 'nexus_git_commit')!;

    await commit.handler({ message: 'test: safe runner' }, fakeCtx());

    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects local and ext remote transports before push execution', async () => {
    execFileSync(
      'git',
      ['remote', 'add', 'unsafe-local', `ext::sh -c 'touch should-not-run'`],
      { cwd: wsDir },
    );
    const push = buildGitTools().find((tool) => tool.name === 'nexus_git_push')!;
    try {
      await expect(
        push.handler({ remote: 'unsafe-local', branch: 'main' }, fakeCtx()),
      ).rejects.toThrow(/HTTPS or SSH/i);
    } finally {
      execFileSync('git', ['remote', 'remove', 'unsafe-local'], { cwd: wsDir });
    }
    expect(fs.existsSync(path.join(wsDir, 'should-not-run'))).toBe(false);
  });
});

function fakeCtx() {
  return {
    token: 'test',
    label: 'test',
    role: 'user' as const,
    allowedTools: null as string[] | null,
    allowedSkills: null as string[] | null,
    stopAttempts: 0,
    handoffSubmitted: false,
    scope: testProjectScope({ rootRealPath: fs.realpathSync(wsDir) }),
  };
}
