import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { compileIntentContract } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  spawn: vi.fn(async (_options: Record<string, unknown>, hooks?: { onPaneCreated?: (p: string) => void }) => {
    hooks?.onPaneCreated?.('pane-w');
    return { paneId: 'pane-w', sessionId: 'session-w' };
  }),
  assertRouteReservation: vi.fn(),
  consumeRouteReservation: vi.fn(),
  mission: {} as Record<string, unknown>,
}));
vi.mock('./tool-util', async (original) => ({
  ...(await original<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: h.spawn,
}));
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => [],
  takePendingPaneSpawnResult: () => null,
}));
vi.mock('./gate', async (original) => ({
  ...(await original<typeof import('./gate')>()),
  assertCurrentMissionOrchestratorSession: vi.fn(),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => h.mission,
      assertRouteReservation: h.assertRouteReservation,
      consumeRouteReservation: h.consumeRouteReservation,
    },
    missionPanes: { list: () => [{ paneId: 'pane-w', role: 'worker' }] },
  }),
}));
vi.mock('./task-dispatch-authority', () => ({ isTaskQueueManagedMission: () => false }));
vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({ getMissionWorkflow: () => ({ contract: null }) }),
}));
vi.mock('./squad-store', async (original) => ({
  ...(await original<typeof import('./squad-store')>()),
  findAgentInAnySquad: () => null,
  getSquad: () => null,
  squadRoutableCliIds: () => new Set(['codex']),
}));

import { paneSpawnTool, setOperatorRouteResolver } from './tools-panes';

const ctx: AgentGateContext = {
  token: 'orch', label: 'Maestro', role: 'orchestrator', sessionId: 'orch-session',
  missionId: 'mission-a', scope: testProjectScope(),
  allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.mission = {
    id: 'mission-a', title: 'Feature', description: '', status: 'running', squadId: 'squad',
    intentContract: { ...compileIntentContract({ goal: 'Feature', intentVersion: 1 }), maxWorkers: 8 },
  };
});

describe('nexus_pane_spawn dentro da missão sem adapterId', () => {
  it('roteia pela task da missão e consome a RouteReservation devolvida', async () => {
    const resolver = vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-1', tier: 'medium',
    }));
    setOperatorRouteResolver(resolver);
    const receipt = await paneSpawnTool.handler(
      { task: 'implementar o login', prompt: 'faça o login', model: 'ignorado' }, ctx,
    ) as Record<string, any>;
    expect(resolver).toHaveBeenCalledWith('implementar o login', ctx, {});
    expect(h.assertRouteReservation).toHaveBeenCalledWith({
      reservationId: 'rr-1', missionId: 'mission-a', adapterId: 'codex', model: 'gpt-5.4', effort: 'high',
    });
    expect(h.consumeRouteReservation).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'rr-1' }), 'orch-session');
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'codex', model: 'gpt-5.4', role: 'worker', missionId: 'mission-a' });
    expect(receipt.harness.source).toBe('auto-route');
    expect(receipt.route.tier).toBe('medium');
  });

  it('adapterId explícito continua aceito e não aciona o roteador', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'kimi' }));
    setOperatorRouteResolver(resolver);
    await expect(paneSpawnTool.handler({ adapterId: 'codex', model: 'gpt-5.4' }, ctx))
      .rejects.toThrow(/route_reservation_required/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('sem task nem prompt pede a tarefa', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    await expect(paneSpawnTool.handler({}, ctx)).rejects.toThrow(/descreva a tarefa/);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
