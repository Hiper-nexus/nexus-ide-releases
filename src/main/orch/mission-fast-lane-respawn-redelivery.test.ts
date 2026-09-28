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
  missionPaneSpecs: [] as Array<Record<string, unknown>>,
  movePane: vi.fn(),
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
      setOrchestratorSession: (_missionId: string, sessionId: string) => {
        liveMission = { ...liveMission, orchestratorSessionId: sessionId };
      },
      recordKickoffAcceptance: () => {},
      hasCurrentKickoffAcceptance: () => false,
    },
    missionPanes: {
      record: () => {},
      list: () => harness.missionPaneSpecs,
      findByPaneId: () => null,
      moveOrchestratorPane: harness.movePane,
    },
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
  harness.missionPaneSpecs = [];
  harness.movePane.mockReset().mockImplementation((_missionId, specId, paneId) => {
    const spec = harness.missionPaneSpecs.find((row) => row.id === specId);
    if (spec) spec.paneId = paneId;
  });
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

  it.each([false, true])('missão da aba retoma a conversa do pane do operador (falha no vínculo: %s)', async (moveFails) => {
    // Campo 28/09: depois do reinício, o Retomar da missão da aba subiu o
    // Maestro do squad com só o título como brief — Claude novo perguntando
    // "o que devo fazer?", sem a conversa do operador.
    liveMission = {
      ...mission,
      squadId: undefined,
      intentContract: { workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' } },
    } as unknown as Mission;
    harness.missionPaneSpecs = [
      {
        id: 'mp-1', missionId: 'mission-1', paneId: 'pane-operador', adapterId: 'claude',
        model: 'claude-opus-5-5', accountId: 'acct-operador', role: 'orchestrator',
        title: 'Orquestrador', agentName: 'Orquestrador',
      },
    ];

    if (moveFails) harness.movePane.mockImplementationOnce(() => { throw new Error('store temporarily unavailable'); });
    await fastLane.fastLaneBootstrap(scope, 'mission-1');

    expect(harness.spawnCount).toBe(1);
    const spawn = harness.spawnOptions[0] as Record<string, unknown>;
    expect(spawn).toMatchObject({
      adapterId: 'claude',
      model: 'claude-opus-5-5',
      resume: true,
      resumeFromPaneId: 'pane-operador',
      accountId: 'acct-operador',
    });
    expect(String(spawn.initialPrompt)).toContain('retomada');
    expect(String(spawn.initialPrompt)).toContain('nexus_pane_spawn({task, prompt})');
    expect(String(spawn.initialPrompt)).not.toContain('Coordenar e revisar');
    // F-664: a linha deduplicada passa a apontar para o pane que agora tem a conversa.
    expect(harness.movePane).toHaveBeenCalledWith('mission-1', 'mp-1', 'pane-1');
    expect(harness.redeliver).toHaveBeenCalledWith(scope, 'mission-1');
    if (moveFails) {
      // Retry before another resume must use the new conversation, even when
      // the first historical write failed after the runtime was opened.
      harness.sessionStates.set('session-1', 'exited');
      await fastLane.resumeFastLaneMission(scope, 'mission-1', { remountKind: 'operator' });
      expect((harness.spawnOptions[1] as Record<string, unknown>).resumeFromPaneId).toBe('pane-1');
      expect(harness.missionPaneSpecs[0]?.paneId).toBe('pane-2');
    }
  });

  it('marca antiga de "Pedir um ajuste" não deixa a conversa retomada parada (F-665)', async () => {
    // Campo 28/09 12:49: ajuste pedido às 10:24; às 12:48 o Retomar ainda
    // mandava "AGUARDE O OPERADOR" e o orquestrador parava sem dizer onde estava.
    const tab = {
      ...mission,
      squadId: undefined,
      intentContract: { workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' } },
    };
    harness.missionPaneSpecs = [
      { id: 'mp-1', missionId: 'mission-1', paneId: 'pane-operador', adapterId: 'claude', role: 'orchestrator', title: 'Orquestrador' },
    ];
    liveMission = {
      ...tab,
      description: `contexto

<!-- nexus:awaiting-adjustment:${Date.now() - 3 * 60 * 60_000} -->`,
    } as unknown as Mission;
    await fastLane.fastLaneBootstrap(scope, 'mission-1');
    const stale = String((harness.spawnOptions[0] as Record<string, unknown>).initialPrompt);
    expect(stale).not.toContain('AGUARDE O OPERADOR');
    expect(stale).toContain('o que estava sendo feito');
  });

  it('ajuste recém-pedido ainda manda a conversa retomada esperar o operador (F-665)', async () => {
    harness.missionPaneSpecs = [
      { id: 'mp-1', missionId: 'mission-1', paneId: 'pane-operador', adapterId: 'claude', role: 'orchestrator', title: 'Orquestrador' },
    ];
    liveMission = {
      ...mission,
      squadId: undefined,
      intentContract: { workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' } },
      description: `contexto

<!-- nexus:awaiting-adjustment:${Date.now() - 10_000} -->`,
    } as unknown as Mission;
    await fastLane.fastLaneBootstrap(scope, 'mission-1');
    expect(String((harness.spawnOptions[0] as Record<string, unknown>).initialPrompt)).toContain('AGUARDE O OPERADOR');
  });

  it('retoma a conversa mais recente com o modelo do pane do operador (F-664)', async () => {
    // Campo 28/09 11:05: a linha mais recente era o "Maestro" que a 0.76.111
    // subiu sem modelo — cada Retomar voltava a ele e nascia no Sonnet padrão.
    liveMission = {
      ...mission,
      squadId: undefined,
      intentContract: { workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' } },
    } as unknown as Mission;
    harness.missionPaneSpecs = [
      {
        id: 'mp-1', missionId: 'mission-1', paneId: 'pane-operador', adapterId: 'claude',
        model: 'claude-opus-5-5', accountId: 'acct-operador', role: 'orchestrator', title: 'Orquestrador',
      },
      {
        id: 'mp-2', missionId: 'mission-1', paneId: 'pane-maestro', adapterId: 'claude',
        effort: 'high', accountId: 'acct-operador', role: 'orchestrator', title: 'Maestro', agentName: 'Maestro',
      },
    ];

    await fastLane.fastLaneBootstrap(scope, 'mission-1');

    expect(harness.spawnOptions[0]).toMatchObject({
      adapterId: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
      resumeFromPaneId: 'pane-maestro',
    });
    expect(harness.movePane).toHaveBeenCalledWith('mission-1', 'mp-2', 'pane-1');
  });

  it('missão com squad continua subindo o Maestro do squad (sem retomar pane)', async () => {
    harness.missionPaneSpecs = [
      { id: 'mp-1', missionId: 'mission-1', paneId: 'pane-antigo', adapterId: 'claude', role: 'orchestrator', title: 'Maestro' },
    ];
    await fastLane.fastLaneBootstrap(scope, 'mission-1');
    const spawn = harness.spawnOptions[0] as Record<string, unknown>;
    expect(spawn).toMatchObject({ adapterId: 'codex', resume: false });
    expect(spawn.resumeFromPaneId).toBeUndefined();
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
