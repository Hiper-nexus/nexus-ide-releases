/**
 * Isolamento leftover durável: park persiste status não-running e reopen
 * NÃO remonta Maestro/PTY. pickFocusedRunningMission é só deste processo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import {
  NEXUS_LEFTOVER_PARKED_MARKER,
  persistLeftoverIsolation,
} from '../../shared/mission-leftover-isolation';
import { testProjectScope } from './__tests__/scope-fixture';

const harness = vi.hoisted(() => ({
  missions: new Map<string, Mission>(),
  spawnCount: 0,
  hasKickoffReceipt: false,
  snapshots: [] as Array<{
    missionId: string;
    role: string;
    sessionId: string;
  }>,
  sessionStates: new Map<string, string>(),
  agentSessions: [] as Array<{ sessionId: string; missionId: string }>,
  terminated: [] as string[],
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: (sessionId: string) =>
    harness.sessionStates.get(sessionId) ?? null,
  registeredOrchestratorSessionsForMission: () => [],
  listAgentSessions: () => harness.agentSessions,
  orchTerminateSession: async (sessionId: string) => {
    harness.terminated.push(sessionId);
    return true;
  },
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => harness.snapshots,
  wasOrchestratorOperatorDismissed: () => false,
  clearOperatorDismissedPanes: () => {},
  requestPaneSpawn: async () => {
    harness.spawnCount += 1;
    return {
      requestId: 'r',
      ok: true,
      paneId: `pane-${harness.spawnCount}`,
      sessionId: `session-${harness.spawnCount}`,
    };
  },
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      list: (status?: string) =>
        [...harness.missions.values()].filter(
          (mission) => !status || mission.status === status,
        ),
      get: (id: string) => harness.missions.get(id) ?? null,
      update: (id: string, patch: Partial<Mission>) => {
        const current = harness.missions.get(id);
        if (!current) return null;
        const next = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
        harness.missions.set(id, next as Mission);
        return next;
      },
      hasCurrentKickoffAcceptance: () => harness.hasKickoffReceipt,
    },
    tasks: {
      hasPlan: () => false,
      list: () => [],
      listPlannedTasks: () => [],
    },
    taskDispatches: { list: () => [] },
    handoffs: { list: () => [] },
    missionPanes: { record: () => {}, list: () => [] },
  }),
}));

vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({
    resumeTechnical: vi.fn(),
    blockTechnical: vi.fn(),
  }),
}));

vi.mock('./squad-store', () => ({
  getSquad: () => null,
}));

import {
  parkSiblingRunningMissions,
  pickFocusedRunningMission,
  resurrectRunningMissionsForScope,
} from './mission-fast-lane';

const scope = testProjectScope();

function leftoverRunning(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-leftover',
    title: 'Waitlist leftover',
    description: 'Time de 20 stories que ficou na rail',
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    squadId: 'squad-1',
    milestones: [],
    learnings: '',
    ...overrides,
  } as Mission;
}

describe('persist leftover + reopen não remonta', () => {
  beforeEach(() => {
    harness.missions.clear();
    harness.spawnCount = 0;
    harness.hasKickoffReceipt = false;
    harness.snapshots = [];
    harness.sessionStates.clear();
    harness.agentSessions = [];
    harness.terminated = [];
  });

  it('park persiste blocked (não running) com selo leftover', () => {
    const row = leftoverRunning();
    harness.missions.set(row.id, row);
    const parked = persistLeftoverIsolation(
      {
        get: (id) => harness.missions.get(id) ?? null,
        update: (id, patch) => {
          const current = harness.missions.get(id);
          if (!current) return null;
          const next = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
          harness.missions.set(id, next as Mission);
          return next as Mission;
        },
      },
      row.id,
      'park',
    );

    expect(parked?.status).toBe('blocked');
    expect(parked?.intentState).toBe('blocked_user');
    expect(parked?.description).toContain(NEXUS_LEFTOVER_PARKED_MARKER);
    expect(harness.missions.get(row.id)?.status).not.toBe('running');
  });

  it('reopen / ressurreição não remonta leftover running sem Maestro deste processo', async () => {
    const leftover = leftoverRunning();
    harness.missions.set(leftover.id, leftover);
    harness.spawnCount = 0;

    await resurrectRunningMissionsForScope(scope);

    const persisted = harness.missions.get(leftover.id);
    expect(persisted?.status).toBe('blocked');
    expect(persisted?.description).toContain(NEXUS_LEFTOVER_PARKED_MARKER);
    expect(harness.spawnCount).toBe(0);
  });

  it('Encerrar persiste leftover e reopen não remonta a Via Rápida', async () => {
    const tiny = leftoverRunning({
      id: 'mission-ebd1c3ee',
      title: 'stress-tiny',
    });
    harness.missions.set(tiny.id, tiny);
    persistLeftoverIsolation(
      {
        get: (id) => harness.missions.get(id) ?? null,
        update: (id, patch) => {
          const current = harness.missions.get(id);
          if (!current) return null;
          const next = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
          harness.missions.set(id, next as Mission);
          return next as Mission;
        },
      },
      tiny.id,
      'encerrar',
    );
    harness.missions.set(tiny.id, {
      ...harness.missions.get(tiny.id)!,
      status: 'running',
      intentState: 'executing',
    });

    await resurrectRunningMissionsForScope(scope);

    expect(harness.spawnCount).toBe(0);
    expect(
      pickFocusedRunningMission(
        [...harness.missions.values()],
        new Map([[tiny.id, 'sess-zombie']]),
      ),
    ).toBeNull();
    expect(harness.missions.get(tiny.id)?.status).toBe('blocked');
  });

  it('uma focused com Maestro deste processo fica viva; Encerrar leftover dorme e reopen não remonta', async () => {
    const focused = leftoverRunning({
      id: 'mission-focused',
      title: 'time novo',
      updatedAt: Date.now(),
    });
    const tiny = leftoverRunning({
      id: 'mission-ebd1c3ee',
      title: 'stress-tiny',
    });
    harness.missions.set(focused.id, focused);
    harness.missions.set(tiny.id, tiny);
    persistLeftoverIsolation(
      {
        get: (id) => harness.missions.get(id) ?? null,
        update: (id, patch) => {
          const current = harness.missions.get(id);
          if (!current) return null;
          const next = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
          harness.missions.set(id, next as Mission);
          return next as Mission;
        },
      },
      tiny.id,
      'encerrar',
    );
    harness.snapshots = [
      {
        missionId: focused.id,
        role: 'orchestrator',
        sessionId: 'sess-live',
      },
    ];
    harness.sessionStates.set('sess-live', 'idle');

    await resurrectRunningMissionsForScope(scope);

    expect(harness.missions.get(tiny.id)?.status).toBe('blocked');
    expect(harness.missions.get(tiny.id)?.status).not.toBe('running');
    expect(harness.missions.get(focused.id)?.status).toBe('running');
    expect(harness.spawnCount).toBe(0);
    expect(
      pickFocusedRunningMission(
        [...harness.missions.values()],
        new Map([[focused.id, 'sess-live']]),
      )?.id,
    ).toBe(focused.id);
  });

  it('pickFocusedRunningMission ignora leftover do disco — só Maestro vivo neste processo', () => {
    const disk = leftoverRunning({ id: 'disk-row', updatedAt: 99 });
    const live = leftoverRunning({ id: 'this-process', updatedAt: 2 });
    expect(
      pickFocusedRunningMission(
        [disk, live],
        new Map([['this-process', 'sess-live']]),
      )?.id,
    ).toBe('this-process');
    expect(pickFocusedRunningMission([disk], new Map())).toBeNull();
  });

  it('Iniciar uma missão nova estaciona as outras running e mata o PTY delas', async () => {
    const nova = leftoverRunning({
      id: 'mission-nova',
      title: 'nova',
      updatedAt: Date.now(),
    });
    const velha = leftoverRunning({
      id: 'mission-velha',
      title: 'velha',
      updatedAt: Date.now() - 10_000,
    });
    harness.missions.set(nova.id, nova);
    harness.missions.set(velha.id, velha);
    harness.snapshots = [
      { missionId: velha.id, role: 'orchestrator', sessionId: 'sess-velha' },
    ];
    harness.agentSessions = [
      { sessionId: 'sess-velha', missionId: velha.id },
      { sessionId: 'sess-velha-writer', missionId: velha.id },
    ];

    const parked = await parkSiblingRunningMissions(scope, nova.id);

    expect(parked).toEqual([velha.id]);
    expect(harness.missions.get(velha.id)?.status).toBe('blocked');
    expect(harness.missions.get(velha.id)?.description).toContain(
      NEXUS_LEFTOVER_PARKED_MARKER,
    );
    expect(harness.missions.get(nova.id)?.status).toBe('running');
    expect(harness.terminated.sort()).toEqual(
      ['sess-velha', 'sess-velha-writer'].sort(),
    );
  });

  it('kickoff fresco com recibo desta sessão ainda pode nascer — não é leftover', async () => {
    const fresh = leftoverRunning({
      id: 'mission-fresh',
      updatedAt: Date.now(),
    });
    harness.missions.set(fresh.id, fresh);
    harness.hasKickoffReceipt = true;

    await resurrectRunningMissionsForScope(scope);

    // Sem squad/orquestrador o bootstrap falha — o ponto é NÃO persistir leftover
    // e tentar retomar (spawn não ocorre porque o roster está vazio).
    expect(harness.missions.get(fresh.id)?.status).toBe('running');
    expect(harness.missions.get(fresh.id)?.description).not.toContain(
      NEXUS_LEFTOVER_PARKED_MARKER,
    );
  });
});
