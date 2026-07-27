import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  getProjectDomainStores: vi.fn(),
  getContextWorkflowService: vi.fn(),
  saveSquad: vi.fn(),
  createRemoteTmuxSession: vi.fn(),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: mocks.getProjectDomainStores,
}));

vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: mocks.getContextWorkflowService,
}));

vi.mock('./squad-store', () => ({
  findAgent: vi.fn(() => null),
  getSquad: vi.fn(() => null),
  listAgents: vi.fn(() => []),
  saveSquad: mocks.saveSquad,
}));

vi.mock('../remote/remote-spawn', () => ({
  createRemoteTmuxSession: mocks.createRemoteTmuxSession,
  detectRemoteClis: vi.fn(),
  listRemoteTmuxSessions: vi.fn(),
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

function squadSaveTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === 'nexus_squad_save',
  );
  if (!tool) throw new Error('squad save tool is not registered');
  return tool;
}

function remoteSpawnTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === 'nexus_remote_spawn',
  );
  if (!tool) throw new Error('remote spawn tool is not registered');
  return tool;
}

describe('mission creation authority', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['worker', 'orchestrator'] as const)(
    'does not let a mission %s poison the persistent squad catalog',
    async (role) => {
      await expect(
        squadSaveTool().handler(
          { squad: { id: 'poisoned-squad', name: 'Poisoned' } },
          context(role),
        ),
      ).rejects.toThrow(/operator-owned.*cannot mutate/i);
      expect(mocks.saveSquad).not.toHaveBeenCalled();
    },
  );

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
        appendLearning: vi.fn(),
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

  it('não aceita note como done de squad sem worker e handoff entregue', async () => {
    const setStatus = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          squadId: 'squad-orchestrated',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'standard' },
        }),
        setStatus,
      },
      missionPanes: { list: () => [] },
      handoffs: { list: () => [] },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });

    await expect(
      missionSetStatusTool().handler(
        {
          missionId: 'mission-existing',
          status: 'done',
          note: 'Implementei e validei tudo manualmente, sem qualquer delegação.',
        },
        context('orchestrator'),
      ),
    ).rejects.toThrow(/worker.*handoff/i);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('não confunde handoff apenas marcado submitted com aceite idle→busy comprovado', async () => {
    const setStatus = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          squadId: 'squad-orchestrated',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'standard' },
        }),
        setStatus,
      },
      missionPanes: { list: () => [{ role: 'worker' }] },
      handoffs: {
        list: () => [{ id: 'handoff-1', deliveryState: 'submitted' }],
        listDeliveryAttempts: () => [{ state: 'failed' }],
      },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });

    await expect(missionSetStatusTool().handler(
      {
        missionId: 'mission-existing',
        status: 'done',
        note: 'Worker produziu resultado, mas o orquestrador ainda não aceitou a entrega.',
      },
      context('orchestrator'),
    )).rejects.toThrow(/accepted handoff/i);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'nexus-trusted', 'worker-incarnation-current'],
    ['blocked', 'nexus-trusted', 'worker-incarnation-current'],
    ['progress', 'nexus-trusted', 'worker-incarnation-current'],
    ['success', 'unverified', 'worker-incarnation-current'],
    ['success', 'nexus-trusted', 'worker-incarnation-stale'],
    ['success', 'nexus-trusted', 'worker-incarnation-current'],
  ] as const)(
    'não promove squad legado por chamada direta (handoff=%s, trust=%s, incarnation=%s)',
    async (handoffStatus, evidenceTrust, workerIncarnationId) => {
      const setStatus = vi.fn();
      const getMission = vi.fn(() => ({
        id: 'mission-existing',
        status: 'running',
        squadId: 'squad-orchestrated',
        orchestratorSessionId: 'orchestrator-session',
        learnings: '',
        milestones: [],
        intentContract: { lane: 'standard' },
      }));
      const stores = {
        missions: {
          get: getMission,
          setStatus,
          appendLearning: vi.fn(),
        },
        missionPanes: {
          list: () => [{
            role: 'worker',
            paneId: 'worker-pane',
            workerIncarnationId: 'worker-incarnation-current',
          }],
        },
        handoffs: {
          list: () => [{
            id: 'handoff-1',
            missionId: 'mission-existing',
            sessionId: 'worker-session',
            workerIncarnationId,
            status: handoffStatus,
            evidenceTrust,
            evidenceIds: evidenceTrust === 'nexus-trusted' ? ['evidence-1'] : [],
            evidenceBinding:
              evidenceTrust === 'nexus-trusted'
                ? { missionId: 'mission-existing' }
                : undefined,
            deliveryState: 'submitted',
          }],
          listDeliveryAttempts: () => [{
            state: 'accepted',
            acceptedAt: 123,
            orchestratorSessionId: 'orchestrator-session',
          }],
        },
      };
      mocks.getProjectDomainStores.mockImplementation(() => stores);
      mocks.getContextWorkflowService.mockReturnValue({
        isMissionDriverComplete: () => false,
        getMissionWorkflow: () => ({ contract: null, workflow: null }),
      });
      await expect(
        missionSetStatusTool().handler(
          {
            missionId: 'mission-existing',
            status: 'done',
            note: 'Worker declarou conclusão, mas só o motor pode validar a cadeia inteira.',
          },
          context('orchestrator'),
        ),
      ).rejects.toThrow(/main-owned.*verified completion/i);
      expect(getMission).toHaveBeenCalledWith('mission-existing');
      expect(setStatus).not.toHaveBeenCalled();
    },
  );

  it('não aceita handoff aprovado por uma sessão de orquestrador já substituída', async () => {
    const setStatus = vi.fn((id: string, status: string) => ({ id, status }));
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          squadId: 'squad-orchestrated',
          orchestratorSessionId: 'orchestrator-session',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'standard' },
        }),
        setStatus,
        appendLearning: vi.fn(),
      },
      missionPanes: { list: () => [{ role: 'worker' }] },
      handoffs: {
        list: () => [{ id: 'handoff-1', deliveryState: 'submitted' }],
        listDeliveryAttempts: () => [{
          state: 'accepted',
          orchestratorSessionId: 'orchestrator-session-stale',
        }],
      },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });

    await expect(missionSetStatusTool().handler(
      {
        missionId: 'mission-existing',
        status: 'done',
        note: 'Worker concluiu, mas o aceite pertence a uma sessão antiga do orquestrador.',
      },
      context('orchestrator'),
    )).rejects.toThrow(/current orchestrator session/i);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('não deixa o orquestrador antecipar done de um plano selado', async () => {
    const setStatus = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          squadId: 'squad-orchestrated',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'standard', intentVersion: 3 },
        }),
        setStatus,
      },
      tasks: { hasPlan: () => true },
    });

    await expect(missionSetStatusTool().handler(
      {
        missionId: 'mission-existing',
        status: 'done',
        note: 'Worker disse que terminou, mas o merge e a entrega ainda não foram provados.',
      },
      context('orchestrator'),
    )).rejects.toThrow(/plano selado.*motor.*receipts/i);
    expect(setStatus).not.toHaveBeenCalled();
    expect(mocks.getContextWorkflowService).not.toHaveBeenCalled();
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

describe('remote spawn invocation authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRemoteTmuxSession.mockResolvedValue({
      ok: true,
      target: 'dev@example.com',
      sessionName: 'nexus-worker',
    });
  });

  it('passes the live MCP signal and authority fence into SSH/tmux creation', async () => {
    const controller = new AbortController();
    const assertCurrentAuthority = vi.fn();

    await remoteSpawnTool().handler(
      {
        target: 'dev@example.com',
        cli: 'codex',
        sessionName: 'nexus-worker',
        prompt: 'Run tests',
      },
      context('orchestrator'),
      {
        signal: controller.signal,
        assertCurrentAuthority,
      },
    );

    expect(mocks.createRemoteTmuxSession).toHaveBeenCalledWith(
      {
        target: 'dev@example.com',
        cwd: undefined,
        cli: 'codex',
        sessionName: 'nexus-worker',
        prompt: 'Run tests',
      },
      {
        signal: controller.signal,
        assertCurrentAuthority,
      },
    );
  });
});
