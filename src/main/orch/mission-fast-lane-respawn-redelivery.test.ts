vi.mock('./mission-orchestrator-runtime', () => ({ resolveProductionMissionOrchestratorRuntime: () => ({ adapterId: 'codex', readOnly: false, nativeReadOnly: false }) }));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneSessionState } from '../../shared/surface-payload-types';
import type { Mission, SquadAgent } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';

/**
 * Onda 1 da campanha 0.50 (achado A3): o orquestrador respawnado no
 * boot/revival precisa RECEBER os handoffs pendentes que a sessão anterior
 * nunca consumiu. Hoje `redeliverPendingHandoffs` só dispara em
 * missionRebind e promoteOrchestrator — a ressurreição de boot conta só com
 * a sugestão do prompt ("consulte nexus_handoff_list"), e prompt não é
 * mecanismo. O handoff final aceito-não-ackado morre na fila e a missão
 * termina "blocked" tendo entregue.
 */

const harness = vi.hoisted(() => ({
  sessionStates: new Map<string, PaneSessionState | null>(),
  snapshots: [] as Array<{
    missionId: string;
    paneId: string;
    sessionId: string;
    role: 'orchestrator' | 'worker';
    agentName: string;
    adapterId?: string;
  }>,
  spawnCount: 0,
  spawnOptions: [] as Array<{ initialPrompt?: string; cwd: string; scope: ReturnType<typeof testProjectScope>; executionScope: ReturnType<typeof testProjectScope> }>,
  redeliver: vi.fn((): number => 0),
  handoffsOfSession: undefined as string | undefined,
  deliver: vi.fn(async (_sessionId: string, _prompt: string) => true),
}));

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: vi.fn(() => null),
  getSessionState: (sessionId: string) =>
    harness.sessionStates.get(sessionId) ?? null,
  getSessionCwd: () => null,
  isPtySessionConnectedAndWritable: (sessionId: string) =>
    harness.sessionStates.get(sessionId) === 'idle' ||
    harness.sessionStates.get(sessionId) === 'busy',
  registeredOrchestratorSessionsForMission: () => [],
  listAgentSessions: () => [],
  orchTerminateSession: () => Promise.resolve(true),
}));

// Fail-closed do bootstrap (0.60): o Maestro precisa de adapter cli-pty com
// rota Nexus MCP; o registry real não carrega builtins no vitest.
vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: (id: string) => ({
    id,
    label: id,
    kind: 'cli-pty',
    bin: 'claude',
    quirks: { nexusMcp: 'flag' },
    spawn: {},
  }),
}));

// Composição de contexto REAL (withProjectContextBlocks): só o transporte é dublê.
// A fábrica é re-registrada em cada beforeEach (vi.doMock): vi.resetModules()
// não refaz um mock já avaliado, e a cadeia original presa na 1ª época lia o
// store de atestação de outra instância — o P2-8 passava sozinho e falhava no
// arquivo inteiro.
const toolUtilMock = vi.hoisted(
  () => async (importOriginal: () => Promise<typeof import('./tool-util')>) => ({
    ...(await importOriginal()),
    deliverAgentPrompt: harness.deliver,
  }),
);
vi.mock('./tool-util', toolUtilMock);

vi.mock('./pane-registry', () => ({
  readSessionOutput: () => '',
  wasOrchestratorOperatorDismissed: () => false,
  clearOperatorDismissedPanes: () => {},
  listPaneSnapshots: () =>
    harness.snapshots.map((pane) => ({
      ...pane,
      state: harness.sessionStates.get(pane.sessionId) ?? 'idle',
    })),
  requestPaneSpawn: async (options: typeof harness.spawnOptions[number]) => {
    harness.spawnOptions.push(options);
    harness.spawnCount += 1;
    const sessionId = `session-${harness.spawnCount}`;
    const paneId = `pane-${harness.spawnCount}`;
    harness.sessionStates.set(sessionId, 'idle');
    harness.snapshots.push({
      missionId: 'mission-1',
      paneId,
      sessionId,
      role: 'orchestrator',
      agentName: 'Coordenar e revisar',
    });
    return { requestId: 'r', ok: true, paneId, sessionId };
  },
}));

const mission: Mission = {
  id: 'mission-1',
  title: 'Prova',
  description: 'Missão running cujo orquestrador morreu com handoff aceito.',
  status: 'running',
  intentState: 'executing',
  intentVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  squadId: 'squad-1',
  milestones: [],
} as unknown as Mission;

let liveMission: Mission = mission;

