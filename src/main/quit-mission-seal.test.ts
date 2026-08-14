import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, MissionPaneSpec } from '../shared/orch-types';
import type { ProjectExecutionScope } from '../shared/types';
import {
  compileIntentContract,
  hasCurrentDispatchAuthority,
} from '../shared/mission-intent';
import { MISSION_RUNTIME_CLOSED_MARKER } from '../shared/mission-recovery-policy';

const runtime = vi.hoisted(() => ({
  pty: [] as Array<Record<string, unknown>>,
  terminatePty: vi.fn(async (_sessionId: string) => true),
  closeMissionPane: vi.fn(async () => true),
}));

vi.mock('./pty/pty-manager', () => ({
  getSessionState: (sessionId: string) =>
    runtime.pty.some((entry) => entry.sessionId === sessionId) ? 'idle' : null,
  listAgentSessions: () => [...runtime.pty],
  orchTerminateSession: async (sessionId: string) => {
    const result = await runtime.terminatePty(sessionId);
    if (result) {
      runtime.pty = runtime.pty.filter(
        (entry) => entry.sessionId !== sessionId,
      );
    }
    return result;
  },
}));

vi.mock('./orch/pane-registry', () => ({
  getPaneRuntimeAuthorityBySession: (sessionId: string) =>
    runtime.pty.find((entry) => entry.sessionId === sessionId) ?? null,
  listPaneSnapshots: () => [],
  requestMissionPaneClose: runtime.closeMissionPane,
}));

import { closeMissionRuntimePreservingHistory } from './orch/mission-runtime-termination';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'installation-quit-seal',
  projectId: 'project-quit-seal',
  checkoutId: 'checkout-quit-seal',
  rootRealPath: '/workspace/quit-seal',
  identitySource: 'manifest',
});

type DomainSuite = Parameters<
  typeof closeMissionRuntimePreservingHistory
>[0]['suite'];

function authorizedMission(id: string): Mission {
  const contract = compileIntentContract({
    goal: 'Continuar a execução aprovada',
    intentVersion: 1,
  });
  return {
    id,
    title: `Missão ${id}`,
    description: '',
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    intentContract: {
      ...contract,
      approvedAt: 10,
      dispatchedAt: 11,
    },
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 2,
  };
}

function pane(
  paneId: string,
  missionId: string,
  workerIncarnationId: string,
): MissionPaneSpec {
  return {
    id: `persisted-${paneId}`,
    missionId,
    paneId,
    adapterId: 'codex',
    title: paneId,
    agentName: paneId,
    workerIncarnationId,
    role: 'worker',
    scope,
    createdAt: 1,
  };
}

function physical(
  sessionId: string,
  paneId: string,
  missionId: string,
  workerIncarnationId: string,
) {
  return {
    sessionId,
    paneId,
    adapterId: 'codex',
    cwd: scope.rootRealPath,
    missionId,
    role: 'worker' as const,
    workerIncarnationId,
    scope,
    kind: 'mission' as const,
  };
}

