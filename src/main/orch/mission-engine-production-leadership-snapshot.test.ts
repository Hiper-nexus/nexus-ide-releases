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
import type { Mission, MissionPaneSpec } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from './__tests__/scope-fixture';
import type { MissionLeader } from './mission-leadership';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

const harness = vi.hoisted(() => ({
  sessionStates: new Map<string, string | null>(),
  resolveMissionLeader: vi.fn<(scope: ProjectExecutionScope, missionId: string) => MissionLeader | null>(),
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: (sessionId: string) => harness.sessionStates.get(sessionId) ?? null,
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => [],
  getPaneRuntimeAuthorityBySession: () => null,
  readSessionOutput: () => '',
}));

vi.mock('./mission-leadership-runtime', () => ({
  getMissionLeadership: () => ({ resolveMissionLeader: harness.resolveMissionLeader }),
}));

import { MissionLeadershipError } from './mission-leadership';
import { projectMissionEngineSnapshotView } from './mission-engine-production';

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
}): ProjectDomainStoreSuite {
  return {
    missions: {
      get: (id: string) => (id === input.mission.id ? input.mission : null),
      hasCurrentKickoffAcceptance: () => false,
    },
    missionPanes: { list: () => input.panes },
    tasks: { list: () => [], listPlannedTasks: () => [] },
    taskDispatches: { list: () => [] },
    handoffs: { list: () => [] },
  } as unknown as ProjectDomainStoreSuite;
}

beforeEach(() => {
  harness.sessionStates = new Map();
  harness.resolveMissionLeader.mockReset();
});

describe('projectMissionEngineSnapshotView — pane/sessão do orquestrador vêm do mesmo par provado', () => {
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