vi.mock('./project-domain-store-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('./project-domain-store-registry')>(),
  getProjectDomainStores: () => ({
    missions: {
      get: () => liveMission,
      list: (status?: string) =>
        !status || liveMission.status === status ? [liveMission] : [],
      update: (_id: string, patch: Partial<Mission>) => {
        liveMission = { ...liveMission, ...patch } as Mission;
        return liveMission;
      },
      transitionLifecycle: (
        _id: string,
        _expected: unknown,
        next: { status: string; intentState: string },
      ) => {
        liveMission = { ...liveMission, ...next } as Mission;
        return liveMission;
      },
      setOrchestratorSession: () => {},
      recordKickoffAcceptance: () => {},
      hasCurrentKickoffAcceptance: () => false,
    },
    missionPanes: { record: () => {}, list: () => [] },
    tasks: {
      hasPlan: () => false,
      list: () => [],
      listPlannedTasks: () => [],
    },
    taskDispatches: { list: () => [] },
    handoffs: {
      list: () =>
        harness.handoffsOfSession
          ? [
              {
                id: 'handoff-do-worker',
                missionId: 'mission-1',
                sessionId: harness.handoffsOfSession,
                status: 'success',
                summary: 'Worker entregou',
                delivered: false,
                deliveryState: 'submitted',
              },
            ]
          : [
              {
                id: 'handoff-final',
                missionId: 'mission-1',
                status: 'success',
                summary: 'Consolidei e revalidei os sete code reviews',
                delivered: false,
                deliveryState: 'submitted',
              },
            ],
    },
  }),
}));

const squadAgents: SquadAgent[] = [
  {
    id: 'coord',
    agentName: 'Coordenar e revisar',
    category: 'orchestrator',
    cli: 'codex',
  } as SquadAgent,
  {
    id: 'exec-1',
    agentName: 'Implementar motor',
    category: 'executor',
    cli: 'agy',
  } as SquadAgent,
];

let reviewedSquad: import('../../shared/orch-types').Squad | undefined;
vi.mock('./squad-store', () => ({
  getSquad: () => reviewedSquad ?? ({ id: 'squad-1', agents: squadAgents }),
}));

vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({
    completeVerified: vi.fn(),
    blockTechnical: (_scope: unknown, input: { description: string }) => {
      liveMission = { ...liveMission, status: 'blocked', intentState: 'blocked_technical', description: input.description };
    },
    resumeTechnical: (_scope: unknown, input: { description: string }) => {
      liveMission = { ...liveMission, status: 'running', intentState: 'executing', description: input.description };
    },
  }),
}));

vi.mock('./idle-delivery', () => ({
  redeliverPendingHandoffs: (...args: unknown[]) =>
    harness.redeliver(...(args as [])) as number,
}));

const emitMissionEvent = vi.hoisted(() => vi.fn());
vi.mock('./mission-event-emit', () => ({ emitMissionEvent }));

// readCheckoutHead executa git de verdade; sob fake timers o await do child
// process pendura o tick do watcher. HEAD estável e determinístico aqui.
vi.mock('node:child_process', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('node:child_process')>();
  const execFile = ((cmd: string, args: unknown, ...rest: unknown[]) => {
    // Só o HEAD do watcher é dublê; o resto do git (extrator do modelo de
    // negócio no teste P2-8) roda de verdade.
    if (!Array.isArray(args) || args[0] !== 'rev-parse' || args[1] !== 'HEAD') {
      return (actual.execFile as (...all: unknown[]) => unknown)(cmd, args, ...rest);
    }
    (rest[0] as (err: unknown, out: { stdout: string }) => void)(null, {
      stdout: 'sha-teste\n',
    });
    return undefined;
  }) as unknown as typeof actual.execFile;
  return { ...actual, execFile };
});

type FastLaneModule = typeof import('./mission-fast-lane');

let fastLane: FastLaneModule;

const scope = testProjectScope();

