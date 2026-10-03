import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedTaskStore, type ScopedTaskStore } from './task-store';
import { createScopedMissionStore } from './mission-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskStatus } from '../../shared/orch-types';
import type { AgentGateContext } from './gate';
import { buildContextTools } from './tools-context';

const mocks = vi.hoisted(() => ({
  revoked: false, planPresent: true, mutationAllowed: true, dispatcherAllowed: true,
  taskStatus: 'pending' as TaskStatus, taskUpdatedAt: 1, taskRevision: 1,
  tasks: undefined as ScopedTaskStore | undefined,
  update: vi.fn(), create: vi.fn(),
}));
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
vi.mock('../context/context-workflow-registry', () => ({
  getContextKnowledgeService: vi.fn(),
  getContextWorkflowService: () => ({ assertMutationAllowed: () => {
    if (!mocks.mutationAllowed) throw new Error('workflow closed');
  } }),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({ tasks: mocks.tasks ?? {
    list: () => mocks.planPresent ? [{ id: 'task-a', status: mocks.taskStatus, updatedAt: mocks.taskUpdatedAt }] : [],
    readMutationRevision: () => mocks.taskRevision, update: mocks.update,
  } }),
}));
vi.mock('./task-dispatch-authority', () => ({ assertMainTaskDispatcherAuthority: () => {
  if (!mocks.dispatcherAllowed) throw new Error('task_dispatcher_authority');
} }));
vi.mock('../runtime/worktree-runtime-registry', () => ({
  requireWorktreeRuntimeRegistry: () => ({ create: mocks.create }),
}));
vi.mock('../context/orientation/orientation-service', () => ({
  tryGetProjectOrientationService: () => undefined,
}));
const ctx: AgentGateContext = {
  token: 'test', label: 'test', role: 'orchestrator', missionId: 'mission-a', sessionId: 'session-a',
  scope: { version: 1, installationId: 'test', projectId: 'project-a', checkoutId: 'checkout-a',
    rootRealPath: '/workspace/a', identitySource: 'manifest' },
  allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
};
const input = { missionId: 'mission-a', taskId: 'task-a', workerId: 'worker-a',
  ownership: { files: ['fixture.ts'] } };
const tool = () => buildContextTools().find(t => t.name === 'nexus_worktree_create')!;
const invocation = { assertCurrentAuthority: () => {
  if (mocks.revoked) throw new Error('session_authority_revoked');
} };

