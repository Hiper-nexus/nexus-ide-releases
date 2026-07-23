import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  getProjectDomainStores: vi.fn(),
  getContextWorkflowService: vi.fn(),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: mocks.getProjectDomainStores,
}));

vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: mocks.getContextWorkflowService,
}));

import { buildDomainTools } from './tools-domain';

const scope = testProjectScope();

function context(role: 'worker' | 'orchestrator'): AgentGateContext {
  return {
    token: `${role}-token`,
    label: role,
    role,
    missionId: 'mission-existing',
    sessionId: `${role}-session`,
    contextRevision: 'c'.repeat(64),
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function missionCreateTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === 'nexus_mission_create',
  );
  if (!tool) throw new Error('mission create tool is not registered');
  return tool;
}

function missionSetStatusTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === 'nexus_mission_set_status',
  );
  if (!tool) throw new Error('mission status tool is not registered');
  return tool;
}

describe('mission creation authority', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['worker', 'orchestrator'] as const)(
    'does not let a %s create a mission or promote its own gate context',
    async (role) => {
      const ctx = context(role);

      await expect(
        missionCreateTool().handler({ title: 'Privilege escalation' }, ctx),
      ).rejects.toThrow(/only a user-owned session may create a mission/i);

      expect(ctx.role).toBe(role);
      expect(ctx.missionId).toBe('mission-existing');
      expect(mocks.getProjectDomainStores).not.toHaveBeenCalled();
    },
  );

  it('rejects direct done when immutable PREVC receipts are incomplete', async () => {
    const setStatus = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          milestones: [{ id: 'step-a', status: 'done', evidenceIds: ['e1'] }],
        }),
        setStatus,
      },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      // Contrato PREVC congelado: as exigências PREVC permanecem intactas.
      getMissionWorkflow: () => ({
        contract: { contract: { contextRevision: 'rev' } },
        workflow: { stage: 'execution' },
      }),
    });

    await expect(missionSetStatusTool().handler(
      { missionId: 'mission-existing', status: 'done' },
      context('orchestrator'),
    )).rejects.toThrow(/immutable step receipts/i);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('allows standard-lane done with a durable note when no contract is frozen', async () => {
    const setStatus = vi.fn((id: string, status: string) => ({
      id,
      status,
    }));
    const appendLearning = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'standard' },
        }),
        setStatus,
        appendLearning,
      },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      // PREVC degrada: sem contrato congelado, done fecha com nota durável.
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });

    const result = await missionSetStatusTool().handler(
      {
        missionId: 'mission-existing',
        status: 'done',
        note: 'Form de login corrigido e validado manualmente no navegador.',
      },
      context('orchestrator'),
    );

    expect(result).toMatchObject({ id: 'mission-existing', status: 'done' });
    expect(setStatus).toHaveBeenCalledWith('mission-existing', 'done');
    expect(appendLearning).toHaveBeenCalledOnce();
  });

  it('rejects standard-lane done without a durable note when no contract is frozen', async () => {
    const setStatus = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'standard' },
        }),
        setStatus,
      },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });

    await expect(missionSetStatusTool().handler(
      { missionId: 'mission-existing', status: 'done', note: 'ok' },
      context('orchestrator'),
    )).rejects.toThrow(/without a frozen PREVC contract requires a durable note/i);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('allows ops-lane done with a durable note (no PREVC green required)', async () => {
    const setStatus = vi.fn((id: string, status: string) => ({
      id,
      status,
    }));
    const appendLearning = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'ops' },
        }),
        setStatus,
        appendLearning,
      },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });

    const result = await missionSetStatusTool().handler(
      {
        missionId: 'mission-existing',
        status: 'done',
        note: 'Backup tar.gz gerado na VPS e landing page publicada no nginx.',
      },
      context('orchestrator'),
    );

    expect(result).toMatchObject({ id: 'mission-existing', status: 'done' });
    expect(setStatus).toHaveBeenCalledWith('mission-existing', 'done');
    expect(appendLearning).toHaveBeenCalledOnce();
  });

  it('rejects ops-lane done without a durable note', async () => {
    const setStatus = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'ops' },
        }),
        setStatus,
      },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });

    await expect(missionSetStatusTool().handler(
      { missionId: 'mission-existing', status: 'done', note: 'ok' },
      context('orchestrator'),
    )).rejects.toThrow(/requires a durable note/i);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('does not regress a completed mission through the MCP status tool', async () => {
    const setStatus = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({ id: 'mission-existing', status: 'done', milestones: [] }),
        setStatus,
      },
    });

    await expect(missionSetStatusTool().handler(
      { missionId: 'mission-existing', status: 'running' },
      context('orchestrator'),
    )).rejects.toThrow(/immutable/i);
    expect(setStatus).not.toHaveBeenCalled();
  });
});