beforeEach(async () => {
  vi.useFakeTimers();
  harness.sessionStates.clear();
  harness.snapshots.length = 0;
  harness.spawnCount = 0;
  harness.spawnOptions.length = 0;
  harness.redeliver.mockClear();
  harness.deliver.mockClear();
  harness.handoffsOfSession = undefined;
  liveMission = mission;
  reviewedSquad = undefined;
  vi.resetModules();
  vi.doMock('./tool-util', toolUtilMock);
  fastLane = await import('./mission-fast-lane');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('respawn do orquestrador re-entrega handoffs pendentes (A3)', () => {
  it('keeps a new mission in its durable tab on bootstrap and Retomar; deleted tab never falls back to main', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-resume-tab-')));
    const repository = path.join(root, 'repo'); fs.mkdirSync(repository);
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.name', 'Nexus Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(repository, 'file.txt'), 'main'); git('add', 'file.txt'); git('commit', '-qm', 'baseline');
    const { ProjectRuntimeManager } = await import('../runtime/project-runtime-manager');
    const registry = await import('../runtime/worktree-runtime-registry');
    const manager = new ProjectRuntimeManager({ baseDir: path.join(root, 'runtime'), appVersion: 'test' });
    registry.configureWorktreeRuntimeRegistry(manager);
    const coordination = testProjectScope({ rootRealPath: repository });
    try {
      const { MainMissionEngine } = await import('./mission-engine');
      const { createMissionEnginePreparationPorts } = await import('./mission-engine-preparation');
      const { prepareMissionExecutionScope, missionExecutionScope } = await import('./mission-execution-scope');
      const roster = [...squadAgents, { id: 'review', agentName: 'Review', category: 'reviewer' as const, cli: 'codex' }]
        .map(agent => ({ ...agent, allowedTools: null, allowedSkills: null }));
      reviewedSquad = { id: 'squad-1', name: 'Fixture', createdAt: '1', builtin: false, agents: roster, orchestratorInstructions: '' };
      const preparation = createMissionEnginePreparationPorts({
        scope: coordination,
        missions: {
          create: input => { liveMission = { ...mission, ...input, status: 'pending', learnings: '' }; return liveMission; },
          get: () => liveMission,
          bindMissionRuntimeSquad: (_id, _expected, squadId, intentContract) => { liveMission = { ...liveMission, squadId, intentContract }; return liveMission; },
          removeIfUnchanged: () => 'removed',
        },
        deps: {
          routeIntent: async () => null, persistRuntimeSquad: () => reviewedSquad!, getSquad: () => reviewedSquad!,
          resolveRuntime: () => ({ adapterId: 'codex', readOnly: false, nativeReadOnly: false }), discardRuntimeSquad: () => true,
        },
      });
      const engine = new MainMissionEngine(coordination, {
        ...preparation,
        readReviewFence: async missionId => ({ missionId, reviewSha256: liveMission.intentContract!.approvalReviewSha256! }),
        seal: async () => {
          await prepareMissionExecutionScope(coordination, liveMission);
          liveMission = { ...liveMission, status: 'running', intentState: 'dispatched', intentContract: { ...liveMission.intentContract!, dispatchedAt: Date.now() } };
        },
        bootstrap: async missionId => { await fastLane.fastLaneBootstrap(coordination, missionId); },
        retryKickoff: async () => {}, resume: async () => {}, stop: async () => {}, direct: async () => {}, answerQuestion: async () => {},
        blockUser: () => {}, blockTechnical: () => {}, resumeTechnical: () => {}, completeVerified: () => {},
        listSnapshotViews: async () => [],
        readSnapshotView: async missionId => ({ mission: { id: missionId, title: liveMission.title, objective: liveMission.description ?? '', workspaceLabel: repository, status: liveMission.status, version: 1, updatedAt: liveMission.updatedAt },
          hasDispatchAuthority: true, hasCurrentKickoffReceipt: true, orchestratorLive: true, tasks: [], handoffs: [], panes: [], roster }),
      });
      const review = await engine.prepare(coordination, { title: 'Nova entrega', objective: 'Implemente source.ts e valide a entrega', contextPaths: [], roster, advanced: { lane: 'standard', freeAgentChoice: true } });
      expect(review.workspaceBinding?.spaceId).toMatch(/^space-/);
      expect(review.workspaceBinding).toEqual(liveMission.intentContract!.workspaceBinding);
      await engine.start(coordination, { missionId: review.missionId, reviewSha256: review.reviewSha256 });
      const tab = { cwd: missionExecutionScope(coordination, liveMission).rootRealPath };
      expect(harness.spawnOptions.length).toBeGreaterThan(0);
      for (const options of harness.spawnOptions) {
        expect(options.cwd).toBe(tab.cwd);
        expect(options.executionScope.rootRealPath).toBe(tab.cwd);
        expect(options.scope.rootRealPath).toBe(repository);
      }
      for (const sessionId of harness.sessionStates.keys()) harness.sessionStates.set(sessionId, 'exited');
      const prior = harness.spawnOptions.length;
      await fastLane.resumeFastLaneMission(coordination, mission.id, { remountKind: 'operator' });
      expect(harness.spawnOptions.length).toBeGreaterThan(prior);
      expect(harness.spawnOptions.at(-1)?.cwd).toBe(tab.cwd);
      for (const sessionId of harness.sessionStates.keys()) harness.sessionStates.set(sessionId, 'exited');
      fs.rmSync(tab.cwd, { recursive: true });
      const beforeFailure = harness.spawnOptions.length;
      await expect(fastLane.resumeFastLaneMission(coordination, mission.id, { remountKind: 'operator' })).rejects.toThrow();
      expect(harness.spawnOptions).toHaveLength(beforeFailure);
    } finally {
      registry.disposeWorktreeRuntimeRegistry(); manager.closeAll(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('encerra retries esgotados em bloqueio técnico visível, preservando objetivo e handoffs', async () => {
    await fastLane.fastLaneBootstrap(scope, 'mission-1');
    for (let attempt = 0; attempt < 11; attempt += 1) {
      for (const sessionId of harness.sessionStates.keys()) harness.sessionStates.set(sessionId, 'exited');
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(liveMission.status).toBe('blocked');
    expect(liveMission.intentState).toBe('blocked_technical');
    expect(liveMission.description).toContain(mission.description);
    expect(liveMission.description).toContain('recuperação automática');
    const finalSpawnCount = harness.spawnCount;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.spawnCount).toBe(finalSpawnCount);
    expect(liveMission.status).not.toBe('done');
    await fastLane.resumeFastLaneMission(scope, 'mission-1', { remountKind: 'operator' });
    const resumedSpawns = harness.spawnCount;
    for (const sessionId of harness.sessionStates.keys()) harness.sessionStates.set(sessionId, 'exited');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.spawnCount).toBeGreaterThan(resumedSpawns);
    expect(liveMission.status).toBe('running');
  });

  it('P2-8: o Maestro da Via Rápida recebe o <business-model> atestado no briefing entregue', async () => {
    vi.useRealTimers();
    const { applyAttestedBusinessModel, createBarbershopRepo } =
      await import('../context/business-model/__fixtures__/barbershop');
    const root = createBarbershopRepo();
    try {
      const withModel = testProjectScope({ rootRealPath: root });
      await applyAttestedBusinessModel(root, withModel);
      vi.useFakeTimers();
      await fastLane.fastLaneBootstrap(withModel, 'mission-1');
      const delivered = [
        harness.spawnOptions[0]?.initialPrompt ?? '',
        ...harness.deliver.mock.calls.map(([, prompt]) => prompt),
      ];
      expect(delivered.length).toBeGreaterThan(1);
      for (const brief of delivered) {
        expect(brief).toContain('<business-model fonte=');
        expect(brief).toContain('close_commanda#1');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('missão running sem orquestrador vivo → respawn chama redeliverPendingHandoffs', async () => {
    await fastLane.fastLaneBootstrap(scope, 'mission-1');

    expect(harness.spawnCount).toBe(1);
    expect(harness.redeliver).toHaveBeenCalledTimes(1);
    expect(harness.redeliver).toHaveBeenCalledWith(scope, 'mission-1');
  });

  it('worker morto sem entrega conta mortalidade e jorna o evento (A1)', async () => {
    const mortality = await import('./worker-mortality');
    mortality.resetMissionWorkerMortality('mission-1');
    emitMissionEvent.mockClear();
    await fastLane.fastLaneBootstrap(scope, 'mission-1');
    // Orquestrador respawnado está idle (vivo); worker glm morreu sem
    // entregar NADA (handoffs list não tem a sessão dele).
    harness.snapshots.push({
      missionId: 'mission-1',
      paneId: 'pane-worker-morto',
      sessionId: 'session-worker-morto',
      role: 'worker',
      agentName: 'Implementar motor',
      adapterId: 'glm',
    });
    harness.sessionStates.set('session-worker-morto', 'exited');

    await vi.advanceTimersByTimeAsync(15_000);

    expect(mortality.workerMortalityCount('mission-1', 'glm')).toBe(1);
    expect(emitMissionEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        type: 'custom',
        payload: expect.objectContaining({
          kind: 'worker-died-without-delivery',
          adapterId: 'glm',
        }),
      }),
    );
    // Pane morto é contado UMA vez: ticks seguintes não inflacionam.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mortality.workerMortalityCount('mission-1', 'glm')).toBe(1);
  });

  it('worker que entregou antes de morrer é prova de vida, não mortalidade', async () => {
    const mortality = await import('./worker-mortality');
    mortality.resetMissionWorkerMortality('mission-1');
    emitMissionEvent.mockClear();
    await fastLane.fastLaneBootstrap(scope, 'mission-1');
    harness.snapshots.push({
      missionId: 'mission-1',
      paneId: 'pane-worker-entregou',
      sessionId: 'session-worker-entregou',
      role: 'worker',
      agentName: 'Implementar motor',
      adapterId: 'glm',
    });
    harness.sessionStates.set('session-worker-entregou', 'exited');
    // O handoff da lista do harness vem da sessão deste worker (a fixture
    // handoff-final precisa bater o sessionId).
    harness.handoffsOfSession = 'session-worker-entregou';

    await vi.advanceTimersByTimeAsync(15_000);

    expect(mortality.workerMortalityCount('mission-1', 'glm')).toBe(0);
    expect(emitMissionEvent).not.toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'worker-died-without-delivery',
        }),
      }),
    );
  });
});
