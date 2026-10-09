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
  operatorDismissed: false,
  spawnOptions: [] as Array<{ initialPrompt?: string; cwd: string; scope: ReturnType<typeof testProjectScope>; executionScope: ReturnType<typeof testProjectScope> }>,
  redeliver: vi.fn((): number => 0),
  handoffsOfSession: undefined as string | undefined,
  deliver: vi.fn(async (_sessionId: string, _prompt: string) => true),
  missionPaneSpecs: [] as Array<Record<string, unknown>>,
  recordedPaneSpecs: [] as Array<Record<string, unknown>>,
  realPaneStore: null as ReturnType<typeof import('./mission-pane-store').createScopedMissionPaneStore> | null,
  acpSessions: new Map<string, { agent: import('../pty/pty-manager').OwnedAgentSessionInfo; shutdown: () => Promise<void> }>(),
  acpShutdown: vi.fn(async () => {}),
  runtimeScopeMismatch: false,
  afterSpawn: undefined as undefined | ((session: import('../pty/pty-manager').OwnedAgentSessionInfo) => void),
  currentSeal: undefined as import('../../shared/orch-types').MissionPaneAuthoritySeal | undefined,
  physicalSessions: new Map<string, import('../pty/pty-manager').OwnedAgentSessionInfo>(),
  movePane: vi.fn(),
  registeredOrchestrators: [] as Array<{
    missionId: string;
    sessionId: string;
    state: PaneSessionState;
    adapterId: string;
  }>,
  terminate: vi.fn(async (_sessionId: string, _options?: unknown) => true),
  trace: vi.fn(),
  /** F-721: roda dentro do spawn, antes do pane novo existir. */
  onSpawn: undefined as undefined | (() => void),
  plannedTasks: [] as Array<{ id: string; title: string; plannerId: string; status: 'pending' }>,
}));

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (sessionId: string) => harness.acpSessions.has(sessionId) ? null : harness.physicalSessions.get(sessionId) ?? null,
  getSessionState: (sessionId: string) =>
    harness.sessionStates.get(sessionId) ?? null,
  getSessionCwd: () => null,
  isPtySessionConnectedAndWritable: (sessionId: string) =>
    harness.sessionStates.get(sessionId) === 'idle' ||
    harness.sessionStates.get(sessionId) === 'busy',
  registeredOrchestratorSessionsForMission: (missionId: string) =>
    harness.registeredOrchestrators.filter(
      (entry) => entry.missionId === missionId,
    ),
  listAgentSessions: () => [],
  orchTerminateSession: (sessionId: string, options?: unknown) =>
    harness.terminate(sessionId, options),
}));

vi.mock('../acp/acp-harness-driver', async importOriginal => ({
  ...await importOriginal<typeof import('../acp/acp-harness-driver')>(),
  getAcpDriverSession: (sessionId: string) => harness.acpSessions.get(sessionId) ?? null,
  listAcpDriverAgentSessions: () => [...harness.acpSessions.values()].map(session => session.agent),
}));

vi.mock('../observability/main-trace', () => ({ trace: harness.trace }));

// Fail-closed do bootstrap (0.60): o Maestro precisa de adapter cli-pty com
// rota Nexus MCP; o registry real não carrega builtins no vitest.
vi.mock('../adapters/adapter-registry', async importOriginal => ({
  ...await importOriginal<typeof import('../adapters/adapter-registry')>(),
  getAdapter: (id: string) => ({
    id,
    label: id,
    kind: 'cli-pty',
    bin: 'claude',
    auth: { method: 'api-key' },
    quirks: { nexusMcp: 'flag' },
    spawn: {},
  }),
}));

