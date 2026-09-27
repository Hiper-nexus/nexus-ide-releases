import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneSessionState } from '../../shared/surface-payload-types';
import type { Mission, SquadAgent } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';

/**
 * Via Rápida no modelo PULL: o motor não lê PRONTO/BLOQUEADO do PTY e não
 * recutuca o pane. Pane vazio após o turno NÃO conclui nem bloqueia —
 * Overclock: só o operador para a missão.
 */

const harness = vi.hoisted(() => ({
  sessionStates: new Map<string, PaneSessionState | null>(),
  snapshots: [] as Array<{
    missionId: string;
    paneId: string;
    sessionId: string;
    role: 'orchestrator' | 'worker';
    agentName: string;
  }>,
  handoffs: [] as Array<{
    status: string;
    summary: string;
    fromAgent?: string;
    sessionId?: string;
  }>,
  deliverAgentPrompt: vi.fn(async () => true),
  completeVerified: vi.fn(),
  blockTechnical: vi.fn(),
  resumeTechnical: vi.fn(),
  spawnCount: 0,
  recordKickoffAcceptance: vi.fn(),
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

vi.mock('../pty/pre-spawn-probe', () => ({
  assertPreSpawnProbe: async () => {},
  PreSpawnProbeError: class PreSpawnProbeError extends Error {},
}));

// Fail-closed do bootstrap (0.60): Maestro exige adapter cli-pty com rota
// Nexus MCP; o registry real não carrega builtins no vitest.
vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: (id: string) => ({
    id,
    label: id,
    kind: 'cli-pty',
    bin: 'claude',
    quirks: { nexusMcp: 'flag' },
    spawn: { initialPrompt: 'positional' },
  }),
}));

vi.mock('./tool-util', () => ({
  deliverAgentPrompt: (...args: unknown[]) =>
    harness.deliverAgentPrompt(...(args as [])),
  proveNativeArgvBriefAccepted: async () => {},
  withProjectContextBlocks: (options: { prompt?: string }) => options.prompt,
}));

vi.mock('./pane-registry', () => ({
  readSessionOutput: () => '',
  wasOrchestratorOperatorDismissed: () => false,
  clearOperatorDismissedPanes: () => {},
  listPaneSnapshots: () =>
    harness.snapshots.map((pane) => ({
      ...pane,
      state: harness.sessionStates.get(pane.sessionId) ?? 'idle',
    })),
  requestPaneSpawn: async () => {
    harness.spawnCount += 1;
    const sessionId = `session-${harness.spawnCount}`;
    const paneId = `pane-${harness.spawnCount}`;
    harness.sessionStates.set(sessionId, 'idle');
    harness.snapshots.push({
      missionId: 'mission-1',
      paneId,
      sessionId,
      role: harness.spawnCount === 1 ? 'orchestrator' : 'worker',
      agentName:
        harness.spawnCount === 1 ? 'Coordenar e revisar' : 'Implementar motor',
    });
    return { requestId: 'r', ok: true, paneId, sessionId };
  },
}));

const mission: Mission = {
  id: 'mission-1',
  title: 'Prova',
  description: 'Leia brief.txt e escreva a primeira frase em resumo.txt.',
  status: 'pending',
  intentState: 'ready_to_start',
  intentVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  squadId: 'squad-1',
  milestones: [],
} as unknown as Mission;

let liveMission: Mission = mission;

vi.mock('./project-domain-store-registry', () => ({
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
      recordKickoffAcceptance: (...args: unknown[]) =>
        harness.recordKickoffAcceptance(...args),
      hasCurrentKickoffAcceptance: () => false,
    },
    missionPanes: { record: () => {}, list: () => [] },
    tasks: {
      hasPlan: () => false,
      list: () => [],
      listPlannedTasks: () => [],
    },
    taskDispatches: { list: () => [] },
    handoffs: { list: () => harness.handoffs },
  }),
}));

const squadAgents: SquadAgent[] = [
  {
    id: 'coord',
    agentName: 'Coordenar e revisar',
    category: 'orchestrator',
    cli: 'agy',
  } as SquadAgent,
  {
    id: 'exec-1',
    agentName: 'Implementar motor',
    category: 'executor',
    cli: 'agy',
  } as SquadAgent,
];

vi.mock('./squad-store', () => ({
  getSquad: () => ({ id: 'squad-1', agents: squadAgents }),
}));

vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({
    completeVerified: (...args: unknown[]) =>
      harness.completeVerified(...args),
    blockTechnical: (...args: unknown[]) => harness.blockTechnical(...args),
    resumeTechnical: (...args: unknown[]) => harness.resumeTechnical(...args),
  }),
}));

type FastLaneModule = typeof import('./mission-fast-lane');
type MarkerModule = typeof import('./mission-completion-marker');

let fastLane: FastLaneModule;
let marker: MarkerModule;

const scope = testProjectScope();

async function bootOrchestratorIdle(): Promise<string> {
  await fastLane.fastLaneBootstrap(scope, 'mission-1');
  const sessionId = 'session-1';
  harness.sessionStates.set(sessionId, 'idle');
  return sessionId;
}