describe('F-764 worktree creation authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.revoked = false; mocks.planPresent = true;
    mocks.mutationAllowed = true; mocks.dispatcherAllowed = true;
    mocks.taskStatus = 'pending'; mocks.taskUpdatedAt = 1; mocks.taskRevision = 1; mocks.tasks = undefined;
  });
  it.each(['invocation', 'workflow', 'plan', 'dispatcher'])(
    'rejects %s revocation during create before committing task running', async (authority) => {
      mocks.create.mockImplementation(async () => {
        await new Promise(resolve => setImmediate(resolve));
        if (authority === 'invocation') mocks.revoked = true;
        if (authority === 'workflow') mocks.mutationAllowed = false;
        if (authority === 'plan') mocks.planPresent = false;
        if (authority === 'dispatcher') mocks.dispatcherAllowed = false;
        return { status: 'ready' };
      });
      await expect(tool().handler(input, ctx, invocation)).rejects.toThrow();
      expect(mocks.update).not.toHaveBeenCalled();
    });
  it.each(['done', 'failed'] as const)('preserves task %s reached during awaited create', async (status) => {
    mocks.create.mockImplementation(async () => {
      await new Promise(resolve => setImmediate(resolve));
      mocks.taskStatus = status; // Same timestamp: status alone must fence completion.
      return { status: 'ready' };
    });
    await expect(tool().handler(input, ctx, invocation)).rejects.toThrow(/task.*changed|task.*terminal/);
    expect(mocks.taskStatus).toBe(status);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('revalidates task state in manager checkpoint before ready effects', async () => {
    mocks.create.mockImplementation(async (request) => {
      await new Promise(resolve => setImmediate(resolve));
      mocks.taskStatus = 'done';
      request.assertCurrentAuthority();
      return { status: 'ready' };
    });
    await expect(tool().handler(input, ctx, invocation)).rejects.toThrow(/task.*changed|task.*terminal/);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('rejects an already done task before starting creation', async () => {
    mocks.taskStatus = 'done';
    mocks.create.mockResolvedValue({ status: 'ready' });
    await expect(tool().handler(input, ctx, invocation)).rejects.toThrow(/task.*done|task.*terminal/);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('rejects stale task edits while creation awaits', async () => {
    mocks.create.mockImplementation(async () => {
      await new Promise(resolve => setImmediate(resolve));
      mocks.taskUpdatedAt += 1;
      return { status: 'ready' };
    });
    await expect(tool().handler(input, ctx, invocation)).rejects.toThrow(/task.*changed/);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('rejects task status ABA with identical status and clock', async () => {
    mocks.create.mockImplementation(async () => {
      await new Promise(resolve => setImmediate(resolve));
      mocks.taskStatus = 'done'; mocks.taskRevision++;
      mocks.taskStatus = 'pending'; mocks.taskRevision++;
      return { status: 'ready' };
    });
    await expect(tool().handler(input, ctx, invocation)).rejects.toThrow(/task.*changed/);
    expect(mocks.taskStatus).toBe('pending');
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('preserves failed-at-entry retry when task mutation identity remains unchanged', async () => {
    mocks.taskStatus = 'failed';
    mocks.create.mockResolvedValue({ status: 'ready' });
    await expect(tool().handler(input, ctx, invocation)).resolves.toMatchObject({ status: 'ready' });
    expect(mocks.update).toHaveBeenCalledWith('task-a', { status: 'running' });
  });
  it('rejects explicit failed-to-pending retry reset during creation', async () => {
    mocks.taskStatus = 'failed';
    mocks.create.mockImplementation(async () => {
      await new Promise(resolve => setImmediate(resolve));
      mocks.taskStatus = 'pending'; mocks.taskRevision++;
      return { status: 'ready' };
    });
    await expect(tool().handler(input, ctx, invocation)).rejects.toThrow(/task.*changed/);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(['done', 'failed', 'aba', 'other'] as const)(
    'fences actual free TaskStore mutations during creation (%s)', async (mutation) => {
      const baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-worktree-task-fence-')));
      const runtime = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
      const scope = testProjectScope({ rootRealPath: baseDir });
      try {
        createScopedMissionStore(runtime, scope, { now: () => 100, idFactory: () => 'mission-a' })
          .create({ title: 'Free mission' });
        const tasks = createScopedTaskStore(runtime, scope, { now: () => 100, idFactory: () => 'task-a' });
        tasks.create({ title: 'Target', missionId: 'mission-a' });
        mocks.tasks = tasks;
        mocks.create.mockImplementation(async () => {
          await new Promise(resolve => setImmediate(resolve));
          const otherFacade = createScopedTaskStore(runtime, scope, { now: () => 100, idFactory: () => 'other' });
          if (mutation === 'other') {
            const other = otherFacade.create({ title: 'Unrelated', missionId: 'mission-a' });
            otherFacade.update(other.id, { status: 'done' });
          } else if (mutation === 'aba') {
            runtime.open(scope).db.transaction(() => {
              otherFacade.update('task-a', { status: 'done' });
              otherFacade.update('task-a', { status: 'pending' });
            })();
          } else otherFacade.update('task-a', { status: mutation });
          return { status: 'ready' };
        });
        const result = tool().handler(input, { ...ctx, scope }, invocation);
        if (mutation === 'other') await expect(result).resolves.toMatchObject({ status: 'ready' });
        else await expect(result).rejects.toThrow(/task.*changed/);
        expect(tasks.list('mission-a').find(task => task.id === 'task-a')?.status)
          .toBe(mutation === 'other' ? 'running' : mutation === 'aba' ? 'pending' : mutation);
      } finally {
        mocks.tasks = undefined;
        runtime.closeAll();
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });
  it('threads authority through creation before manager ready effects', async () => {
    mocks.create.mockImplementation(async (request) => {
      await new Promise(resolve => setImmediate(resolve));
      mocks.revoked = true;
      request.assertCurrentAuthority();
      return { status: 'ready' };
    });
    await expect(tool().handler(input, ctx, invocation)).rejects.toThrow('session_authority_revoked');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
