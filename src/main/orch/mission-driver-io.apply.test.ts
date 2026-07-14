import { describe, expect, it, vi } from 'vitest';
import type {
  Mission,
  MissionMilestone,
  MissionPaneSpec,
  PaneSnapshot,
} from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  createProductionApplyPorts,
  findDeadMissionPane,
  hasMirroredScope,
  snapshotsForScope,
} from './mission-driver-io';
import type { PrevcAdvancePort } from './mission-driver-prevc';

function step(
  partial: Partial<MissionMilestone> & Pick<MissionMilestone, 'id' | 'label'>,
): MissionMilestone {
  return {
    status: 'pending',
    evidenceIds: [],
    ...partial,
  };
}

function makeMission(
  milestones: MissionMilestone[],
  overrides: Partial<Mission> = {},
): Mission {
  return {
    id: 'mission-a',
    title: 'A',
    description: '',
    status: 'running',
    milestones,
    learnings: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('createProductionApplyPorts advance/complete', () => {
  const scope = testProjectScope();

  it('binds trusted handoff evidence, calls PREVC advance, then marks step done', () => {
    let mission = makeMission([
      step({ id: 's1', label: 'Design', status: 'in-progress' }),
    ]);
    const prevcAdvance = vi.fn(
      (
        _missionId: string,
        _scope: unknown,
        stepId: string,
        evidenceIds: readonly string[],
      ) => {
        mission = {
          ...mission,
          milestones: mission.milestones.map((item) =>
            item.id === stepId
              ? { ...item, status: 'done' as const, evidenceIds: [...evidenceIds] }
              : item,
          ),
        };
      },
    );
    const prevc: PrevcAdvancePort = {
      advanceMissionStep: prevcAdvance,
      isMissionComplete: () => true,
    };
    const ports = createProductionApplyPorts(prevc, () => ({
      missions: {
        get: (id: string) => (id === mission.id ? mission : null),
        update: (_id: string, patch: { milestones?: MissionMilestone[] }) => {
          if (patch.milestones) {
            mission = { ...mission, milestones: patch.milestones };
          }
          return mission;
        },
        markMilestoneDone: (
          _id: string,
          stepId: string,
          trusted: readonly string[],
        ) => {
          // Mirror store gate: only done when evidence non-empty and trusted.
          const target = mission.milestones.find((m) => m.id === stepId);
          if (
            target &&
            target.evidenceIds.length > 0 &&
            target.evidenceIds.every((e) => trusted.includes(e))
          ) {
            mission = {
              ...mission,
              milestones: mission.milestones.map((item) =>
                item.id === stepId
                  ? { ...item, status: 'done' as const }
                  : item,
              ),
            };
          }
          return mission;
        },
        setStatus: (id: string, status: Mission['status']) => {
          if (id !== mission.id) return null;
          mission = { ...mission, status };
          return mission;
        },
        appendLearning: () => mission,
        list: () => [mission],
        create: () => mission,
      },
      handoffs: {
        list: () => [
          {
            evidenceTrust: 'nexus-trusted' as const,
            evidenceIds: ['ev-1'],
            status: 'success' as const,
            createdAt: 10,
          },
        ],
        submit: vi.fn(),
      },
    }) as never);

    ports.advanceStep('mission-a', scope, 's1');

    expect(prevcAdvance).toHaveBeenCalledWith(
      'mission-a',
      scope,
      's1',
      ['ev-1'],
    );
    expect(mission.milestones[0]?.status).toBe('done');
    expect(mission.milestones[0]?.evidenceIds).toEqual(['ev-1']);
  });

  it('PREVC failure is fail-closed and leaves the milestone non-done', () => {
    let mission = makeMission([
      step({ id: 's1', label: 'Design', status: 'in-progress' }),
    ]);
    const order: string[] = [];
    const prevc: PrevcAdvancePort = {
      advanceMissionStep: () => {
        order.push('prevc');
        throw new Error('workflow not ready for next stage');
      },
      isMissionComplete: () => true,
    };
    const ports = createProductionApplyPorts(prevc, () => ({
      missions: {
        get: () => mission,
        update: (_id: string, patch: { milestones?: MissionMilestone[] }) => {
          if (patch.milestones) {
            mission = { ...mission, milestones: patch.milestones };
          }
          return mission;
        },
        markMilestoneDone: (
          _id: string,
          stepId: string,
          trusted: readonly string[],
        ) => {
          order.push('mark-done');
          const target = mission.milestones.find((m) => m.id === stepId);
          if (
            target &&
            target.evidenceIds.length > 0 &&
            target.evidenceIds.every((e) => trusted.includes(e))
          ) {
            mission = {
              ...mission,
              milestones: mission.milestones.map((item) =>
                item.id === stepId
                  ? { ...item, status: 'done' as const }
                  : item,
              ),
            };
          }
          return mission;
        },
        setStatus: () => mission,
        appendLearning: () => {
          order.push('learn');
          return mission;
        },
        list: () => [mission],
        create: () => mission,
      },
      handoffs: {
        list: () => [
          {
            evidenceTrust: 'nexus-trusted' as const,
            evidenceIds: ['ev-1'],
            status: 'success' as const,
            createdAt: 10,
          },
        ],
        submit: vi.fn(),
      },
    }) as never);

    expect(() => ports.advanceStep('mission-a', scope, 's1')).toThrow(
      /workflow not ready/,
    );
    expect(order).toEqual(['prevc']);
    expect(mission.milestones[0]?.status).toBe('in-progress');
    expect(mission.milestones[0]?.evidenceIds).toEqual([]);
  });

  it('does not attach evidence already used by a done step', () => {
    let mission = makeMission([
      step({
        id: 's1',
        label: 'Done',
        status: 'done',
        evidenceIds: ['ev-1'],
      }),
      step({ id: 's2', label: 'Next', status: 'in-progress' }),
    ]);
    const prevcAdvance = vi.fn();
    const ports = createProductionApplyPorts(
      {
        advanceMissionStep: prevcAdvance,
        isMissionComplete: () => true,
      },
      () =>
        ({
          missions: {
            get: () => mission,
            update: () => mission,
            markMilestoneDone: () => mission,
            setStatus: () => mission,
            appendLearning: () => mission,
            list: () => [mission],
            create: () => mission,
          },
          handoffs: {
            list: () => [
              {
                evidenceTrust: 'nexus-trusted',
                evidenceIds: ['ev-1'],
                status: 'success',
                createdAt: 10,
              },
            ],
            submit: vi.fn(),
          },
        }) as never,
    );

    expect(() => ports.advanceStep('mission-a', scope, 's2')).toThrow(
      /nexus-trusted/,
    );
    expect(prevcAdvance).not.toHaveBeenCalled();
  });

  it('reserves later trusted evidence for later mission steps', () => {
    const mission = makeMission([
      step({ id: 's1', label: 'First', status: 'in-progress' }),
      step({ id: 's2', label: 'Second', status: 'pending' }),
    ]);
    const prevcAdvance = vi.fn();
    const ports = createProductionApplyPorts(
      {
        advanceMissionStep: prevcAdvance,
        isMissionComplete: () => false,
      },
      () => ({
        missions: {
          get: () => mission,
          update: () => mission,
          markMilestoneDone: () => mission,
          setStatus: () => mission,
          appendLearning: () => mission,
          list: () => [mission],
          create: () => mission,
        },
        handoffs: {
          list: () => [{
            evidenceTrust: 'nexus-trusted',
            evidenceIds: ['ev-1', 'ev-2'],
            status: 'success',
            createdAt: 10,
          }],
          submit: vi.fn(),
        },
      }) as never,
    );

    expect(() => ports.advanceStep('mission-a', scope, 's1')).toThrow(
      /remains non-done/,
    );
    expect(prevcAdvance).toHaveBeenCalledWith(
      'mission-a',
      scope,
      's1',
      ['ev-1'],
    );
  });

  it('rejects advance when no nexus-trusted evidence exists', async () => {
    const mission = makeMission([
      step({ id: 's1', label: 'Design', status: 'in-progress' }),
    ]);
    const prevcAdvance = vi.fn();
    const ports = createProductionApplyPorts(
      {
        advanceMissionStep: prevcAdvance,
        isMissionComplete: () => true,
      },
      () =>
        ({
          missions: {
            get: () => mission,
            update: () => mission,
            markMilestoneDone: () => mission,
            setStatus: () => mission,
            appendLearning: () => mission,
            list: () => [mission],
            create: () => mission,
          },
          handoffs: {
            list: () => [
              {
                evidenceTrust: 'unverified',
                evidenceIds: ['ev-untrusted'],
                status: 'success',
                createdAt: 10,
              },
            ],
            submit: vi.fn(),
          },
        }) as never,
    );

    expect(() => ports.advanceStep('mission-a', scope, 's1')).toThrow(
      /nexus-trusted/,
    );
    expect(prevcAdvance).not.toHaveBeenCalled();
  });

  it('complete refuses when PREVC workflow is not complete', () => {
    let mission = makeMission([
      step({
        id: 's1',
        label: 'Design',
        status: 'done',
        evidenceIds: ['ev-1'],
      }),
    ]);
    const prevcAdvance = vi.fn();
    const ports = createProductionApplyPorts(
      {
        advanceMissionStep: prevcAdvance,
        isMissionComplete: () => false,
      },
      () =>
        ({
          missions: {
            get: () => mission,
            update: () => mission,
            markMilestoneDone: () => mission,
            setStatus: (_id: string, status: Mission['status']) => {
              mission = { ...mission, status };
              return mission;
            },
            appendLearning: () => mission,
            list: () => [mission],
            create: () => mission,
          },
          handoffs: { list: () => [], submit: vi.fn() },
        }) as never,
    );

    expect(() => ports.completeMission('mission-a', scope)).toThrow(
      /workflow or step receipts incomplete/,
    );
    expect(prevcAdvance).not.toHaveBeenCalled();
    expect(mission.status).toBe('running');
  });

  it('complete succeeds when steps done and PREVC complete/absent', () => {
    let mission = makeMission([
      step({
        id: 's1',
        label: 'Design',
        status: 'done',
        evidenceIds: ['ev-1'],
      }),
    ]);
    const ports = createProductionApplyPorts(
      {
        advanceMissionStep: vi.fn(),
        isMissionComplete: () => true,
      },
      () =>
        ({
          missions: {
            get: () => mission,
            update: () => mission,
            markMilestoneDone: () => mission,
            setStatus: (_id: string, status: Mission['status']) => {
              mission = { ...mission, status };
              return mission;
            },
            appendLearning: () => mission,
            list: () => [mission],
            create: () => mission,
          },
          handoffs: { list: () => [], submit: vi.fn() },
        }) as never,
    );

    ports.completeMission('mission-a', scope);
    expect(mission.status).toBe('done');
  });

  it('treats a missing persisted worker as dead by stable pane identity', () => {
    const persisted: MissionPaneSpec[] = [
      {
        id: 'spec-orch', missionId: 'mission-a', paneId: 'pane-orch',
        adapterId: 'codex', title: 'Orchestrator', role: 'orchestrator', createdAt: 1,
      },
      {
        id: 'spec-worker', missionId: 'mission-a', paneId: 'pane-worker',
        adapterId: 'claude', title: 'Worker', role: 'worker', createdAt: 2,
      },
    ];
    const snapshots: PaneSnapshot[] = [{
      paneId: 'pane-orch', sessionId: 'session-orch', title: 'Orchestrator',
      kind: 'cli-agent', state: 'idle', missionId: 'mission-a', role: 'orchestrator',
    }];

    expect(findDeadMissionPane('mission-a', persisted, snapshots))
      .toMatchObject({ paneId: 'pane-worker', role: 'worker' });
  });

  it('does not recover panes for an inactive workspace just because another scope is mirrored', () => {
    const scopeA = testProjectScope({ projectId: 'project-a', checkoutId: 'a' });
    const scopeB = testProjectScope({ projectId: 'project-b', checkoutId: 'b' });
    const otherWorkspace: PaneSnapshot[] = [{
      paneId: 'shell-b', sessionId: 'session-b', title: 'Shell B',
      kind: 'shell', state: 'idle', scope: scopeB,
    }];

    expect(hasMirroredScope(scopeA, otherWorkspace)).toBe(false);
    expect(hasMirroredScope(scopeB, otherWorkspace)).toBe(true);
    expect(hasMirroredScope(scopeA, [{
      ...otherWorkspace[0],
      missionId: 'mission-a',
    }])).toBe(false);
  });

  it('ignores homonymous panes of another scope when deciding pane death', () => {
    const scopeA = testProjectScope({ projectId: 'project-a', checkoutId: 'a' });
    const scopeB = testProjectScope({ projectId: 'project-b', checkoutId: 'b' });
    const persisted: MissionPaneSpec[] = [{
      id: 'spec-worker', missionId: 'mission-a', paneId: 'pane-worker',
      adapterId: 'claude', title: 'Worker', role: 'worker', createdAt: 1,
    }];
    // Scope B runs a live pane with identical mission/pane/role ids. Without
    // scope filtering it masks the missing pane in scope A.
    const snapshots: PaneSnapshot[] = [
      {
        paneId: 'pane-worker', sessionId: 'session-b', title: 'Worker B',
        kind: 'cli-agent', state: 'idle', missionId: 'mission-a',
        role: 'worker', scope: scopeB,
      },
      {
        paneId: 'shell-a', sessionId: 'session-a', title: 'Shell A',
        kind: 'shell', state: 'idle', scope: scopeA,
      },
    ];

    const scopedA = snapshotsForScope(scopeA, snapshots);
    expect(scopedA.map((s) => s.paneId)).toEqual(['shell-a']);
    expect(findDeadMissionPane('mission-a', persisted, scopedA))
      .toMatchObject({ paneId: 'pane-worker' });
    // In scope B the homonymous pane is alive — nothing to recover there.
    const scopedB = snapshotsForScope(scopeB, snapshots);
    expect(findDeadMissionPane('mission-a', persisted, scopedB)).toBeNull();
  });

  it('keeps snapshots with unknown scope to avoid fabricating dead panes', () => {
    const scopeA = testProjectScope({ projectId: 'project-a', checkoutId: 'a' });
    const persisted: MissionPaneSpec[] = [{
      id: 'spec-worker', missionId: 'mission-a', paneId: 'pane-worker',
      adapterId: 'claude', title: 'Worker', role: 'worker', createdAt: 1,
    }];
    const unknownScope: PaneSnapshot[] = [{
      paneId: 'pane-worker', sessionId: 'session-x', title: 'Worker',
      kind: 'cli-agent', state: 'idle', missionId: 'mission-a', role: 'worker',
    }];

    const scoped = snapshotsForScope(scopeA, unknownScope);
    expect(scoped).toHaveLength(1);
    expect(findDeadMissionPane('mission-a', persisted, scoped)).toBeNull();
  });

  it('recovers a missing worker and records success only after renderer ACK', async () => {
    const mission = makeMission(
      [step({ id: 's1', label: 'API integrada', status: 'done' })],
      {
        orchestratorSessionId: 'session-orch',
        description: 'Finalizar a integração sem regressões',
        learnings: 'Use o adapter Codex para a revisão independente.',
      },
    );
    const persisted: MissionPaneSpec[] = [
      {
        id: 'spec-orch', missionId: mission.id, paneId: 'pane-orch',
        adapterId: 'codex', title: 'Orchestrator', role: 'orchestrator', createdAt: 1,
      },
      {
        id: 'spec-worker', missionId: mission.id, paneId: 'pane-worker',
        adapterId: 'claude', title: 'Worker', agentName: 'Builder',
        role: 'worker', createdAt: 2,
      },
    ];
    const appendLearning = vi.fn();
    const recoverPane = vi.fn(async () => ({
      requestId: 'recovery-a',
      ok: true as const,
      paneId: 'pane-worker',
      sessionId: 'session-worker-new',
    }));
    const ports = createProductionApplyPorts(
      { advanceMissionStep: vi.fn(), isMissionComplete: () => false },
      () => ({
        missions: { get: () => mission, appendLearning },
        missionPanes: { list: () => persisted },
        handoffs: {
          list: () => [
            {
              id: 'handoff-1',
              missionId: mission.id,
              status: 'success',
              summary: 'API integrada e testes unitários verdes.',
              artifacts: [],
              evidenceIds: [],
              evidenceTrust: 'unverified',
              delivered: true,
              deliveryState: 'delivered',
              createdAt: 10,
            },
          ],
        },
      }) as never,
      recoverPane,
      () => [{
        paneId: 'pane-orch', sessionId: 'session-orch', title: 'Orchestrator',
        kind: 'cli-agent', state: 'idle', missionId: mission.id,
        role: 'orchestrator',
      }],
    );

    await ports.respawnFreshContext(mission.id, scope, 'worker exited');

    expect(recoverPane).toHaveBeenCalledWith(expect.objectContaining({
      missionId: mission.id,
      paneId: 'pane-worker',
      role: 'worker',
      expectedSessionId: undefined,
      pane: expect.objectContaining({ agentName: 'Builder' }),
      recap: expect.stringMatching(/Memória compacta[\s\S]*Codex[\s\S]*API integrada/),
    }));
    expect(appendLearning).toHaveBeenCalledWith(
      mission.id,
      expect.stringContaining('session-worker-new'),
    );
  });
});
