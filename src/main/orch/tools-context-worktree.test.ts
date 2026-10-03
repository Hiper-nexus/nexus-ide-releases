import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { buildContextTools } from './tools-context';

const mocks = vi.hoisted(() => ({
  revoked: false, planPresent: true, mutationAllowed: true, dispatcherAllowed: true,
  update: vi.fn(), create: vi.fn(),
}));
vi.mock('../context/context-workflow-registry', () => ({
  getContextKnowledgeService: vi.fn(),
  getContextWorkflowService: () => ({ assertMutationAllowed: () => {
    if (!mocks.mutationAllowed) throw new Error('workflow closed');
  } }),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({ tasks: {
    list: () => mocks.planPresent ? [{ id: 'task-a' }] : [], update: mocks.update,
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