async function ticks(count: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(15_000 * count);
}

beforeEach(async () => {
  vi.useFakeTimers();
  harness.sessionStates.clear();
  harness.snapshots.length = 0;
  harness.handoffs.length = 0;
  harness.deliverAgentPrompt.mockClear();
  harness.completeVerified.mockClear();
  harness.blockTechnical.mockClear();
  harness.resumeTechnical.mockClear();
  harness.recordKickoffAcceptance.mockClear();
  harness.spawnCount = 0;
  liveMission = mission;
  vi.resetModules();
  fastLane = await import('./mission-fast-lane');
  marker = await import('./mission-completion-marker');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Via Rápida × modelo PULL', () => {
  it('spawna só o orquestrador; pane idle não é recutucado nem concluído', async () => {
    await bootOrchestratorIdle();
    expect(harness.spawnCount).toBe(1);
    // 0.60: o recibo nasce no spawn e o idle confirma via kickoff-direct
    // queue — pode registrar mais de uma vez, nunca zero.
    expect(harness.recordKickoffAcceptance).toHaveBeenCalled();

    await ticks(4);

    expect(harness.deliverAgentPrompt).not.toHaveBeenCalled();
    expect(harness.completeVerified).not.toHaveBeenCalled();
    expect(harness.blockTechnical).not.toHaveBeenCalled();
  });

  it('orquestrador morto com handoff de sucesso NÃO conclui a missão', async () => {
    await bootOrchestratorIdle();
    harness.handoffs.push({
      status: 'success',
      summary: 'Primeira frase do brief.txt gravada em resumo.txt.',
      fromAgent: 'Implementar motor',
      sessionId: 'session-2',
    });
    harness.sessionStates.set('session-1', 'exited');

    await ticks(1);

    // 0.60 (A3): Maestro morto em missão running é RESPAWNADO uma vez com o
    // briefing re-entregue — o que continua proibido é concluir/bloquear.
    expect(harness.blockTechnical).not.toHaveBeenCalled();
    expect(harness.completeVerified).not.toHaveBeenCalled();
    expect(liveMission.status).toBe('running');
  });

  it('PRONTO no PTY não arma observador nem conclui — entrega é handoff', async () => {
    const sessionId = await bootOrchestratorIdle();
    expect(marker.missionMarkerObserver.isWatching(sessionId)).toBe(false);
    marker.missionMarkerObserver.observe(
      sessionId,
      'PRONTO: Primeira frase do brief.txt gravada em resumo.txt.\n',
    );
    expect(marker.missionMarkerObserver.markerOf(sessionId)).toBeNull();

    await ticks(2);

    expect(harness.completeVerified).not.toHaveBeenCalled();
    expect(harness.blockTechnical).not.toHaveBeenCalled();
  });

  it('orquestrador morto sem handoff NÃO bloqueia — missão segue running', async () => {
    await bootOrchestratorIdle();
    harness.sessionStates.set('session-1', 'exited');

    await ticks(1);

    expect(harness.completeVerified).not.toHaveBeenCalled();
    expect(harness.blockTechnical).not.toHaveBeenCalled();
    expect(liveMission.status).toBe('running');
  });

  it('pane morto sem handoff continua não sendo sucesso', async () => {
    await bootOrchestratorIdle();
    harness.sessionStates.set('session-1', 'exited');
    await ticks(2);

    expect(harness.completeVerified).not.toHaveBeenCalled();
    expect(harness.blockTechnical).not.toHaveBeenCalled();
  });

  it('retry-kickoff respawna o Maestro quando running sem sessão viva', async () => {
    await bootOrchestratorIdle();
    harness.sessionStates.set('session-1', 'exited');
    await ticks(1);
    const spawnedBefore = harness.spawnCount;

    liveMission = { ...liveMission, status: 'running', intentState: 'executing' };
    await fastLane.resumeFastLaneMission(scope, 'mission-1');

    expect(harness.spawnCount).toBe(spawnedBefore + 1);
    expect(harness.blockTechnical).not.toHaveBeenCalled();
    expect(harness.completeVerified).not.toHaveBeenCalled();
  });

  it('retomada de missão encerrada tira o selo runtime-closed da description', async () => {
    harness.resumeTechnical.mockImplementationOnce((_scope, input) => {
      liveMission = {
        ...liveMission,
        status: 'running',
        intentState: 'executing',
        description: input.description,
      } as Mission;
    });
    liveMission = {
      ...mission,
      status: 'blocked',
      intentState: 'blocked_user',
      description:
        'Leia brief.txt e escreva a primeira frase em resumo.txt.\n\n' +
        '<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador; histórico e receipts preservados.',
    } as Mission;

    await fastLane.resumeFastLaneMission(scope, 'mission-1');

    expect(harness.resumeTechnical).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        description: 'Leia brief.txt e escreva a primeira frase em resumo.txt.',
      }),
    );
    expect(liveMission.description).not.toContain('runtime-closed');
  });
});
