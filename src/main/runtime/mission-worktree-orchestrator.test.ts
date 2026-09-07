import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { WorktreeManager, WorktreeRecord } from './worktree-manager';
import type { GitRunner } from './git-command';
import {
  prepareTaskWorktree,
  teardownTaskWorktree,
} from './mission-worktree-orchestrator';
import { readWorktreeMetadata } from './worktree-metadata';

describe('mission-worktree-orchestrator', () => {
  let tmpDir: string;
  let worktreePath: string;
  let commonGitDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orch-test-'));
    worktreePath = path.join(tmpDir, 'worktree');
    commonGitDir = path.join(tmpDir, 'repo.git', 'worktrees', 'task-1');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(commonGitDir, { recursive: true });
    // Wire git pointer
    fs.writeFileSync(
      path.join(worktreePath, '.git'),
      `gitdir: ${commonGitDir}\n`,
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('prepares task worktree with canonical branch name and persists metadata', async () => {
    const mockRecord: WorktreeRecord = {
      id: 'worktree-1',
      scopeKey: 'proj-chk',
      projectId: 'proj',
      checkoutId: 'chk',
      missionId: 'mission-alpha',
      taskId: 'task-101',
      taskKey: 'task-101',
      workerId: 'worker-a',
      rootRealPath: '/repo',
      worktreePath,
      branchRef: 'refs/heads/task/task-101-auth',
      integrationRef: 'refs/heads/main',
      baseSha: 'abc',
      ownership: { files: [], symbols: [], domains: [] },
      dependencies: [],
      status: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const mockManager = {
      create: vi.fn().mockResolvedValue(mockRecord),
    } as unknown as WorktreeManager;

    const result = await prepareTaskWorktree({
      manager: mockManager,
      scope: {
        version: 1,
        installationId: 'inst',
        projectId: 'proj',
        checkoutId: 'chk',
        rootRealPath: '/repo',
        identitySource: 'manifest' as const,
      },
      missionId: 'mission-alpha',
      taskId: 'task-101',
      taskTitle: 'Implementar Autenticação OAuth',
      workerId: 'worker-a',
      baseRefName: 'main',
    });

    expect(result.branchName).toBe('task/task-101-implementar-autenticacao-oauth');
    expect(result.record).toBe(mockRecord);
    expect(result.metadata.baseRefName).toBe('main');
    expect(result.metadata.missionId).toBe('mission-alpha');

    const persisted = readWorktreeMetadata(worktreePath);
    expect(persisted?.branchName).toBe('task/task-101-implementar-autenticacao-oauth');
  });

  test('teardownTaskWorktree invokes archiveWorktree', () => {
    const mockRunner: GitRunner = {
      run: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
    };

    const result = teardownTaskWorktree({
      mainRepoPath: '/repo',
      worktreePath,
      force: true,
      runner: mockRunner,
    });

    expect(result.ok).toBe(true);
    expect(mockRunner.run).toHaveBeenCalledWith(
      '/repo',
      ['worktree', 'remove', '--force', worktreePath],
      expect.any(Object),
    );
  });
});
