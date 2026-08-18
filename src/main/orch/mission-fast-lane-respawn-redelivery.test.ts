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
  }>,
  spawnCount: 0,
  redeliver: vi.fn((): number => 0),
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: (sessionId: string) =>
    harness.sessionStates.get(sessionId) ?? null,
  registeredOrchestratorSessionsForMission: () => [],
  orchTerminateSession: () => Promise.resolve(true),
}));

vi.mock('./tool-util', () => ({
  deliverAgentPrompt: vi.fn(async () => true),
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => harness.snapshots,
  requestPaneSpawn: async () => {
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

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => liveMission,
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
    },
    missionPanes: { record: () => {}, list: () => [] },
    handoffs: {
      list: () => [
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
    completeVerified: vi.fn(),
    blockTechnical: vi.fn(),
    resumeTechnical: vi.fn(),
  }),
}));

vi.mock('./idle-delivery', () => ({
  redeliverPendingHandoffs: (...args: unknown[]) =>
    harness.redeliver(...(args as [])) as number,
}));

type FastLaneModule = typeof import('./mission-fast-lane');

let fastLane: FastLaneModule;

const scope = testProjectScope();

beforeEach(async () => {
  vi.useFakeTimers();
  harness.sessionStates.clear();
  harness.snapshots.length = 0;
  harness.spawnCount = 0;
  harness.redeliver.mockClear();
  liveMission = mission;
  vi.resetModules();
  fastLane = await import('./mission-fast-lane');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('respawn do orquestrador re-entrega handoffs pendentes (A3)', () => {
  it('missão running sem orquestrador vivo → respawn chama redeliverPendingHandoffs', async () => {
    await fastLane.fastLaneBootstrap(scope, 'mission-1');

    expect(harness.spawnCount).toBe(1);
    expect(harness.redeliver).toHaveBeenCalledTimes(1);
    expect(harness.redeliver).toHaveBeenCalledWith(scope, 'mission-1');
  });
});