// This fixture owns respawn/retry/mortality, not installed CLI credentials.
// First-wave warming must never probe the operator's Keychain/Kimi process.
vi.mock('./squad-runtime-inventory', () => ({ warmSquadRuntimeSubscriptionAuth: async () => undefined }));
vi.mock('../pty/pre-spawn-probe', async importOriginal => ({
  ...await importOriginal<typeof import('../pty/pre-spawn-probe')>(),
  assertPreSpawnProbe: async () => undefined,
}));
vi.mock('../adapters/subscription-auth', async importOriginal => ({
  ...await importOriginal<typeof import('../adapters/subscription-auth')>(),
  detectSubscriptionAuthReadiness: () => 'missing',
}));
vi.mock('../persistence/provider-config-store', async importOriginal => ({
  ...await importOriginal<typeof import('../persistence/provider-config-store')>(),
  listProviderSettings: () => [],
  providerAuthStrategy: () => 'api-key',
  hasRuntimeKey: () => false,
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
  resolveCurrentMissionSpawnAuthoritySeal: () => harness.currentSeal,
  getPaneRuntimeAuthorityBySession: (sessionId: string) => {
    const physical = harness.physicalSessions.get(sessionId);
    const coordinationScope = harness.spawnOptions[Number(sessionId.split('-').at(-1)) - 1]?.scope ?? scope;
    return physical ? { sessionId, paneId: physical.paneId, kind: 'cli-agent', missionId: physical.missionId,
      role: physical.role, scope: harness.runtimeScopeMismatch ? { ...scope, checkoutId: 'foreign-coordination' } : coordinationScope, owner: null } : null;
  },
  isMissionPaneOperatorDismissed: () => false,
  readSessionOutput: () => '',
  wasOrchestratorOperatorDismissed: () => harness.operatorDismissed,
  clearOperatorDismissedPanes: () => {},
  listPaneSnapshots: () =>
    harness.snapshots.map((pane) => ({
      ...pane,
      state: harness.sessionStates.get(pane.sessionId) ?? 'idle',
    })),
  requestPaneSpawn: async (options: typeof harness.spawnOptions[number]) => {
    harness.onSpawn?.();
    harness.spawnOptions.push(options);
    harness.spawnCount += 1;
    const sessionId = `session-${harness.spawnCount}`;
    const paneId = `pane-${harness.spawnCount}`;
    const request = options as typeof options & { adapterId: string; model?: string; effort?: string; accountId?: string; agentName?: string; missionId?: string; allowedTools?: string[] | null; allowedSkills?: string[] | null };
    const { createMissionPaneAuthoritySeal, hashMissionIntentAuthority } = await import('./mission-pane-authority');
    const seal = createMissionPaneAuthoritySeal({ mission: liveMission, squad: reviewedSquad ?? null });
    harness.currentSeal = seal ?? (liveMission.intentContract ? {
      intentVersion: liveMission.intentVersion!, intentContractHash: hashMissionIntentAuthority(liveMission.intentContract),
      contextRevision: 'fixture', contractHash: 'b'.repeat(64), squadRevisionHash: 'c'.repeat(64),
    } : undefined);
    harness.physicalSessions.set(sessionId, {
      sessionId, paneId, adapterId: request.adapterId, model: request.model, requestedModel: request.model,
      effort: request.effort, accountId: request.accountId, cwd: options.cwd,
      scope: options.executionScope ?? options.scope, source: 'pending', role: 'orchestrator',
      missionId: request.missionId, agentName: request.agentName, readOnly: false, nativeReadOnly: false,
      allowedTools: request.allowedTools ?? null, allowedSkills: request.allowedSkills ?? null, authoritySeal: harness.currentSeal,
    });
    harness.afterSpawn?.(harness.physicalSessions.get(sessionId)!);
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
    missionPanes: harness.realPaneStore ?? {
      record: (spec: Record<string, unknown>) => { harness.recordedPaneSpecs.push(spec); },
      list: () => harness.missionPaneSpecs,
      findByPaneId: () => null,
      moveOrchestratorPane: harness.movePane,
    },
    tasks: {
      hasPlan: () => harness.plannedTasks.length > 0,
      list: () => [...harness.plannedTasks],
      listPlannedTasks: () => harness.plannedTasks.map(task => ({ taskId: task.id, task })),
      createPlanAtomically: (input: { rows: readonly { plannerId: string; title: string }[] }) => {
        const rows = input.rows.map(row => ({ ...row, id: `fixture-task-${row.plannerId}`, status: 'pending' as const }));
        harness.plannedTasks.splice(0, harness.plannedTasks.length, ...rows);
        return [...rows];
      },
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

vi.mock('./mission-engine-registry', async importOriginal => ({
  ...await importOriginal<typeof import('./mission-engine-registry')>(),
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

// The fake /workspace has no disk delivery. C.5 now transports Git through
// AsyncProcessGitRunner (with safe argv prefixes), not the old execFile args.
// Real temporary repos in the tab/business-model tests still use real Git.
vi.mock('../runtime/git-command', async importOriginal => {
  const actual = await importOriginal<typeof import('../runtime/git-command')>();
  return { ...actual, AsyncProcessGitRunner: class extends actual.AsyncProcessGitRunner {
    override run(cwd: string, args: readonly string[], options?: import('../runtime/git-command').GitRunOptions) {
      if (cwd === '/workspace') return Promise.resolve({ status: 0, stderr: '',
        stdout: args[0] === 'rev-parse' ? (args[1] === '--is-inside-work-tree' ? 'true\n' : `${'a'.repeat(40)}\n`) : '',
      });
      return super.run(cwd, args, options);
    }
  } };
});
vi.mock('./worker-file-walk', async importOriginal => {
  const actual = await importOriginal<typeof import('./worker-file-walk')>();
  return { ...actual, listChangedMtimeFiles: (...args: Parameters<typeof actual.listChangedMtimeFiles>) =>
    args[0] === '/workspace' ? Promise.resolve([]) : actual.listChangedMtimeFiles(...args) };
});

type FastLaneModule = typeof import('./mission-fast-lane');

let fastLane: FastLaneModule;

const scope = testProjectScope();

beforeEach(async () => {
  vi.useFakeTimers();
  harness.sessionStates.clear();
  harness.snapshots.length = 0;
  harness.spawnCount = 0;
  harness.operatorDismissed = false;
  harness.spawnOptions.length = 0;
  harness.redeliver.mockClear();
  harness.deliver.mockClear();
  harness.handoffsOfSession = undefined;
  harness.missionPaneSpecs = [];
  harness.recordedPaneSpecs = [];
  harness.realPaneStore = null;
  harness.physicalSessions.clear();
  harness.currentSeal = undefined;
  harness.afterSpawn = undefined;
  harness.runtimeScopeMismatch = false;
  harness.acpSessions.clear();
  harness.acpShutdown.mockReset().mockImplementation(async () => { harness.acpSessions.clear(); });
  harness.registeredOrchestrators.length = 0;
  harness.terminate.mockClear();
  harness.trace.mockClear();
  harness.onSpawn = undefined;
  harness.plannedTasks.length = 0;
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
  it.each([
    { oldModel: undefined, fault: undefined }, { oldModel: 'approved-model', fault: undefined },
    ...['missing-seal', 'wrong-seal', 'wrong-session', 'wrong-scope', 'wrong-coordination', 'native-readonly', 'live-old', 'stale-spec', 'acp-stale-spec', 'stale-intent', 'explicit-model', 'explicit-effort'].map(fault => ({ oldModel: 'approved-model', fault })),
  ])('CAS binds the complete new Maestro runtime (oldModel=$oldModel, fault=$fault, F-428)', async ({ oldModel, fault }) => {
    const { ProjectRuntimeManager } = await import('../runtime/project-runtime-manager');
    const { createScopedMissionStore } = await import('./mission-store');
    const { createScopedMissionPaneStore } = await import('./mission-pane-store');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orchestrator-rebind-')));
    const manager = new ProjectRuntimeManager({ baseDir: root, appVersion: 'test' });
    try {
      createScopedMissionStore(manager, scope, { idFactory: () => mission.id }).create({ title: mission.title });
      const panes = createScopedMissionPaneStore(manager, scope);
      harness.realPaneStore = panes;
      const previous = panes.record({ missionId: mission.id, paneId: 'old-pane', adapterId: 'codex',
        model: fault === 'explicit-model' ? 'other-model' : oldModel, effort: fault === 'explicit-effort' ? 'high' : undefined, cwd: scope.rootRealPath, role: 'orchestrator', title: 'Coordenar e revisar',
        agentName: 'Coordenar e revisar', allowedTools: null, allowedSkills: null });
      const { compileIntentContract } = await import('../../shared/mission-intent');
      const { snapshotSquadAuthority } = await import('./squad-authority-snapshot');
      reviewedSquad = { id: 'squad-1', name: 'Fixture', createdAt: '1', builtin: false, orchestratorInstructions: '', agents: squadAgents.map(agent => ({ ...agent, allowedTools: ['nexus_pane_spawn'], allowedSkills: [] })) };
      liveMission = { ...mission, orchestratorSessionId: 'old-session', intentContract: {
        ...compileIntentContract({ goal: 'Prove persisted runtime compatibility', acceptanceCriteria: ['Same authority after resume'], intentVersion: 1 }),
        approvedAt: 10, dispatchedAt: 11, squadRevisionHash: snapshotSquadAuthority(reviewedSquad).hash,
        orchestratorRuntime: { adapterId: 'codex', model: 'approved-model', effort: 'medium', readOnly: false, nativeReadOnly: false },
      } } as Mission;
      harness.afterSpawn = physical => {
        if (fault === 'missing-seal') physical.authoritySeal = undefined;
        if (fault === 'wrong-seal') physical.authoritySeal = { ...physical.authoritySeal!, contextRevision: 'tampered' };
        if (fault === 'wrong-session') physical.sessionId = 'foreign-session';
        if (fault === 'wrong-coordination') harness.runtimeScopeMismatch = true;
        if (fault === 'wrong-scope') physical.scope = { ...scope, checkoutId: 'foreign-checkout' };
        if (fault === 'native-readonly') physical.nativeReadOnly = true;
        if (fault === 'live-old') harness.registeredOrchestrators.push({ missionId: mission.id, sessionId: 'old-session', adapterId: 'codex', state: 'busy' });
        if (fault === 'acp-stale-spec') { harness.acpSessions.set(physical.sessionId, { agent: physical, shutdown: harness.acpShutdown }); }
        if (fault === 'stale-spec' || fault === 'acp-stale-spec') panes.moveOrchestratorPane(mission.id, previous.id, 'concurrent-pane');
        if (fault === 'stale-intent') liveMission = { ...liveMission, intentVersion: 2 };
      };
      if (fault) {
        if (fault === 'acp-stale-spec') {
          let release!: () => void;
          const physicalExit = new Promise<void>(resolve => { release = resolve; });
          harness.acpShutdown.mockImplementationOnce(async () => { await physicalExit; harness.acpSessions.clear(); });
          let settled = false;
          const attempt = fastLane.fastLaneBootstrap(scope, mission.id);
          void attempt.then(() => { settled = true; }, () => { settled = true; });
          try {
            await vi.waitFor(() => expect(harness.acpShutdown).toHaveBeenCalledOnce());
            expect(settled).toBe(false);
            expect(harness.acpSessions.size).toBe(1);
          } finally { release(); }
          await expect(attempt).rejects.toThrow(/changed/);
        } else await expect(fastLane.fastLaneBootstrap(scope, mission.id)).rejects.toThrow(/authority|runtime|changed/);
        expect(panes.list(mission.id)).toEqual([{ ...previous, ...(['stale-spec', 'acp-stale-spec'].includes(fault) ? { paneId: 'concurrent-pane' } : {}) }]);
        expect(harness.terminate).not.toHaveBeenCalledWith('old-session', expect.anything());
        if (fault === 'acp-stale-spec') { expect(harness.acpShutdown).toHaveBeenCalledOnce(); expect(harness.acpSessions.size).toBe(0); expect(harness.terminate).not.toHaveBeenCalled(); }
        else if (!fault.startsWith('explicit-')) expect(harness.terminate).toHaveBeenCalledWith('session-1', expect.objectContaining({ origin: 'fast-lane:spawn-binding-failed' }));
        else expect(harness.spawnCount).toBe(0);
        return;
      }
      await fastLane.fastLaneBootstrap(scope, mission.id);
      expect(harness.physicalSessions.get('session-1')).toMatchObject({ paneId: 'pane-1', requestedModel: 'approved-model', effort: 'medium' });
      expect(panes.list(mission.id)).toHaveLength(1);
      expect(panes.findByPaneId('old-pane')).toBeNull();
      expect(panes.findByPaneId('pane-1')).toMatchObject({ id: previous.id, model: 'approved-model', effort: 'medium' });
      const { runtimeAuthorityMismatches } = await import('./mission-engine-production');
      const { createMissionPaneAuthoritySeal } = await import('./mission-pane-authority');
      const physical = harness.physicalSessions.get('session-1')!;
      const persisted = panes.findByPaneId('pane-1')!;
      expect(physical.authoritySeal).toEqual(createMissionPaneAuthoritySeal({ mission: liveMission, squad: reviewedSquad }));
      expect(physical.authoritySeal).toBeDefined();
      const authority = { sessionId: physical.sessionId, paneId: physical.paneId!, kind: 'cli-agent' as const,
        missionId: mission.id, role: 'orchestrator' as const, scope, owner: null };
      const mismatch = (pane = persisted, agent = physical) => runtimeAuthorityMismatches(scope, liveMission, pane, agent, authority, liveMission.intentContract!.orchestratorRuntime!);
      expect(mismatch()).toEqual([]);
      expect(mismatch({ ...persisted, authoritySeal: undefined })).toContain('agent.authoritySeal×pane');
      expect(mismatch({ ...persisted, authoritySeal: undefined }, { ...physical, authoritySeal: undefined })).toContain('agent.authoritySeal×pane');
      expect(mismatch(persisted, { ...physical, nativeReadOnly: true })).toContain('agent.nativeReadOnly×runtime[true != false]');
      expect(mismatch({ ...persisted, allowedSkills: null })).toContain('agent.allowedSkills×pane');
      expect(mismatch({ ...persisted, allowedTools: null })).toContain('agent.allowedTools×pane');
      expect(mismatch(persisted, { ...physical, readOnly: true })).toContain('agent.readOnly×pane[true != false]');

      manager.close(scope);
      expect(createScopedMissionPaneStore(manager, scope).list(mission.id)).toMatchObject([{ id: previous.id, paneId: 'pane-1', model: 'approved-model', effort: 'medium' }]);
    } finally { harness.realPaneStore = null; manager.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['pending', 'running'] as const)('materializes approved defaults in a %s Maestro, persisted pane and later remount (F-428)', async status => {
    liveMission = { ...mission, status, intentState: status === 'pending' ? 'ready_to_start' : 'executing', intentContract: {
      orchestratorRuntime: { adapterId: 'codex', model: 'approved-model', effort: 'medium', readOnly: false, nativeReadOnly: false },
    } } as Mission;
    await fastLane.fastLaneBootstrap(scope, 'mission-1');
    expect(harness.spawnOptions[0]).toMatchObject({ model: 'approved-model', effort: 'medium' });
    expect(harness.recordedPaneSpecs[0]).toMatchObject({ model: 'approved-model', effort: 'medium' });
    expect(squadAgents[0].model).toBeUndefined();
    expect(squadAgents[0].effort).toBeUndefined();
    for (const session of harness.sessionStates.keys()) harness.sessionStates.set(session, 'exited');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.spawnOptions.length).toBeGreaterThan(1);
    expect(harness.spawnOptions.at(-1)).toMatchObject({ model: 'approved-model', effort: 'medium' });
    expect(harness.recordedPaneSpecs.at(-1)).toMatchObject({ model: 'approved-model', effort: 'medium' });
  });

  it('preserves explicit reviewed roster model and effort (F-428)', async () => {
    reviewedSquad = { id: 'squad-1', name: 'Fixture', createdAt: '1', builtin: false, orchestratorInstructions: '',
      agents: squadAgents.map(agent => agent.category === 'orchestrator' ? { ...agent, model: 'explicit-model', effort: 'high' } : agent),
    };
    liveMission = { ...mission, intentContract: {
      orchestratorRuntime: { adapterId: 'codex', model: 'explicit-model', effort: 'high', readOnly: false, nativeReadOnly: false },
    } } as Mission;
    await fastLane.fastLaneBootstrap(scope, 'mission-1');
    expect(harness.spawnOptions[0]).toMatchObject({ model: 'explicit-model', effort: 'high' });
    expect(harness.recordedPaneSpecs[0]).toMatchObject({ model: 'explicit-model', effort: 'high' });
  });

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
        // Bloco por tarefa: a seleção cita itens do modelo (id por fluxo), não
        // a lista inteira — o essencial é que conteúdo real do doc chegou.
        expect(brief).toContain('close_commanda');
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

  it('F-721: a retomada da aba é a única dona do pane antigo enquanto leva a conversa', async () => {
    // Campo 02/10 07:01: enquanto o Main levava a conversa para o pane novo, o
    // renderer religou o pane antigo com sessão nova; ele ficou com a conta
    // Claude e a retomada certa foi recusada. Durante a transferência o pane
    // antigo é do Main e uma segunda retomada da mesma missão não começa.
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
    const { isOperatorTabResumeTransferSource } = await import('./operator-tab-mission-resume');
    let ownedDuringSpawn = false;
    let concurrent: Promise<unknown> | undefined;
    harness.onSpawn = () => {
      harness.onSpawn = undefined;
      ownedDuringSpawn = isOperatorTabResumeTransferSource('mission-1', 'pane-operador');
      concurrent = fastLane
        .resumeFastLaneMission(scope, 'mission-1', { remountKind: 'operator' })
        .then(() => 'resolved', (error: unknown) => error);
    };

    await fastLane.fastLaneBootstrap(scope, 'mission-1');

    expect(ownedDuringSpawn).toBe(true);
    expect(String(await concurrent)).toMatch(/já está sendo retomada/);
    // Um Maestro só, e ele carrega a conversa do pane antigo. A nota da
    // retomada é colada depois do boot (resume não leva prompt no argv).
    expect(harness.spawnCount).toBe(1);
    expect(harness.spawnOptions[0]).toMatchObject({ resume: true, resumeFromPaneId: 'pane-operador' });
    expect(harness.deliver).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('Esta conversa foi retomada'),
      undefined,
      { adapterId: 'claude' },
    );
    // Com a conversa no pane novo, o antigo deixa de ser reservado.
    expect(isOperatorTabResumeTransferSource('mission-1', 'pane-operador')).toBe(false);
  });

  it('F-721: falha da retomada da aba devolve o pane antigo para o restore', async () => {
    liveMission = {
      ...mission,
      squadId: undefined,
      intentContract: { workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' } },
    } as unknown as Mission;
    harness.missionPaneSpecs = [
      {
        id: 'mp-1', missionId: 'mission-1', paneId: 'pane-operador', adapterId: 'claude',
        accountId: 'acct-operador', role: 'orchestrator', title: 'Orquestrador',
      },
    ];
    harness.onSpawn = () => {
      throw new Error('renderer recusou o pane novo');
    };
    const { isOperatorTabResumeTransferSource } = await import('./operator-tab-mission-resume');

    await expect(fastLane.fastLaneBootstrap(scope, 'mission-1')).rejects.toThrow(/renderer recusou/);
    expect(isOperatorTabResumeTransferSource('mission-1', 'pane-operador')).toBe(false);
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
    // F-918: só conta a CLI cujo exit este processo observou (morte espontânea).
    (await import('./pane-session-output')).recordPaneSessionExit('session-worker-morto');

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

  it('F-187: remount automático adota Maestro registrado e vivo — nunca termina nem respawna', async () => {
    // Campo 28/09: o Maestro e os helpers morreram juntos — compatível com
    // a remontagem automática ter respawnado por cima, mas a causa não foi
    // comprovada; F-212 passa a registrar quem termina cada sessão. O
    // caminho decide 'respawn' quando
    // liveOrchestratorSessionId devolve null — mas a projeção de pane pode
    // ficar para trás de uma sessão registrada e FISICAMENTE viva. Remount
    // automático (ressurreição de boot, retry-kickoff, supervisor) precisa
    // adotar essa sessão em vez de matá-la.
    liveMission = {
      ...mission,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Mission;
    harness.sessionStates.set('sess-maestro-vivo', 'busy');
    harness.registeredOrchestrators.push({
      missionId: 'mission-1',
      sessionId: 'sess-maestro-vivo',
      state: 'busy',
      adapterId: 'codex',
    });

    await fastLane.resumeFastLaneMission(scope, 'mission-1', {
      remountKind: 'automatic',
    });

    expect(harness.terminate).not.toHaveBeenCalled();
    expect(harness.spawnCount).toBe(0);
    expect(harness.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'orchestrator-live-adopted',
        missionId: 'mission-1',
        sessionId: 'sess-maestro-vivo',
      }),
    );
    expect(liveMission.status).toBe('running');
  });

  it('F-187: Retomar do operador mantém o respawn com terminate com prova', async () => {
    liveMission = {
      ...mission,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Mission;
    harness.sessionStates.set('sess-maestro-vivo', 'busy');
    harness.registeredOrchestrators.push({
      missionId: 'mission-1',
      sessionId: 'sess-maestro-vivo',
      state: 'busy',
      adapterId: 'codex',
    });

    await fastLane.resumeFastLaneMission(scope, 'mission-1', {
      remountKind: 'operator',
    });

    expect(harness.terminate).toHaveBeenCalledWith(
      'sess-maestro-vivo',
      expect.objectContaining({ termTimeoutMs: 5_000 }),
    );
    expect(harness.spawnCount).toBe(1);
  });

  it('F-187: pane promovido de missão da aba é reconhecido como Maestro vivo', async () => {
    // O pane do operador promovido a orquestrador carrega orchMeta com
    // missionId + role 'orchestrator': liveOrchestratorSessionId precisa
    // reconhecê-lo para o remount automático virar 'watch', não 'respawn'.
    liveMission = {
      ...mission,
      squadId: undefined,
      intentContract: {
        workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as unknown as Mission;
    harness.snapshots.push({
      missionId: 'mission-1',
      paneId: 'pane-operador',
      sessionId: 'sess-pane-operador',
      role: 'orchestrator',
      agentName: 'Orquestrador',
      adapterId: 'claude',
    });
    harness.sessionStates.set('sess-pane-operador', 'idle');

    expect(fastLane.liveOrchestratorSessionId('mission-1')).toBe(
      'sess-pane-operador',
    );

    await fastLane.resumeFastLaneMission(scope, 'mission-1', {
      remountKind: 'automatic',
    });

    expect(harness.terminate).not.toHaveBeenCalled();
    expect(harness.spawnCount).toBe(0);
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


it('F-1063: real automatic resume reports the operator-dismiss no-op without mounting', async () => {
  harness.operatorDismissed = true;
  liveMission = { ...mission, createdAt: Date.now(), updatedAt: Date.now() };
  await expect(fastLane.resumeFastLaneMission(scope, mission.id, { remountKind: 'automatic' }))
    .resolves.toMatchObject({ kind: 'operator-dismissed' });
  expect(harness.spawnCount).toBe(0);
  expect(harness.terminate).not.toHaveBeenCalled();
});

it('F-1063: real watch path reports the existing live leader rather than a rebind', async () => {
  liveMission = { ...mission, createdAt: Date.now(), updatedAt: Date.now() };
  harness.sessionStates.set('existing-leader', 'idle');
  harness.snapshots.push({ missionId: mission.id, paneId: 'existing-pane', sessionId: 'existing-leader', role: 'orchestrator', agentName: 'Maestro' });
  await expect(fastLane.resumeFastLaneMission(scope, mission.id, { remountKind: 'automatic' }))
    .resolves.toMatchObject({ kind: 'already-running', sessionId: 'existing-leader' });
  expect(harness.spawnCount).toBe(0);
  expect(harness.terminate).not.toHaveBeenCalled();
});

it.each(['signal', 'authority', 'operator-dismiss'] as const)(
  'F-1063: real asynchronous resume refuses a spawn after %s changes during termination', async (fault) => {
    liveMission = { ...mission, createdAt: Date.now(), updatedAt: Date.now() };
    harness.registeredOrchestrators.push({ missionId: mission.id, sessionId: 'stale-session', state: 'exited', adapterId: 'codex' });
    const controller = new AbortController();
    let revoked = false;
    let finishTermination!: (value: boolean) => void;
    harness.terminate.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishTermination = resolve; }));
    const resuming = fastLane.resumeFastLaneMission(scope, mission.id, { remountKind: 'automatic', invocation: {
      signal: controller.signal, assertCurrentAuthority: () => { if (revoked) throw new Error('session_authority_revoked'); },
    } });
    expect(harness.terminate).toHaveBeenCalledOnce();
    if (fault === 'signal') controller.abort();
    if (fault === 'authority') revoked = true;
    if (fault === 'operator-dismiss') harness.operatorDismissed = true;
    finishTermination(true);
    await expect(resuming).rejects.toThrow(fault === 'operator-dismiss' ? /orchestrator_operator_dismissed/ : /session_authority_revoked/);
    expect(harness.spawnCount).toBe(0);
  },
);

it('F-1063: only the actual respawn result proves a new mounted runtime', async () => {
  liveMission = { ...mission, createdAt: Date.now(), updatedAt: Date.now() };
  const result = await fastLane.resumeFastLaneMission(scope, mission.id, { remountKind: 'automatic' });
  expect(result).toMatchObject({ kind: 'mounted', sessionId: 'session-1' });
  expect(harness.spawnCount).toBe(1);
});
