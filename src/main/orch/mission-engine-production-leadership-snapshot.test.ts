/**
 * Onda 1 (leitores sem efeito) da religação da liderança única: o snapshot
 * do motor de produção passa a derivar pane E sessão do orquestrador do
 * MESMO par (sessionId,paneId) provado por `resolveMissionLeader`, em vez
 * de escolher independentemente "primeiro pane com role=orchestrator" (C) e
 * "mission.orchestratorSessionId" (A) — as duas fontes podiam divergir e
 * fabricar uma associação pane↔sessão inexistente
 * (docs/analysis/2026-09-16-plano-religacao-lideranca.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff, Mission, MissionPaneSpec } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from './__tests__/scope-fixture';
import type { MissionLeader } from './mission-leadership';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

const harness = vi.hoisted(() => ({
  sessionStates: new Map<string, string | null>(),
  semanticByPane: new Map<string, 'working' | 'awaiting-input' | 'error'>(),
  resolveMissionLeader: vi.fn<(scope: ProjectExecutionScope, missionId: string) => MissionLeader | null>(),
  agentSessionsByPane: new Map<string, Array<Record<string, unknown>>>(),
  paneSnapshots: [] as Array<Record<string, unknown>>,
  squads: new Map<string, { id: string; agents: Array<Record<string, unknown>> }>(),
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: (sessionId: string) => harness.sessionStates.get(sessionId) ?? null,
  listAgentSessionsForPane: (paneId: string) => harness.agentSessionsByPane.get(paneId) ?? [],
}));

vi.mock('./agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-status')>()),
  getAgentSemanticStatus: (paneId: string) => {
    const status = harness.semanticByPane.get(paneId);
    return status ? { status, paneId, sessionId: 's-worker', source: 'hook', updatedAt: Date.now() } : null;
  },
  getAgentSemanticStatusBySession: () => null,
}));

vi.mock('./squad-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./squad-store')>()),
  getSquad: (id: string) => harness.squads.get(id) ?? null,
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => harness.paneSnapshots,
  getPaneRuntimeAuthorityBySession: () => null,
  readSessionOutput: () => '',
}));

vi.mock('./mission-leadership-runtime', () => ({
  getMissionLeadership: () => ({ resolveMissionLeader: harness.resolveMissionLeader }),
}));

import { MissionLeadershipError } from './mission-leadership';
import { projectMissionEngineSnapshotView } from './mission-engine-production';
import { projectMissionSnapshot } from './mission-snapshot';

const scope = testProjectScope();
const missionId = 'mission-1';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: missionId,
    title: 'Prova',
    description: 'Entregar',
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    milestones: [],
    learnings: '',
    ...overrides,
  } as Mission;
}

function pane(overrides: Partial<MissionPaneSpec> = {}): MissionPaneSpec {
  return {
    missionId,
    paneId: 'pane-old',
    role: 'orchestrator',
    adapterId: 'claude',
    ...overrides,
  } as MissionPaneSpec;
}

function stores(input: {
  mission: Mission;
  panes: readonly MissionPaneSpec[];
  handoffs?: readonly Handoff[];
}): ProjectDomainStoreSuite {
  return {
    missions: {
      get: (id: string) => (id === input.mission.id ? input.mission : null),
      hasCurrentKickoffAcceptance: () => false,
    },
    missionPanes: { list: () => input.panes },
    tasks: { list: () => [], listPlannedTasks: () => [] },
    taskDispatches: { list: () => [] },
    handoffs: { list: () => input.handoffs ?? [] },
  } as unknown as ProjectDomainStoreSuite;
}

beforeEach(() => {
  harness.sessionStates = new Map();
  harness.semanticByPane = new Map();
  harness.resolveMissionLeader.mockReset();
  harness.agentSessionsByPane = new Map();
  harness.paneSnapshots = [];
  harness.squads = new Map();
});

describe('projectMissionEngineSnapshotView — pane/sessão do orquestrador vêm do mesmo par provado', () => {
  it('keeps closed custom-role sessions separate and shows their persisted tool identity', () => {
    const handoffs = ['session-a', 'session-b'].map((sessionId) => ({
      id: `handoff-${sessionId}`, missionId, sessionId, fromAgent: 'implementar utilitário de texto',
      status: 'success', createdAt: 1, routeAttribution: { adapterId: 'kimi', model: 'kimi-code/k3' },
    } as unknown as Handoff));
    const snapshot = projectMissionSnapshot(projectMissionEngineSnapshotView(scope,
      stores({ mission: mission(), panes: [], handoffs }), missionId));
    expect(snapshot.agents).toHaveLength(2);
    for (const [index, agent] of snapshot.agents.entries()) {
      expect(agent).toMatchObject({
        id: `session:${index === 0 ? 'session-a' : 'session-b'}`,
        agentName: 'implementar utilitário de texto', cli: 'kimi', model: 'kimi-code/k3', state: 'done',
      });
      expect(agent).not.toHaveProperty('paneId');
    }
  });

  it.each(['implementar resumo de durações', 'kimi'])('does not turn unproved role %s into a historical provider', (fromAgent) => {
    const handoff = { id: 'handoff-old', missionId, sessionId: 'old-session', fromAgent,
      status: 'success', createdAt: 1 } as Handoff;
    const snapshot = projectMissionSnapshot(projectMissionEngineSnapshotView(scope,
      stores({ mission: mission(), panes: [], handoffs: [handoff] }), missionId));
    expect(snapshot.agents[0]).toMatchObject({ agentName: fromAgent, cli: 'ferramenta não identificada', state: 'done' });
    expect(snapshot.agents[0]).not.toHaveProperty('model');
  });

  it('A e C concordam: pane e sessão do resolver aparecem juntos no snapshot', () => {
    harness.sessionStates.set('session-1', 'busy');
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-1', source: 'durable', proven: true,
    });
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({ mission: mission(), panes: [pane({ paneId: 'pane-1' })] }),
      missionId,
    );
    expect(view.orchestratorLive).toBe(true);
  });

  it('C aponta para um pane órfão que NÃO é o líder provado: não vira orchestratorLive', () => {
    harness.sessionStates.set('session-stale', 'busy');
    // O líder provado é outra sessão/pane; missionPanes só tem o órfão.
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-1', source: 'durable', proven: true,
    });
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({ mission: mission(), panes: [pane({ paneId: 'pane-old', role: 'orchestrator' })] }),
      missionId,
    );
    // orchestratorPane não foi encontrado (paneId não bate) → sessionState nulo.
    expect(view.orchestratorLive).toBe(false);
  });

  it('sem líder provado (A morto), snapshot não finge coordenação viva', () => {
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-1', source: 'live', proven: false,
    });
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({ mission: mission(), panes: [pane({ paneId: 'pane-1' })] }),
      missionId,
    );
    expect(view.orchestratorLive).toBe(false);
  });

  it('nunca engole split-brain silenciosamente: loga e degrada para "sem líder", não escolhe por ordem de array', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    harness.resolveMissionLeader.mockImplementation(() => {
      throw new MissionLeadershipError('split_brain', { missionId, sessionIds: ['session-1', 'session-2'] });
    });
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({ mission: mission(), panes: [pane({ paneId: 'pane-1' }), pane({ paneId: 'pane-2' })] }),
      missionId,
    );
    expect(view.orchestratorLive).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Quadro fiel ao terminal (campo 23/09)', () => {
  const fullstack = {
    id: 'nexus-fullstack',
    agents: [
      { id: 'maestro', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' },
      { id: 'frontend', agentName: 'Frontend', category: 'executor', cli: 'codex' },
      { id: 'qa', agentName: 'QA', category: 'reviewer', cli: 'claude' },
    ],
  };

  function liveOrchestrator(paneId: string, sessionId: string, overrides: Record<string, unknown> = {}) {
    harness.sessionStates.set(sessionId, 'busy');
    harness.agentSessionsByPane.set(paneId, [
      {
        sessionId,
        paneId,
        adapterId: 'claude',
        missionId,
        role: 'orchestrator',
        source: 'persisted-pane',
        scope,
        ...overrides,
      },
    ]);
  }

  it('missão aberta pelo pane do operador (sem plano) não desenha o squad inteiro como "Na fila"', () => {
    harness.squads.set(fullstack.id, fullstack);
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-orq', source: 'durable', proven: true,
    });
    harness.sessionStates.set('session-1', 'busy');
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission({ squadId: fullstack.id, intentContract: undefined, intentVersion: 0 }),
        panes: [pane({ paneId: 'pane-orq' })],
      }),
      missionId,
    );

    // Ninguém vai abrir Frontend nem QA: o operador solta os panes que quiser.
    expect(view.roster.map((agent) => agent.id)).toEqual(['maestro']);
  });

  it('missão com plano continua mostrando a equipe planejada', () => {
    harness.squads.set(fullstack.id, fullstack);
    harness.resolveMissionLeader.mockReturnValue(null);
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission({
          squadId: fullstack.id,
          intentContract: { goal: 'Entregar', intentVersion: 1 } as Mission['intentContract'],
        }),
        panes: [],
      }),
      missionId,
    );

    expect(view.roster.map((agent) => agent.id)).toEqual(['maestro', 'frontend', 'qa']);
  });

  it('orquestrador reiniciado em outra CLI: o card mostra o pane vivo e o cabeçalho explica — sem fingir liderança', () => {
    harness.squads.set(fullstack.id, fullstack);
    // Sessão durável morreu no failover Claude → GLM; o pane voltou com
    // autoridade persistida da MESMA missão, mas ninguém religou a liderança.
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'pty-claude-morto', paneId: null, source: 'durable', proven: false,
    });
    liveOrchestrator('pane-orq', 'pty-glm-vivo', { adapterId: 'glm' });
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission({ status: 'blocked', squadId: fullstack.id, intentContract: undefined, intentVersion: 0 }),
        panes: [pane({ paneId: 'pane-orq' })],
      }),
      missionId,
    );

    // Invariante da onda 1 intacta: sem líder provado, nada de coordenação viva.
    expect(view.orchestratorLive).toBe(false);
    expect(view.panes).toEqual([
      expect.objectContaining({ paneId: 'pane-orq', agentId: 'maestro', state: 'working' }),
    ]);

    const snapshot = projectMissionSnapshot(view);
    expect(snapshot.state).toBe('blocked_technical');
    expect(snapshot.stateReason?.code).toBe('leader-drift');
    // Tentar de novo abriria um SEGUNDO orquestrador ao lado do que trabalha.
    expect(snapshot.allowedActions).toEqual(['stop']);
    expect(snapshot.agents).toEqual([
      expect.objectContaining({ id: 'maestro', state: 'working', paneId: 'pane-orq' }),
    ]);
  });

  it('pane gravado como orquestrador mas rodando outra coisa não vira o Maestro', () => {
    harness.squads.set(fullstack.id, fullstack);
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'pty-claude-morto', paneId: null, source: 'durable', proven: false,
    });
    // Operador reaproveitou o pane: sessão sem a missão / de outra missão.
    liveOrchestrator('pane-orq', 'pty-outro', { missionId: 'mission-outra' });
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission({ status: 'blocked', squadId: fullstack.id }),
        panes: [pane({ paneId: 'pane-orq' })],
      }),
      missionId,
    );

    expect(view.panes).toEqual([]);
    expect(projectMissionSnapshot(view).stateReason?.code).toBe('mission-blocked');
  });

  it('com líder provado, um orquestrador vivo em outro pane nunca rouba o card', () => {
    harness.squads.set(fullstack.id, fullstack);
    harness.sessionStates.set('session-1', 'idle');
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'session-1', paneId: 'pane-1', source: 'durable', proven: true,
    });
    liveOrchestrator('pane-orfao', 'pty-orfao');
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission({ squadId: fullstack.id }),
        panes: [pane({ paneId: 'pane-1' }), pane({ paneId: 'pane-orfao' })],
      }),
      missionId,
    );

    expect(view.panes.map((entry) => entry.paneId)).toEqual(['pane-1']);
    expect(projectMissionSnapshot(view).stateReason?.code).not.toBe('leader-drift');
  });
});

describe('missão da aba (sem squad): o quadro desenha os panes que a missão gravou', () => {
  it.each([
    ['working', 'exited'], ['working', null],
    ['awaiting-input', 'exited'], ['awaiting-input', null],
    ['error', 'exited'], ['error', null],
  ] as const)('F-952: stale %s hook does not revive a durable pane with transport %s', (semantic, transport) => {
    harness.resolveMissionLeader.mockReturnValue(null);
    if (transport) harness.sessionStates.set('s-worker', transport);
    harness.semanticByPane.set('pane-worker', semantic);
    harness.paneSnapshots = [{ paneId: 'pane-worker', sessionId: 's-worker' }];
    const view = projectMissionEngineSnapshotView(scope, stores({
      mission: mission(), panes: [pane({ paneId: 'pane-worker', role: 'worker', adapterId: 'codex' })],
    }), missionId);
    expect(view.panes[0]).toMatchObject({ terminalLive: false, state: 'queued' });
    const agent = projectMissionSnapshot(view).agents[0]!;
    expect(agent).toMatchObject({ terminalLive: false, state: 'queued' });
    expect(agent).not.toHaveProperty('paneId');
  });

  it('F-952: current semantic working survives a live idle transport', () => {
    harness.resolveMissionLeader.mockReturnValue(null);
    harness.sessionStates.set('s-worker', 'idle');
    harness.semanticByPane.set('pane-worker', 'working');
    harness.paneSnapshots = [{ paneId: 'pane-worker', sessionId: 's-worker' }];
    const view = projectMissionEngineSnapshotView(scope, stores({
      mission: mission(), panes: [pane({ paneId: 'pane-worker', role: 'worker', adapterId: 'codex' })],
    }), missionId);
    expect(view.panes[0]).toMatchObject({ terminalLive: true, state: 'working' });
    expect(projectMissionSnapshot(view).agents[0]).toMatchObject({ terminalLive: true, state: 'working', paneId: 'pane-worker' });
  });

  it.each(['busy', 'spawning', 'idle', 'exited', null])('distingue terminal físico %s de um pane durável antigo', (sessionState) => {
    harness.resolveMissionLeader.mockReturnValue(null);
    if (sessionState) harness.sessionStates.set('s-worker', sessionState);
    harness.paneSnapshots = [{ paneId: 'pane-worker', sessionId: 's-worker' }];
    const view = projectMissionEngineSnapshotView(scope, stores({
      mission: mission(),
      panes: [pane({ paneId: 'pane-worker', role: 'worker', adapterId: 'codex' })],
    }), missionId);
    const live = ['busy', 'spawning', 'idle'].includes(sessionState ?? '');
    expect(view.panes[0]).toHaveProperty('terminalLive', live);
    const agent = projectMissionSnapshot(view).agents[0]!;
    expect(agent).toHaveProperty('terminalLive', live);
    if (live) expect(agent.paneId).toBe('pane-worker');
    else expect(agent).not.toHaveProperty('paneId');
  });

  function liveOrchestrator(paneId: string, sessionId: string, overrides: Record<string, unknown> = {}) {
    harness.sessionStates.set(sessionId, 'busy');
    harness.agentSessionsByPane.set(paneId, [
      {
        sessionId,
        paneId,
        adapterId: 'claude',
        missionId,
        role: 'orchestrator',
        source: 'persisted-pane',
        scope,
        ...overrides,
      },
    ]);
  }

  it('líder provado + dois helpers com o MESMO agentName → orquestrador + um executor por paneId', () => {
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 's-orch', paneId: 'pane-orch', source: 'durable', proven: true,
    });
    for (const sessionId of ['s-orch', 's-w1', 's-w2']) {
      harness.sessionStates.set(sessionId, 'busy');
    }
    harness.paneSnapshots = [
      { paneId: 'pane-orch', sessionId: 's-orch' },
      { paneId: 'pane-w1', sessionId: 's-w1' },
      { paneId: 'pane-w2', sessionId: 's-w2' },
    ];
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission(),
        panes: [
          pane({ paneId: 'pane-orch', role: 'orchestrator', agentName: 'Maestro', adapterId: 'claude' }),
          pane({ paneId: 'pane-w1', role: 'worker', agentName: 'Auxiliar', adapterId: 'codex' }),
          pane({ paneId: 'pane-w2', role: 'worker', agentName: 'Auxiliar', adapterId: 'glm' }),
        ],
      }),
      missionId,
    );

    // Helpers com nomes iguais NÃO se sobrepõem: a identidade é o paneId.
    expect(view.panes).toEqual([
      expect.objectContaining({ paneId: 'pane-w2', agentId: 'pane:pane-w2' }),
      expect.objectContaining({ paneId: 'pane-w1', agentId: 'pane:pane-w1' }),
      expect.objectContaining({ paneId: 'pane-orch', agentId: 'orchestrator' }),
    ]);

    const snapshot = projectMissionSnapshot(view);
    expect(snapshot.agents).toEqual([
      expect.objectContaining({
        id: 'orchestrator',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'claude',
        paneId: 'pane-orch',
        state: 'working',
      }),
      expect.objectContaining({
        id: 'pane:pane-w2',
        agentName: 'Auxiliar',
        category: 'executor',
        cli: 'glm',
        paneId: 'pane-w2',
        state: 'working',
      }),
      expect.objectContaining({
        id: 'pane:pane-w1',
        agentName: 'Auxiliar',
        category: 'executor',
        cli: 'codex',
        paneId: 'pane-w1',
        state: 'working',
      }),
    ]);
  });

  it('líder à deriva sem squad: o card do orquestrador usa o pane à deriva', () => {
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 'pty-dead', paneId: null, source: 'durable', proven: false,
    });
    liveOrchestrator('pane-orq', 'pty-live');
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission({ status: 'blocked' }),
        panes: [pane({ paneId: 'pane-orq', agentName: 'Maestro' })],
      }),
      missionId,
    );

    expect(view.orchestratorDrift).toBe(true);
    expect(view.panes).toEqual([
      expect.objectContaining({ paneId: 'pane-orq', agentId: 'orchestrator', state: 'working' }),
    ]);

    const snapshot = projectMissionSnapshot(view);
    expect(snapshot.stateReason?.code).toBe('leader-drift');
    expect(snapshot.agents).toEqual([
      expect.objectContaining({ id: 'orchestrator', paneId: 'pane-orq', state: 'working' }),
    ]);
  });

  it('missão sem squad e sem panes → sem agentes (o quadro mostra o vazio honesto)', () => {
    harness.resolveMissionLeader.mockReturnValue(null);
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({ mission: mission(), panes: [] }),
      missionId,
    );

    expect(view.roster).toEqual([]);
    expect(view.panes).toEqual([]);
    expect(projectMissionSnapshot(view).agents).toEqual([]);
  });
});

describe('F-198: líder provado ocioso no prompt é vivo — Aguardando, nunca Dormindo', () => {
  it('sessão idle do líder provado: orquestrador vivo e ocioso, missão running com direct', () => {
    const now = Date.now();
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 's-orch', paneId: 'pane-orch', source: 'durable', proven: true,
    });
    harness.sessionStates.set('s-orch', 'idle');
    harness.paneSnapshots = [{ paneId: 'pane-orch', sessionId: 's-orch' }];

    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission({ createdAt: now, updatedAt: now }),
        panes: [pane({ paneId: 'pane-orch', role: 'orchestrator', agentName: 'Maestro' })],
      }),
      missionId,
    );

    expect(view.orchestratorLive).toBe(true);
    expect(view.orchestratorIdle).toBe(true);
    const snapshot = projectMissionSnapshot(view);
    expect(snapshot.state).toBe('running');
    expect(snapshot.stateReason?.code).toBe('awaiting-instruction');
    expect(snapshot.allowedActions).toEqual(['direct', 'stop']);
  });

  it('Maestro ocioso com worker ocupado: running sem o motivo — a missão trabalha', () => {
    const now = Date.now();
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 's-orch', paneId: 'pane-orch', source: 'durable', proven: true,
    });
    harness.sessionStates.set('s-orch', 'idle');
    harness.sessionStates.set('s-w1', 'busy');
    harness.paneSnapshots = [
      { paneId: 'pane-orch', sessionId: 's-orch' },
      { paneId: 'pane-w1', sessionId: 's-w1' },
    ];

    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission({ createdAt: now, updatedAt: now }),
        panes: [
          pane({ paneId: 'pane-orch', role: 'orchestrator', agentName: 'Maestro' }),
          pane({ paneId: 'pane-w1', role: 'worker', agentName: 'Auxiliar', adapterId: 'codex' }),
        ],
      }),
      missionId,
    );

    expect(view.orchestratorIdle).toBe(true);
    const snapshot = projectMissionSnapshot(view);
    expect(snapshot.state).toBe('running');
    expect(snapshot.stateReason).toBeUndefined();
  });

  it('líder provado sem sessão viva continua session-dead — idle não vira carta branca', () => {
    const now = Date.now();
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 's-orch', paneId: 'pane-orch', source: 'durable', proven: true,
    });
    harness.paneSnapshots = [{ paneId: 'pane-orch', sessionId: 's-orch' }];

    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission({ createdAt: now, updatedAt: now }),
        panes: [pane({ paneId: 'pane-orch', role: 'orchestrator' })],
      }),
      missionId,
    );

    expect(view.orchestratorLive).toBe(false);
    expect(view.orchestratorIdle).toBeUndefined();
    const snapshot = projectMissionSnapshot(view);
    expect(snapshot.state).toBe('blocked_technical');
    expect(snapshot.stateReason?.code).toBe('session-dead');
  });
});
