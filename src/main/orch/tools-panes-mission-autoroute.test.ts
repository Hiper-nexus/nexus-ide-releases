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
  panes: [] as Array<Record<string, unknown>>,
}));
vi.mock('./tool-util', async (original) => ({
  ...(await original<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: h.spawn,
}));
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => h.panes,
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
vi.mock('../adapters/adapter-registry', async (original) => ({
  ...(await original<typeof import('../adapters/adapter-registry')>()),
  // AGY lê o MCP do perfil nativo (canUseNexusMcp=false); Codex carrega o Nexus.
  listAdapters: () => [
    { id: 'agy', kind: 'cli-pty', bin: 'agy', quirks: { nexusMcp: 'agy' } },
    { id: 'codex', kind: 'cli-pty', bin: 'codex', quirks: { nexusMcp: 'codex' } },
  ],
}));
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
  h.panes = [];
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
    expect(receipt.route.ignored).toEqual({ model: 'ignorado' });
  });

  it('tentativa abortada antes do spawn fecha a reserva do auto-roteamento', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'kimi', model: 'kimi-k2', routeReservationId: 'rr-abort',
    })));
    await expect(paneSpawnTool.handler({ task: 'implementar o login' }, ctx)).rejects.toThrow();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.consumeRouteReservation).toHaveBeenCalledWith(
      { reservationId: 'rr-abort', missionId: 'mission-a', adapterId: 'kimi', model: 'kimi-k2' },
      'orch-session',
    );
  });

  it('no modo livre a reserva criada pelo auto-roteamento é consumida, não fica pendurada', async () => {
    h.mission = {
      ...h.mission,
      intentContract: { ...(h.mission.intentContract as object), freeAgentChoice: true },
    };
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-free',
    })));
    await paneSpawnTool.handler({ task: 'implementar o login', prompt: 'faça o login' }, ctx);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.consumeRouteReservation).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'rr-free', adapterId: 'codex', model: 'gpt-5.4' }),
      'orch-session',
    );
  });

  it('só com task, o worker recebe a task como tarefa (não nasce sem brief)', async () => {
    h.mission = {
      ...h.mission,
      intentContract: { ...(h.mission.intentContract as object), freeAgentChoice: true },
    };
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-task',
    })));
    await paneSpawnTool.handler({ task: 'implementar o login com OTP' }, ctx);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(String(h.spawn.mock.calls[0][0].prompt)).toContain('implementar o login com OTP');
  });

  it('adapterId explícito continua aceito e não aciona o roteador', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'kimi' }));
    setOperatorRouteResolver(resolver);
    await expect(paneSpawnTool.handler({ adapterId: 'codex', model: 'gpt-5.4' }, ctx))
      .rejects.toThrow(/route_reservation_required/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('pane do "+ Pane" na missão da aba só roteia helper para CLI com MCP do Nexus (F-658)', async () => {
    // Campo 28/09: a missão sob demanda levou os helpers do operador à rota de
    // missão, que aceitava AGY — três panes mudos no `--print`.
    const resolver = vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-tab',
    }));
    setOperatorRouteResolver(resolver);
    const operatorTab = { ...ctx, promotedFromUserSession: true as const };
    await paneSpawnTool.handler({ task: 'mapear as telas', prompt: 'mapeie' }, operatorTab);
    expect(resolver).toHaveBeenCalledWith('mapear as telas', operatorTab, {
      excludeAdapterIds: ['agy'],
    });
  });

  it('sem task nem prompt pede a tarefa', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    await expect(paneSpawnTool.handler({}, ctx)).rejects.toThrow(/descreva a tarefa/);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe('missão da aba redistribui a CLI lotada (F-674)', () => {
  const tabMission = () => ({
    ...h.mission,
    squadId: undefined,
    intentContract: {
      ...(h.mission.intentContract as object),
      freeAgentChoice: true,
      workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' },
    },
  });
  const liveClaude = (paneId: string) => ({
    paneId, sessionId: `s-${paneId}`, adapterId: 'claude', state: 'busy', missionId: 'mission-a', role: 'worker',
  });

  it('orquestrador fixa claude com 2 helpers vivos em claude: o Nexus roteia pela tarefa', async () => {
    // Campo 28/09: sem o operador pedir, só nasciam helpers Claude.
    h.mission = tabMission();
    h.panes = [liveClaude('p1'), liveClaude('p2')];
    const resolver = vi.fn(async () => ({ adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-div' }));
    setOperatorRouteResolver(resolver);
    const receipt = await paneSpawnTool.handler(
      { adapterId: 'claude', model: 'claude-opus-5-5', task: 'revisar o kanban', prompt: 'revise' }, ctx,
    ) as Record<string, any>;
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'codex', model: 'gpt-5.4' });
    expect(receipt.route.redistributed).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5', sameAdapterLive: 2 });
  });

  it('operatorChoice:true respeita a CLI que o operador pediu', async () => {
    h.mission = tabMission();
    h.panes = [liveClaude('p1'), liveClaude('p2')];
    const resolver = vi.fn(async () => ({ adapterId: 'codex' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler(
      { adapterId: 'claude', model: 'claude-opus-5-5', operatorChoice: true, task: 'revisar', prompt: 'revise' }, ctx,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'claude' });
  });
});
