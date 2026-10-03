import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureWorktreeRuntimeRegistry, disposeWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { preparePaneSpaceWorktree } from '../pty/pane-space-worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import { ProcessGitRunner } from '../runtime/git-command';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import { awaitsOperatorTabCompletionRequest } from './operator-tab-completion';

const mocks = vi.hoisted(() => ({
  getProjectDomainStores: vi.fn(),
  getContextWorkflowService: vi.fn(),
  saveSquad: vi.fn(),
  createRemoteTmuxSession: vi.fn(),
  completeVerified: vi.fn(),
  reconcile: vi.fn(),
  gitRun: vi.fn(),
  getOrchSettings: vi.fn(() => ({ squadCliPolicy: 'operator-choice' })),
  requireMissionLeaderSession: vi.fn(
    (_scope: unknown, missionId: string, ctx: { sessionId?: string | null }) => {
      try {
        const leaderSessionId = mocks.getProjectDomainStores().missions.get(missionId)
          ?.orchestratorSessionId;
        if (!leaderSessionId) return { ok: false, code: 'no-leader', hint: 'sem líder durável' };
        if (Object.hasOwn(ctx, 'sessionId') && ctx.sessionId !== leaderSessionId) {
          return { ok: false, code: 'stale-session', hint: 'sessão obsoleta' };
        }
        return {
          ok: true,
          leader: { sessionId: leaderSessionId, paneId: null, source: 'live', proven: true },
        };
      } catch {
        return { ok: false, code: 'no-leader', hint: 'store indisponível' };
      }
    },
  ),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: mocks.getProjectDomainStores,
}));

/**
 * Default: models the resolver as "the mocked mission's durable
 * orchestratorSessionId is the current proven leader" — the same ground
 * truth these tests already set up by hand, so existing scenarios keep
 * working while genuinely exercising the leader-identity check
 * (mission-leader-gate.test.ts owns the resolution engine's own
 * correctness). Individual tests override this to prove the resolver — not
 * just the raw durable field — is what gates completion.
 */
vi.mock('./mission-leader-gate', () => ({
  requireMissionLeaderSession: mocks.requireMissionLeaderSession,
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
  listSquads: vi.fn(() => []),
  saveSquad: mocks.saveSquad,
}));

vi.mock('../persistence/settings-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../persistence/settings-store')>()),
  getOrchSettings: mocks.getOrchSettings,
}));

vi.mock('../remote/remote-spawn', () => ({
  createRemoteTmuxSession: mocks.createRemoteTmuxSession,
  detectRemoteClis: vi.fn(),
  listRemoteTmuxSessions: vi.fn(),
}));

import { buildDomainTools } from './tools-domain';
import { createScopedMissionStore } from './mission-store';
import { createScopedMissionPaneStore } from './mission-pane-store';
import * as paneRegistry from './pane-registry';
import { assertMissionIntentAllowsTool } from './mission-intent-gate';
import { listSquads } from './squad-store';
import {
  isFreeAgentChoiceContract,
  requiresRouteReservation,
  squadBindingViolationError,
} from './free-agent-choice';
import {
  assertWorkerBudget,
  hasCurrentDispatchAuthority,
  type MissionIntentContract,
} from '../../shared/mission-intent';
import type { Mission } from '../../shared/orch-types';

