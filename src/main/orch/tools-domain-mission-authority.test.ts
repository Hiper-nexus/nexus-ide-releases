import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import { ProcessGitRunner } from '../runtime/git-command';

const mocks = vi.hoisted(() => ({
  getProjectDomainStores: vi.fn(),
  getContextWorkflowService: vi.fn(),
  saveSquad: vi.fn(),
  createRemoteTmuxSession: vi.fn(),
  completeVerified: vi.fn(),
  reconcile: vi.fn(),
  gitRun: vi.fn(),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: mocks.getProjectDomainStores,
}));

vi.mock('./civilian-delivery-completion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./civilian-delivery-completion')>()),
  maybeCompleteFastLaneOnDelivery: mocks.reconcile,
}));


vi.mock('./mission-engine-registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./mission-engine-registry')>();
  return {
    ...actual,
    missionEngineForScope: () => ({
      completeVerified: mocks.completeVerified,
    }),
  };
});
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

function completionPushFixture(status = 'running') {
  const result = { outcome: 'success', summary: 'Entrega verificada.' };
  let stored = {
    id: 'mission-existing', status, squadId: 'standard-team',
    orchestratorSessionId: 'orchestrator-session', learnings: '',
    intentVersion: 1, intentState: 'executing', updatedAt: 10,
    intentContract: { lane: 'standard' },
    result: status === 'done' ? result : undefined,
  };
  mocks.getProjectDomainStores.mockReturnValue({
    missions: { get: () => stored, appendLearning: vi.fn() },
  });
  return {
    finish: () => { stored = { ...stored, status: 'done', result }; },
    replaceSession: (sessionId = 'new-session') => { stored = { ...stored, orchestratorSessionId: sessionId }; },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('mission creation authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reconcile.mockReset().mockResolvedValue({ action: 'wait', completed: false, reason: 'review-in-progress' });
    mocks.gitRun.mockReset().mockReturnValue({ status: 0, stdout: 'Pushed', stderr: '' });
    vi.spyOn(ProcessGitRunner.prototype, 'run').mockImplementation(mocks.gitRun);
  });

  it('waits for explicitly requested push after slow verification and pushes once', async () => {
    const f = completionPushFixture();
    const pending = Promise.withResolvers<void>();
    mocks.reconcile.mockImplementation(async () => {
      await pending.promise;
      f.finish();
      return { action: 'complete', completed: true };
    });
    let settled = false;
    const operation = missionSetStatusTool().handler({
      missionId: 'mission-existing', status: 'done', push: { remote: 'origin', branch: 'main' },
    }, context('orchestrator')).then((result) => { settled = true; return result; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const waited = !settled;
    pending.resolve();
    const result = await operation;
    await mocks.reconcile.mock.results[0]!.value;

    expect(waited).toBe(true);
    expect(result).toMatchObject({ status: 'done', pushExecuted: true, pushPending: false });
    expect(mocks.gitRun).toHaveBeenCalledExactlyOnceWith(scope.rootRealPath, ['push', 'origin', 'main'], { timeoutMs: 60_000 });
  });

  it('reports a pending push when verification is waiting for a repair', async () => {
    completionPushFixture();
    mocks.reconcile.mockResolvedValue({ action: 'wait', completed: false, reason: 'repair-dispatched' });
    const result = await missionSetStatusTool().handler({
      missionId: 'mission-existing', status: 'done', push: {},
    }, context('orchestrator'));

    expect(result).toMatchObject({ status: 'running', pushExecuted: false, pushPending: true });
    expect((result as { message: string }).message).toMatch(/tente novamente|nova tentativa/iu);
    expect(mocks.gitRun).not.toHaveBeenCalled();
  });

  it('honors a fresh explicit push request for an already completed mission', async () => {
    completionPushFixture('done');
    const result = await missionSetStatusTool().handler({
      missionId: 'mission-existing', status: 'done', push: {},
    }, context('orchestrator'));

    expect(result).toMatchObject({ status: 'done', pushExecuted: true });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.gitRun).toHaveBeenCalledExactlyOnceWith(scope.rootRealPath, ['push', 'origin'], { timeoutMs: 60_000 });
  });

  it('requires an explicit current orchestrator binding for a completed push', async () => {
    const f = completionPushFixture('done');
    f.replaceSession('');
    await expect(missionSetStatusTool().handler({
      missionId: 'mission-existing', status: 'done', push: {},
    }, context('orchestrator'))).rejects.toThrow(/current orchestrator/i);
    expect(mocks.gitRun).not.toHaveBeenCalled();
  });

  it('refuses push when the orchestrator session changed while verification ran', async () => {
    const f = completionPushFixture();
    mocks.reconcile.mockImplementation(async () => {
      f.finish();
      f.replaceSession();
      return { action: 'complete', completed: true };
    });
    await expect(missionSetStatusTool().handler({
      missionId: 'mission-existing', status: 'done', push: {},
    }, context('orchestrator'))).rejects.toThrow(/orchestrator_session_stale/);
    expect(mocks.gitRun).not.toHaveBeenCalled();
  });

  it('revalidates MCP scope authority immediately before push', async () => {
    const f = completionPushFixture();
    let revoked = false;
    mocks.reconcile.mockImplementation(async () => {
      f.finish();
      revoked = true;
      return { action: 'complete', completed: true };
    });
    await expect(missionSetStatusTool().handler({
      missionId: 'mission-existing', status: 'done', push: {},
    }, context('orchestrator'), {
      assertCurrentAuthority: () => { if (revoked) throw new Error('scope authority changed'); },
    })).rejects.toThrow('scope authority changed');
    expect(mocks.gitRun).not.toHaveBeenCalled();
  });

  it.each([{ remote: '--force' }, { branch: '+main:main' }])('rejects force syntax passed as a push target: %j', async (push) => {
    const f = completionPushFixture();
    mocks.reconcile.mockImplementation(async () => {
      f.finish();
      return { action: 'complete', completed: true };
    });
    const result = await missionSetStatusTool().handler({
      missionId: 'mission-existing', status: 'done', push,
    }, context('orchestrator'));

    expect(result).toMatchObject({ pushExecuted: false });
    expect(mocks.gitRun).not.toHaveBeenCalled();
  });

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
    const setStatus = vi.fn();
    const appendLearning = vi.fn();
    let stored: Record<string, unknown> = {
      id: 'mission-existing',
      title: 'Login',
      status: 'running',
      intentState: 'executing',
      intentVersion: 2,
      updatedAt: 41,
      learnings: '',
      milestones: [],
      intentContract: { lane: 'standard' },
    };
    mocks.completeVerified.mockImplementation(
      (
        _scope: unknown,
        input: { result: unknown; learnings: string },
      ) => {
        stored = {
          ...stored,
          status: 'done',
          intentState: 'done',
          result: input.result,
          learnings: input.learnings,
        };
      },
    );
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => stored,
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

    expect(result).toMatchObject({
      id: 'mission-existing',
      status: 'done',
      result: {
        outcome: 'success',
        summary: 'Form de login corrigido e validado manualmente no navegador.',
      },
    });
    expect(mocks.completeVerified).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        missionId: 'mission-existing',
        expectedStatus: 'running',
        result: expect.objectContaining({ outcome: 'success' }),
      }),
    );
    expect(setStatus).not.toHaveBeenCalled();
    expect(appendLearning).not.toHaveBeenCalled();
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
        appendLearning: vi.fn(),
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
    ).resolves.toMatchObject({ status: 'running', completionRequested: true });
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
        appendLearning: vi.fn(),
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
    )).resolves.toMatchObject({ status: 'running', completionRequested: true });
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
      ).resolves.toMatchObject({ status: 'running', completionRequested: true });
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
    )).resolves.toMatchObject({ status: 'running', completionRequested: true });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('Via Rápida devolve done somente quando a reconciliação confirma conclusão', async () => {
    // A dor real: fast-lane não congela contrato nem tem dispatch authority
    // POR CONSTRUÇÃO — o throw incondicional impedia QUALQUER done do
    // Maestro (missão real: "2 handoffs success consumidos" e mesmo assim
    // blocked). Na Via Rápida o ack do orquestrador corrente É a verificação:
    // o main testemunhou os dois lados (worker entregou, Maestro leu e
    // ack'ou). Nota durável ≥40 mantém o "nunca verde silencioso".
    let mission: Record<string, unknown> = {
      id: 'mission-existing',
      status: 'running',
      squadId: 'squad-orchestrated',
      orchestratorSessionId: 'orchestrator-current',
      learnings: '',
      milestones: [],
      intentContract: { lane: 'standard' },
      intentVersion: 1,
      intentState: 'executing',
      updatedAt: 1,
      title: 'Prova',
      description: '',
    };
    mocks.reconcile.mockImplementation(async () => {
      mission = {
        ...mission,
        status: 'done',
        result: { outcome: 'success', summary: 'ok', evidenceIds: [], artifactRefs: [] },
      };
      return { action: 'complete', completed: true };
    });
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => mission,
        setStatus: vi.fn(),
        appendLearning: vi.fn(),
        update: vi.fn(),
      },
      handoffs: {
        list: () => [
          {
            id: 'handoff-final',
            missionId: 'mission-existing',
            status: 'success',
            deliveryState: 'consumed',
          },
        ],
        listDeliveryAttempts: () => [
          {
            state: 'accepted',
            acceptedAt: 123,
            orchestratorSessionId: 'orchestrator-current',
          },
        ],
      },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });

    const result = (await missionSetStatusTool().handler(
      {
        missionId: 'mission-existing',
        status: 'done',
        note: 'Entregue e verificado: arquivos criados e handoff consumido pelo orquestrador corrente.',
      },
      context('orchestrator'),
    )) as Record<string, unknown>;

    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.completeVerified).not.toHaveBeenCalled();
    expect(result.status).toBe('done');
  });

  it('pedido done durante reparo é aceito e não muda status ou chama completeVerified diretamente', async () => {
    const mission = {
      id: 'mission-existing', status: 'running', squadId: 'standard-team',
      learnings: '', intentVersion: 1, intentState: 'executing', updatedAt: 10,
      intentContract: { lane: 'standard' },
    };
    const appendLearning = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({ missions: { get: () => mission, appendLearning } });
    mocks.reconcile.mockResolvedValue({ action: 'wait', completed: false, reason: 'repair-dispatched' });

    const result = await missionSetStatusTool().handler({ missionId: mission.id, status: 'done', note: 'Entrega inicial enviada.' }, context('orchestrator'));

    expect(result).toMatchObject({ status: 'running', completionRequested: true });
    expect(appendLearning).toHaveBeenCalledWith(mission.id, '## Solicitação de conclusão\nEntrega inicial enviada.');
    expect(mocks.reconcile).toHaveBeenCalledWith(scope, mission.id);
    expect(mocks.completeVerified).not.toHaveBeenCalled();
  });

  it('libera o turno enquanto sensores trabalham e deixa a reconciliação concluir depois', async () => {
    let stored: Record<string, unknown> = {
      id: 'mission-existing', status: 'running', squadId: 'standard-team',
      learnings: '', intentVersion: 1, intentState: 'executing', updatedAt: 10,
      intentContract: { lane: 'standard' },
    };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mocks.getProjectDomainStores.mockReturnValue({ missions: { get: () => stored, appendLearning: vi.fn() } });
    mocks.reconcile.mockImplementation(async () => {
      await pending;
      stored = { ...stored, status: 'done', result: { outcome: 'success', summary: 'Verificado e concluído.' } };
      return { action: 'complete', completed: true };
    });

    const response = await missionSetStatusTool().handler({ missionId: 'mission-existing', status: 'done' }, context('orchestrator'));
    expect(response).toMatchObject({ status: 'running', completionRequested: true });
    release();
    await vi.waitFor(() => expect(stored.status).toBe('done'));
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.completeVerified).not.toHaveBeenCalled();
  });

  it('Via Rápida: sem aceite da sessão CORRENTE o done continua recusado', async () => {
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          squadId: 'squad-orchestrated',
          orchestratorSessionId: 'orchestrator-current',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'standard' },
        }),
        setStatus: vi.fn(),
        appendLearning: vi.fn(),
      },
      handoffs: {
        list: () => [
          {
            id: 'handoff-old',
            missionId: 'mission-existing',
            status: 'success',
            deliveryState: 'consumed',
          },
        ],
        listDeliveryAttempts: () => [
          {
            state: 'accepted',
            acceptedAt: 123,
            orchestratorSessionId: 'orchestrator-PRE-rebind',
          },
        ],
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
        note: 'Handoff consumido, mas por sessão anterior do orquestrador — sem prova corrente.',
      },
      context('orchestrator'),
    )).resolves.toMatchObject({ status: 'running', completionRequested: true });
    expect(mocks.completeVerified).not.toHaveBeenCalled();
  });

  it('não deixa o orquestrador antecipar done de missão standard com squad', async () => {
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
        appendLearning: vi.fn(),
      },
      tasks: {
        hasPlan: () => true,
        getPlanReceipt: () => ({ tasks: [] }),
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
        note: 'Worker disse que terminou, mas o merge e a entrega ainda não foram provados.',
      },
      context('orchestrator'),
    )).resolves.toMatchObject({ status: 'running', completionRequested: true });
    expect(setStatus).not.toHaveBeenCalled();
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
        appendLearning: vi.fn(),
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
    const setStatus = vi.fn();
    const appendLearning = vi.fn();
    let stored: Record<string, unknown> = {
      id: 'mission-existing',
      title: 'Publicação operacional',
      status: 'running',
      intentState: 'executing',
      intentVersion: 4,
      updatedAt: 73,
      learnings: '',
      milestones: [],
      intentContract: { lane: 'ops' },
    };
    mocks.completeVerified.mockImplementation(
      (
        _scope: unknown,
        input: { result: unknown; learnings: string },
      ) => {
        stored = {
          ...stored,
          status: 'done',
          intentState: 'done',
          result: input.result,
          learnings: input.learnings,
        };
      },
    );
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => stored,
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

    expect(result).toMatchObject({
      id: 'mission-existing',
      status: 'done',
      result: {
        outcome: 'success',
        summary: 'Backup tar.gz gerado na VPS e landing page publicada no nginx.',
      },
    });
    expect(mocks.completeVerified).toHaveBeenCalledOnce();
    expect(setStatus).not.toHaveBeenCalled();
    expect(appendLearning).not.toHaveBeenCalled();
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
        appendLearning: vi.fn(),
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
        appendLearning: vi.fn(),
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
