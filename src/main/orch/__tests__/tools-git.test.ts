import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildGitTools } from '../tools-git';
import { execSync } from 'node:child_process';

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-git');
const wsDir = path.join(testDir, 'workspace');

describe('tools-git', () => {
  beforeAll(() => {
    fs.mkdirSync(wsDir, { recursive: true });
    execSync('git init', { cwd: wsDir });
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
    const result = await status.handler({}, fakeCtx(wsDir));
    expect(result).toHaveProperty('output');
    expect(result.output).toContain('main');
  });

  it('nexus_git_log returns commits', async () => {
    const tools = buildGitTools();
    const log = tools.find((t) => t.name === 'nexus_git_log')!;
    const result = await log.handler({ count: 5 }, fakeCtx(wsDir));
    expect(result).toHaveProperty('commits');
    expect(result.commits.length).toBeGreaterThan(0);
  });

  it('nexus_git_diff shows empty diff', async () => {
    const tools = buildGitTools();
    const diff = tools.find((t) => t.name === 'nexus_git_diff')!;
    const result = await diff.handler({}, fakeCtx(wsDir));
    expect(result).toHaveProperty('diff');
    expect(result.diff).toBe('');
  });

  it('nexus_git_branch_list shows branches', async () => {
    const tools = buildGitTools();
    const branch = tools.find((t) => t.name === 'nexus_git_branch_list')!;
    const result = await branch.handler({}, fakeCtx(wsDir));
    expect(result).toHaveProperty('branches');
    expect(result.branches).toContain('main');
    expect(result).toHaveProperty('current', 'main');
  });

  it('nexus_git_branch_create throws for invalid name', async () => {
    const tools = buildGitTools();
    const create = tools.find((t) => t.name === 'nexus_git_branch_create')!;
    await expect(create.handler({}, fakeCtx(wsDir))).rejects.toThrow();
  });
});

function fakeCtx(cwd: string) {
  return {
    token: 'test',
    label: 'test',
    role: 'user' as const,
    allowedTools: null as string[] | null,
    allowedSkills: null as string[] | null,
    stopAttempts: 0,
    handoffSubmitted: false,
    sessionId: undefined,
  };
}

// Override activeWorkspaceOrNull for tests
import { activeWorkspaceOrNull } from '../../persistence/workspace-store';
(activeWorkspaceOrNull as unknown as () => string | null) = () => wsDir;