const scope = testProjectScope();
const realGitRun = ProcessGitRunner.prototype.run;

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
  // F-234: o portão de integração exige veredito "approve" de modelo de ponta
  // para o HEAD exato; a fixture devolve um veredito aprovador por padrão.
  const latestVerdict = vi.fn(() => ({
    verdict: 'approve' as const,
    frontier: true,
  }));
  mocks.getProjectDomainStores.mockReturnValue({
    missions: {
      get: () => stored,
      appendLearning: vi.fn(),
      reviewVerdicts: { latestFor: latestVerdict },
    },
  });
  return {
    finish: () => { stored = { ...stored, status: 'done', result }; },
    bindSpace: (spaceId: string) => { stored.intentContract = Object.assign({}, stored.intentContract, { workspaceBinding: { version: 1, spaceId } }); },
    replaceSession: (sessionId = 'new-session') => { stored = { ...stored, orchestratorSessionId: sessionId }; },
    latestVerdict,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('mission creation authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reconcile.mockReset().mockResolvedValue({ action: 'wait', completed: false, reason: 'review-in-progress' });
    // F-234: o portão mede HEAD/árvore com o mesmo runner — responda por
    // subcomando em vez de um stdout único.
    mocks.gitRun.mockReset().mockImplementation(
      (_cwd: unknown, args: readonly string[]) => {
        if (args[0] === 'rev-parse') {
          return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
        }
        if (args[0] === 'status' || args[0] === 'config') {
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: 'Pushed', stderr: '' };
      },
    );
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
    const pushes = mocks.gitRun.mock.calls.filter((call) => call[1][0] === 'push');
    expect(pushes).toEqual([[scope.rootRealPath, ['push', 'origin', 'main'], { timeoutMs: 60_000 }]]);
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

  it('pushes only the current tab branch, without upstream, and refuses a different main ref', async () => {
    const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tab-push-')));
    const root = path.join(directory, 'repo'); fs.mkdirSync(root);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.name', 'Nexus Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, 'file.txt'), 'baseline'); git('add', 'file.txt'); git('commit', '-qm', 'baseline');
    const coordination = testProjectScope({ rootRealPath: root });
    const manager = new ProjectRuntimeManager({ baseDir: path.join(directory, 'runtime'), appVersion: 'test' });
    configureWorktreeRuntimeRegistry(manager);
    mocks.gitRun.mockImplementation((cwd, args, options) => args[0] === 'push'
      ? { status: 0, stdout: 'Fixture push accepted', stderr: '' }
      : realGitRun.call(new ProcessGitRunner(), cwd, args, options));
    try {
      const tab = await preparePaneSpaceWorktree(coordination, 'space-push');
      const f = completionPushFixture('done'); f.bindSpace('space-push');
      const ctx = { ...context('orchestrator'), scope: coordination, executionScope: tab.scope };
      const result = await missionSetStatusTool().handler({ missionId: 'mission-existing', status: 'done', push: {} }, ctx);
      expect(result).toMatchObject({ pushExecuted: true });
      const pushes = mocks.gitRun.mock.calls.filter(call => call[1][0] === 'push');
      expect(pushes).toHaveLength(1);
      expect(pushes[0]![0]).toBe(tab.cwd);
      expect(pushes[0]![1]).toEqual(['push', 'origin', expect.stringMatching(/^nexus\//)]);
      await expect(missionSetStatusTool().handler({ missionId: 'mission-existing', status: 'done', push: { branch: 'main' } }, ctx)).rejects.toThrow('branch atual');
      expect(mocks.gitRun.mock.calls.filter(call => call[1][0] === 'push')).toHaveLength(1);
    } finally {
      disposeWorktreeRuntimeRegistry(); manager.closeAll(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('honors a fresh explicit push request for an already completed mission', async () => {
    completionPushFixture('done');
    const result = await missionSetStatusTool().handler({
      missionId: 'mission-existing', status: 'done', push: {},
    }, context('orchestrator'));

    expect(result).toMatchObject({ status: 'done', pushExecuted: true });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    const pushes = mocks.gitRun.mock.calls.filter((call) => call[1][0] === 'push');
    expect(pushes).toEqual([[scope.rootRealPath, ['push', 'origin'], { timeoutMs: 60_000 }]]);
  });

  it('skips the push (not the status) when no frontier verdict covers the HEAD', async () => {
    const f = completionPushFixture('done');
    f.latestVerdict.mockReturnValue(null as never);
    const result = await missionSetStatusTool().handler({
      missionId: 'mission-existing', status: 'done', push: {},
    }, context('orchestrator'));

    expect(result).toMatchObject({
      status: 'done',
      pushExecuted: false,
      pushSkipped: 'review_required',
    });
    expect((result as { message: string }).message).toContain('review_required');
    expect(
      mocks.gitRun.mock.calls.filter((call) => call[1][0] === 'push'),
    ).toHaveLength(0);
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
    // F-234: o portão de veredito mede HEAD/árvore pelo mesmo runner antes do
    // push — a invariante é "nenhum `git push` roda", não "nenhum git roda".
    expect(
      mocks.gitRun.mock.calls.some((call) => call[1]?.[0] === 'push'),
    ).toBe(false);
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

  describe('mão do operador cria a própria missão (campo 23/09)', () => {
    function operatorHand(): AgentGateContext {
      return {
        token: 'user-token',
        label: 'operador',
        role: 'user',
        sessionId: 'operator-session',
        scope,
        allowedTools: null,
        allowedSkills: null,
        stopAttempts: 0,
        handoffSubmitted: false,
      };
    }

    function missionStores() {
      let created: Record<string, unknown> = {};
      const create = vi.fn((input: Record<string, unknown>) => {
        created = {
          id: 'mission-new',
          description: '',
          status: 'pending',
          milestones: [],
          learnings: '',
          createdAt: 1,
          updatedAt: 1,
          ...input,
        };
        return created;
      });
      const update = vi.fn((id: string, patch: { status?: string }) =>
        id === created.id ? { ...created, ...patch, updatedAt: 2 } : null,
      );
      mocks.getProjectDomainStores.mockReturnValue({
        missions: { create, update, atomically: <T>(fn: () => T) => fn() },
        missionPanes: { record: vi.fn() },
      });
      return { create, update };
    }

    beforeEach(() => {
      // O catálogo real tem o nexus-fullstack: é ele que o Nexus colava em
      // toda missão da mão do operador sem ninguém pedir.
      vi.mocked(listSquads).mockReturnValue([
        { id: 'nexus-fullstack', name: 'Nexus Fullstack', agents: [] } as never,
      ]);
    });
    afterEach(() => vi.mocked(listSquads).mockReturnValue([]));

    it('criar é atômico: pane de outra missão viva recusa SEM gravar a missão', async () => {
      mocks.getOrchSettings.mockReturnValue({ squadCliPolicy: 'operator-choice' });
      vi.spyOn(paneRegistry, 'findPane').mockReturnValue({
        paneId: 'pane-operator', adapterId: 'codex',
      } as never);
      const create = vi.fn();
      const record = vi.fn();
      mocks.getProjectDomainStores.mockReturnValue({
        missions: {
          create,
          update: vi.fn(),
          remove: vi.fn(),
          get: (id: string) => (id === 'mission-live' ? { id, status: 'running' } : null),
        },
        missionPanes: {
          record,
          findByPaneId: () => ({ missionId: 'mission-live', role: 'orchestrator' }),
        },
      });
      const ctx = operatorHand();

      await expect(
        missionCreateTool().handler({ title: 'Lote duplicado' }, ctx),
      ).rejects.toThrow(/mission-live.*nenhuma missão nova foi criada/);

      expect(create).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(ctx.role).toBe('user');
    });

    it.each([
      ['no registro do pane', 'record'],
      ['no update para running (SQLITE_FULL)', 'update'],
    ] as const)('criar é atômico em SQLite real: falha %s não deixa missão, pane nem aviso', async (_label, failing) => {
      mocks.getOrchSettings.mockReturnValue({ squadCliPolicy: 'operator-choice' });
      vi.spyOn(paneRegistry, 'findPane').mockReturnValue({
        paneId: 'pane-operator', adapterId: 'codex',
      } as never);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mission-create-'));
      const manager = new ProjectRuntimeManager({ baseDir: directory, appVersion: 'test' });
      try {
        const missions = createScopedMissionStore(manager, scope);
        const missionPanes = createScopedMissionPaneStore(manager, scope);
        mocks.getProjectDomainStores.mockReturnValue({ missions, missionPanes });
        const changes: string[] = [];
        missions.onChange(() => changes.push('missions'));
        missionPanes.onChange(() => changes.push('mission-panes'));
        const diskFull = () => {
          throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
        };
        const fail = failing === 'record'
          ? vi.spyOn(missionPanes, 'record').mockImplementationOnce(diskFull)
          : vi.spyOn(missions, 'update').mockImplementationOnce(diskFull);
        const ctx = operatorHand();

        await expect(
          missionCreateTool().handler({ title: 'Lote duplicado' }, ctx),
        ).rejects.toThrow(/disk is full/);

        expect(fail).toHaveBeenCalledOnce();
        expect(missions.list()).toEqual([]);
        expect(missionPanes.findByPaneId('pane-operator')).toBeNull();
        expect(changes).toEqual([]);
        expect(ctx.role).toBe('user');
        expect(ctx.missionId).toBeUndefined();

        // A próxima tentativa não fica bloqueada por uma missão fantasma.
        const mission = (await missionCreateTool().handler(
          { title: 'Lote duplicado' }, ctx,
        )) as { id: string; status: string };
        expect(mission.status).toBe('running');
        expect(missionPanes.findByPaneId('pane-operator')?.missionId).toBe(mission.id);
        expect(changes).toContain('missions');
        expect(ctx).toMatchObject({ role: 'orchestrator', missionId: mission.id });
      } finally {
        manager.closeAll();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it('Autopilot: a missão nasce rodando e a mão continua abrindo panes', async () => {
      // O pane do operador já abria panes sem missão. Criar a missão o
      // promovia a orquestrador de uma missão PENDENTE — e todo pane_spawn
      // passava a voltar dispatch_required até alguém clicar em Despachar.
      mocks.getOrchSettings.mockReturnValue({ squadCliPolicy: 'operator-choice' });
      const { update } = missionStores();
      const ctx = operatorHand();

      const mission = (await missionCreateTool().handler(
        { title: 'Fechar o Epic 22' },
        ctx,
      )) as { id: string; status: string };

      expect(update).toHaveBeenCalledWith('mission-new', { status: 'running' });
      expect(mission.status).toBe('running');
      expect(ctx).toMatchObject({ role: 'orchestrator', missionId: 'mission-new' });
      const gate = assertMissionIntentAllowsTool(
        'nexus_pane_spawn',
        { mission: mission as never, scope, role: ctx.role, sessionId: ctx.sessionId },
        { adapterId: 'codex', prompt: 'Feche a 22.1 num worktree próprio.' },
      );
      expect(gate.ok).toBe(true);
    });

    it('Autopilot: a missão nasce em modo livre, despachada e sem squad imposto', async () => {
      // Campo 25/09: a missão nascia sem contrato e presa ao nexus-fullstack.
      // O spawn real recusava cada worker — approval_required (sem contrato),
      // squad_binding_violation (agy fora do roster) e
      // route_reservation_required (claude sem reserva) — e o agente pedia ao
      // operador um despacho em "modo livre" que o Quadro não oferece.
      mocks.getOrchSettings.mockReturnValue({ squadCliPolicy: 'operator-choice' });
      const { create } = missionStores();

      const mission = (await missionCreateTool().handler(
        {
          title: 'Revisão visual HiperGO',
          description: 'Crítica de design de todas as superfícies do app web.',
          milestones: ['Relatório final com o plano de redesign'],
        },
        operatorHand(),
      )) as unknown as Mission;

      const input = create.mock.calls[0]![0];
      expect(input.squadId).toBeUndefined();
      expect(input).toMatchObject({ intentState: 'dispatched', intentVersion: 1 });
      expect(mission.intentContract).toMatchObject({
        goal: 'Crítica de design de todas as superfícies do app web.',
        acceptanceCriteria: ['Relatório final com o plano de redesign'],
        freeAgentChoice: true,
        intentVersion: 1,
      });
      // As três condições que o spawn de worker da missão exige.
      expect(hasCurrentDispatchAuthority(mission)).toBe(true);
      const free = isFreeAgentChoiceContract(mission.intentContract);
      expect(
        squadBindingViolationError({
          hasNamedAgent: false,
          missionSquadId: mission.squadId,
          rosterClis: new Set(['claude', 'codex']),
          adapterId: 'agy',
          freeAgentChoice: free,
        }),
      ).toBeNull();
      expect(
        requiresRouteReservation({
          missionRunning: mission.status === 'running',
          rosterRouteAuthorized: false,
          freeAgentChoice: free,
        }),
      ).toBe(false);
    });

    it.each([
      ['consulta (investigar)', 'Investigar por que o login está lento', 'standard'],
      ['análise (campo do relatório)', 'Analise o fluxo de login e liste os riscos', 'standard'],
      ['planejamento', 'Planejar a arquitetura do módulo de pagamentos', 'standard'],
      ['operação (deploy)', 'Deploy do site no servidor', 'standard'],
      ['atualização que escreve (dependências)', 'Atualize as dependências do repositório', 'standard'],
      ['sincronização Git somente operacional', 'Atualiza o repositório local com o GitHub', 'ops'],
      ['sync por merge fast-forward', 'Sincronizar git com git merge --ff-only origin/main', 'ops'],
      ['pedido misto ("sincronize e corrija")', 'Sincronize o repositório e corrija o bug do login', 'standard'],
    ] as const)('Autopilot: criação MCP de %s materializa a lane correta no contrato', async (_label, title, lane) => {
      // F-785: a missão da aba nascia sempre standard; o set_status recusava
      // done de uma sincronização real ("sem entrega real no projeto") embora
      // o gate de entrega já aceitasse ops/consulta sem arquivo.
      // F-810: só a sincronização explícita vira ops — consult/plan/ops por
      // texto livre zeravam maxWorkers e o pane não abria helper nenhum.
      mocks.getOrchSettings.mockReturnValue({ squadCliPolicy: 'operator-choice' });
      const { create } = missionStores();

      await missionCreateTool().handler({ title }, operatorHand());

      const contract = create.mock.calls[0]![0].intentContract as MissionIntentContract;
      expect(contract).toMatchObject({ lane });
      if (lane === 'standard') {
        expect(contract.budgets.maxWorkers).toBeGreaterThan(0);
        expect(assertWorkerBudget(contract, 0)).toEqual({ ok: true });
      }
    });

    it.each([
      ['Analise o fluxo de login e liste os riscos', 'standard'],
      ['Planejar a arquitetura do módulo de pagamentos', 'standard'],
      ['Sincronizar git com git merge --ff-only origin/main', 'ops'],
    ] as const)('Hardened com aba isolada (F-810): "%s" nasce %s no contrato aguardando aprovação', async (title, lane) => {
      mocks.getOrchSettings.mockReturnValue({ squadCliPolicy: 'governed' });
      const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hardened-lane-')));
      const root = path.join(directory, 'repo'); fs.mkdirSync(root);
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
      git('init', '-q'); git('config', 'user.name', 'Nexus Fixture'); git('config', 'user.email', 'fixture@example.invalid');
      fs.writeFileSync(path.join(root, 'file.txt'), 'baseline'); git('add', 'file.txt'); git('commit', '-qm', 'baseline');
      const coordination = testProjectScope({ rootRealPath: root });
      const manager = new ProjectRuntimeManager({ baseDir: path.join(directory, 'runtime'), appVersion: 'test' });
      configureWorktreeRuntimeRegistry(manager);
      mocks.gitRun.mockImplementation((cwd, args, options) =>
        realGitRun.call(new ProcessGitRunner(), cwd, args, options));
      try {
        const tab = await preparePaneSpaceWorktree(coordination, 'space-hardened-lane');
        const { create } = missionStores();
        await missionCreateTool().handler(
          { title },
          { ...operatorHand(), scope: coordination, executionScope: tab.scope },
        );
        const input = create.mock.calls[0]![0];
        expect(input.intentState).toBe('awaiting_approval');
        expect(input.intentContract).toMatchObject({ lane });
        if (lane === 'standard') {
          expect((input.intentContract as MissionIntentContract).budgets.maxWorkers).toBeGreaterThan(0);
        }
      } finally {
        disposeWorktreeRuntimeRegistry(); manager.closeAll(); fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it('Hardened: a missão criada pela mão do operador espera o despacho na interface', async () => {
      mocks.getOrchSettings.mockReturnValue({ squadCliPolicy: 'governed' });
      const { create, update } = missionStores();

      const mission = (await missionCreateTool().handler(
        { title: 'Fechar o Epic 22' },
        operatorHand(),
      )) as { status: string };

      expect(update).not.toHaveBeenCalled();
      expect(mission.status).toBe('pending');
      const input = create.mock.calls[0]![0];
      expect(input.squadId).toBe('nexus-fullstack');
      expect(input).not.toHaveProperty('intentContract');
    });
  });

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

  it('F-785: lane ops conclui sem arquivo com nota durável, e o contrato não muda', async () => {
    // A sincronização real não produz arquivo: ops + nota ≥40 fecha done.
    // set_status NUNCA troca a categoria retroativamente para escapar do gate.
    let stored: Record<string, unknown> = {
      id: 'mission-existing',
      title: 'Atualiza o repositório local com o GitHub',
      status: 'running',
      intentState: 'executing',
      intentVersion: 1,
      updatedAt: 41,
      learnings: '',
      milestones: [],
      intentContract: { lane: 'ops', goal: 'Atualiza o repositório local com o GitHub' },
    };
    mocks.completeVerified.mockImplementation(
      (_scope: unknown, input: { result: unknown; learnings: string }) => {
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
        setStatus: vi.fn(),
        appendLearning: vi.fn(),
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
        note: 'Merge --ff-only de origin/main aplicado; HEAD local atualizado sem conflitos.',
      },
      context('orchestrator'),
    );

    expect(result).toMatchObject({ id: 'mission-existing', status: 'done' });
    expect(mocks.completeVerified).toHaveBeenCalledOnce();
    // A categoria registrada na criação é a que vale — nada foi reclassificado.
    expect(stored.intentContract).toMatchObject({ lane: 'ops' });
  });

  it('F-785: lane ops com nota vaga (<40) NÃO usa a exceção', async () => {
    const stored: Record<string, unknown> = {
      id: 'mission-existing',
      title: 'Sync',
      status: 'running',
      intentState: 'executing',
      intentVersion: 1,
      updatedAt: 41,
      learnings: '',
      milestones: [],
      intentContract: { lane: 'ops' },
    };
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => stored,
        setStatus: vi.fn(),
        appendLearning: vi.fn(),
      },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });

    await expect(
      missionSetStatusTool().handler(
        { missionId: 'mission-existing', status: 'done', note: 'feito' },
        context('orchestrator'),
      ),
    ).rejects.toThrow(/durable note/);
    expect(mocks.completeVerified).not.toHaveBeenCalled();
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
    // lane standard + squad exempto de revisão automática (Pet Studio) chega
    // no caminho "ack do orquestrador corrente É a verificação" sem depender
    // da reconciliação assíncrona.
    const setStatus = vi.fn((id: string, status: string) => ({ id, status }));
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          squadId: PET_STUDIO_SQUAD_ID,
          orchestratorSessionId: 'orchestrator-session',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'standard' },
        }),
        setStatus,
        appendLearning: vi.fn(),
      },
      handoffs: {
        list: () => [{ id: 'handoff-1', status: 'success', deliveryState: 'consumed' }],
        listDeliveryAttempts: () => [{
          state: 'accepted',
          acceptedAt: 100,
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
        note: 'Worker concluiu, mas o aceite pertence a uma sessão antiga do orquestrador substituída.',
      },
      context('orchestrator'),
    )).rejects.toThrow(/main-owned verified completion required/);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('split-brain no líder recusa done mesmo com o campo durável e o attempt concordando', async () => {
    // Prova que o gate consulta o resolver, não só o campo cru: o campo
    // durável e o attempt concordam, mas o resolver mesmo assim recusa.
    mocks.getProjectDomainStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-existing',
          status: 'running',
          squadId: PET_STUDIO_SQUAD_ID,
          orchestratorSessionId: 'orchestrator-current',
          learnings: '',
          milestones: [],
          intentContract: { lane: 'standard' },
        }),
        setStatus: vi.fn(),
        appendLearning: vi.fn(),
      },
      handoffs: {
        list: () => [{ id: 'handoff-1', status: 'success', deliveryState: 'consumed' }],
        listDeliveryAttempts: () => [{
          state: 'accepted',
          acceptedAt: 100,
          orchestratorSessionId: 'orchestrator-current',
        }],
      },
    });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      getMissionWorkflow: () => ({ contract: null, workflow: null }),
    });
    mocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false, code: 'split-brain', hint: 'duas sessões vivas reivindicam a missão',
    });

    await expect(missionSetStatusTool().handler(
      {
        missionId: 'mission-existing',
        status: 'done',
        note: 'Entregue e verificado: arquivos criados e handoff consumido pelo orquestrador corrente.',
      },
      context('orchestrator'),
    )).rejects.toThrow(/main-owned verified completion required/);
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

  it('F-185: done da aba registra o pedido antes da revisão, mesmo sem nota', async () => {
    let stored = {
      id: 'mission-existing', status: 'running', squadId: 'standard-team',
      orchestratorSessionId: 'orchestrator-session',
      description: '<!-- nexus:awaiting-adjustment:100 -->',
      learnings: '', intentVersion: 1, intentState: 'executing', updatedAt: 10,
      intentContract: { lane: 'standard', workspaceBinding: { version: 1, adoptedPaneId: 'operator-pane', tabKey: '__loose__' } },
    };
    const updateContent = vi.fn((_id, patch) => (stored = { ...stored, ...patch }));
    mocks.getProjectDomainStores.mockReturnValue({ missions: { get: () => stored, updateContent, appendLearning: vi.fn() } });
    mocks.reconcile.mockImplementation(async () => {
      expect(awaitsOperatorTabCompletionRequest(scope, stored as never)).toBe(false);
      expect(stored.description).not.toContain('awaiting-adjustment');
      return { action: 'wait', completed: false, reason: 'repair-dispatched' };
    });
    const result = await missionSetStatusTool().handler({ missionId: stored.id, status: 'done' }, context('orchestrator'));
    expect(result).toMatchObject({ status: 'running', completionRequested: true });
    expect(updateContent).toHaveBeenCalledOnce();
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.completeVerified).not.toHaveBeenCalled();
  });

  it('F-185: sessão antiga não registra pedido de conclusão na aba', async () => {
    const updateContent = vi.fn();
    mocks.getProjectDomainStores.mockReturnValue({ missions: {
      get: () => ({
        id: 'mission-existing', status: 'running', squadId: 'standard-team',
        orchestratorSessionId: 'new-orchestrator-session',
        intentContract: { lane: 'standard', workspaceBinding: { adoptedPaneId: 'operator-pane' } },
      }),
      updateContent,
    } });
    await expect(missionSetStatusTool().handler({ missionId: 'mission-existing', status: 'done' }, context('orchestrator'))).rejects.toThrow('orchestrator_session_stale');
    expect(updateContent).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('F-185: aba sem squad continua concluindo pelo pedido explícito com nota durável', async () => {
    let stored: Record<string, unknown> = {
      id: 'mission-existing', status: 'running', learnings: '', milestones: [],
      intentVersion: 1, intentState: 'executing', updatedAt: 10,
      intentContract: { lane: 'standard', workspaceBinding: { adoptedPaneId: 'operator-pane' } },
    };
    mocks.getProjectDomainStores.mockReturnValue({ missions: { get: () => stored } });
    mocks.getContextWorkflowService.mockReturnValue({
      isMissionDriverComplete: () => false,
      getMissionWorkflow: () => ({ contract: null }),
    });
    mocks.completeVerified.mockImplementation((_scope, input) => {
      stored = { ...stored, status: 'done', result: input.result };
    });
    const result = await missionSetStatusTool().handler({
      missionId: 'mission-existing', status: 'done',
      note: 'Pedido inteiro entregue, testes validados e release publicada com recibo.',
    }, context('orchestrator'));
    expect(result).toMatchObject({ status: 'done' });
    expect(mocks.completeVerified).toHaveBeenCalledOnce();
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