describe('quit com missões ativas', () => {
  beforeEach(() => {
    runtime.pty = [];
    runtime.terminatePty.mockClear();
    runtime.closeMissionPane.mockClear();
  });

  it('encerra missão running e persiste o selo runtime-closed', async () => {
    const mission = authorizedMission('mission-quit-1');
    const persisted = pane('pane-quit-1', 'mission-quit-1', 'inc-quit-1');
    runtime.pty = [
      physical('pty-quit-1', 'pane-quit-1', 'mission-quit-1', 'inc-quit-1'),
    ];

    let current = mission;
    const suite = {
      missions: {
        get: (missionId: string) =>
          missionId === current.id ? current : null,
        list: (status?: string) =>
          status === 'running' && current.status === 'running'
            ? [current]
            : [],
        update: (missionId: string, patch: Partial<Mission>) => {
          if (missionId !== current.id) return null;
          current = { ...current, ...patch };
          return current;
        },
      },
      missionPanes: {
        list: (missionId: string) =>
          missionId === current.id ? [persisted] : [],
      },
    } as unknown as DomainSuite;

    const result = await closeMissionRuntimePreservingHistory({
      scope,
      suite,
      missionId: mission.id,
    });

    expect(result.ok).toBe(true);
    expect(result.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });
    expect(result.mission?.description).toContain(MISSION_RUNTIME_CLOSED_MARKER);
    expect(runtime.terminatePty).toHaveBeenCalledWith('pty-quit-1');
  });

  it('missão selada não deve passar em hasCurrentDispatchAuthority', () => {
    const sealedMission: Mission = {
      id: 'mission-sealed',
      title: 'Missão selada',
      description: MISSION_RUNTIME_CLOSED_MARKER + '\nEncerrada pelo operador',
      status: 'blocked',
      intentState: 'blocked_user',
      intentVersion: 1,
      intentContract: undefined,
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    };

    expect(hasCurrentDispatchAuthority(sealedMission)).toBe(false);
  });

  it('o diálogo de quit sela missões no botão certo, com teto, antes do app.quit', () => {
    const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf-8');
    const beforeQuit = source.indexOf('app.on("before-quit"');
    const buttons = source.indexOf(
      'buttons: ["Cancelar", "Sair e encerrar processos"]',
      beforeQuit,
    );
    const confirm = source.indexOf('if (response !== 1) return;', beforeQuit);
    const seal = source.indexOf(
      'await closeAllActiveMissionsForShutdown();',
      confirm,
    );
    const authorize = source.indexOf('authorizeAppQuit();', seal);
    const quit = source.indexOf('app.quit();', authorize);

    expect(beforeQuit).toBeGreaterThanOrEqual(0);
    expect(buttons).toBeGreaterThan(beforeQuit);
    expect(buttons).toBeLessThan(confirm);
    expect(confirm).toBeGreaterThan(buttons);
    expect(seal).toBeGreaterThan(confirm);
    expect(authorize).toBeGreaterThan(seal);
    expect(quit).toBeGreaterThan(authorize);
    expect(source).toContain('QUIT_MISSION_SEAL_BUDGET_MS = 4_000');
    const sealFn = source.indexOf(
      'async function closeAllActiveMissionsForShutdown',
    );
    expect(sealFn).toBeGreaterThanOrEqual(0);
    expect(sealFn).toBeLessThan(beforeQuit);
    expect(source.slice(sealFn, beforeQuit)).toContain('Promise.race');
  });

  it('encerra múltiplas missões em paralelo no quit', async () => {
    const mission1 = authorizedMission('mission-multi-1');
    const mission2 = authorizedMission('mission-multi-2');
    const persisted1 = pane('pane-multi-1', 'mission-multi-1', 'inc-multi-1');
    const persisted2 = pane('pane-multi-2', 'mission-multi-2', 'inc-multi-2');

    runtime.pty = [
      physical('pty-multi-1', 'pane-multi-1', 'mission-multi-1', 'inc-multi-1'),
      physical('pty-multi-2', 'pane-multi-2', 'mission-multi-2', 'inc-multi-2'),
    ];

    const missions = new Map<string, Mission>([
      [mission1.id, mission1],
      [mission2.id, mission2],
    ]);

    const suite = {
      missions: {
        get: (missionId: string) => missions.get(missionId) ?? null,
        list: (status?: string) =>
          status === 'running'
            ? Array.from(missions.values()).filter((m) => m.status === 'running')
            : Array.from(missions.values()),
        update: (missionId: string, patch: Partial<Mission>) => {
          const current = missions.get(missionId);
          if (!current) return null;
          const updated = { ...current, ...patch };
          missions.set(missionId, updated);
          return updated;
        },
      },
      missionPanes: {
        list: (missionId: string) =>
          missionId === mission1.id
            ? [persisted1]
            : missionId === mission2.id
              ? [persisted2]
              : [],
      },
      scope,
    } as unknown as DomainSuite;

    // Simula o que closeAllActiveMissionsForShutdown faz
    const runningMissions = suite.missions.list('running');
    expect(runningMissions).toHaveLength(2);

    const results = await Promise.all(
      runningMissions.map((mission) =>
        closeMissionRuntimePreservingHistory({
          scope,
          suite,
          missionId: mission.id,
        }),
      ),
    );

    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(true);

    // Após encerrar, list('running') deve retornar vazio
    const stillRunning = suite.missions.list('running');
    expect(stillRunning).toHaveLength(0);

    // Ambas devem ter o marker
    const sealed1 = missions.get(mission1.id);
    const sealed2 = missions.get(mission2.id);
    expect(sealed1?.description).toContain(MISSION_RUNTIME_CLOSED_MARKER);
    expect(sealed2?.description).toContain(MISSION_RUNTIME_CLOSED_MARKER);
    expect(sealed1?.status).toBe('blocked');
    expect(sealed2?.status).toBe('blocked');
  });
});
