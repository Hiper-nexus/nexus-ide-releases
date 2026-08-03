import { describe, expect, it, vi } from 'vitest';
import type {
  Mission,
  MissionMilestone,
  MissionPaneSpec,
  PaneSnapshot,
} from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  actionableMissionPanes,
  createProductionApplyPorts,
  findDeadMissionPane,
  hasMirroredScope,
  snapshotsForScope,
} from './mission-driver-io';
import type { PrevcAdvancePort } from './mission-driver-prevc';
import {
  missionHasSchedulerProgress as schedulerOwnsMissionProgress,
} from './mission-scheduler-authority';

const milestoneEvidence1 = `milestone:${'1'.repeat(64)}`;
const milestoneEvidence2 = `milestone:${'2'.repeat(64)}`;

function finalStepAuthority(evidenceId = milestoneEvidence1) {
  return () => ({ workflowRevision: 7, evidenceId });
}

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

  it('binds the terminal PREVC handoff, advances, then marks the step done', () => {
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
            fromAgent: 'nexus-prevc-autopilot',
            evidenceTrust: 'nexus-trusted' as const,
            evidenceIds: [milestoneEvidence1],
            evidenceBinding: {
              missionId: mission.id,
              workflowRevision: 7,
            },
            status: 'success' as const,
            createdAt: 10,
          },
        ],
        submit: vi.fn(),
      },
    }) as never, undefined, undefined, finalStepAuthority());

    ports.advanceStep('mission-a', scope, 's1');

    expect(prevcAdvance).toHaveBeenCalledWith(
      'mission-a',
      scope,
      's1',
      [milestoneEvidence1],
    );
    expect(mission.milestones[0]?.status).toBe('done');
    expect(mission.milestones[0]?.evidenceIds).toEqual([
      milestoneEvidence1,
    ]);
  });

  it('rejects current Nexus evidence from any non-PREVC handoff', () => {
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
          missions: { get: () => mission },
          handoffs: {
            list: () => [
              {
                fromAgent: 'worker-claimed-prevc',
                evidenceTrust: 'nexus-trusted',
                evidenceIds: [milestoneEvidence1],
                evidenceBinding: {
                  missionId: mission.id,
                  workflowRevision: 7,
                },
                status: 'success',
                createdAt: 10,
              },
            ],
          },
        }) as never,
      undefined,
      undefined,
      finalStepAuthority(),
    );

    expect(() => ports.advanceStep(mission.id, scope, 's1')).toThrow(
      /lacks nexus-trusted evidence/,
    );
    expect(prevcAdvance).not.toHaveBeenCalled();
  });

  it('rejects a physical worker spoofing the reserved PREVC agent label', () => {
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
          missions: { get: () => mission },
          handoffs: {
            list: () => [
              {
                fromAgent: 'nexus-prevc-autopilot',
                sessionId: 'worker-session',
                workerIncarnationId: 'worker-incarnation',
                mcpProvenance: { receiptId: 'physical-tool-call' },
                evidenceTrust: 'nexus-trusted',
                evidenceIds: [milestoneEvidence1],
                evidenceBinding: {
                  missionId: mission.id,
                  workflowRevision: 7,
                },
                status: 'success',
                createdAt: 10,
              },
            ],
          },
        }) as never,
      undefined,
      undefined,
      finalStepAuthority(),
    );

    expect(() => ports.advanceStep(mission.id, scope, 's1')).toThrow(
      /lacks nexus-trusted evidence/,
    );
    expect(prevcAdvance).not.toHaveBeenCalled();
  });

  it('rejects a final PREVC handoff from an older workflow revision', () => {
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
          missions: { get: () => mission },
          handoffs: {
            list: () => [
              {
                fromAgent: 'nexus-prevc-autopilot',
                evidenceTrust: 'nexus-trusted',
                evidenceIds: [milestoneEvidence1],
                evidenceBinding: {
                  missionId: mission.id,
                  workflowRevision: 6,
                },
                status: 'success',
                createdAt: 10,
              },
            ],
          },
        }) as never,
      undefined,
      undefined,
      finalStepAuthority(),
    );

    expect(() => ports.advanceStep(mission.id, scope, 's1')).toThrow(
      /lacks nexus-trusted evidence/,
    );
    expect(prevcAdvance).not.toHaveBeenCalled();
  });

  it('rejects the dedicated PREVC handoff before the sealed plan is terminal', () => {
    const mission = makeMission([
      step({ id: 's1', label: 'Design', status: 'in-progress' }),
    ]);
    const listHandoffs = vi.fn(() => [
      {
        fromAgent: 'nexus-prevc-autopilot',
        evidenceTrust: 'nexus-trusted',
        evidenceIds: [milestoneEvidence1],
        evidenceBinding: {
          missionId: mission.id,
          workflowRevision: 7,
        },
        status: 'success',
        createdAt: 10,
      },
    ]);
    const prevcAdvance = vi.fn();
    const hasFinalAuthority = vi.fn(() => null);
    const ports = createProductionApplyPorts(
      {
        advanceMissionStep: prevcAdvance,
        isMissionComplete: () => true,
      },
      () =>
        ({
          missions: { get: () => mission },
          handoffs: { list: listHandoffs },
        }) as never,
      undefined,
      undefined,
      hasFinalAuthority,
    );

    expect(() => ports.advanceStep(mission.id, scope, 's1')).toThrow(
      /lacks nexus-trusted evidence/,
    );
    expect(hasFinalAuthority).toHaveBeenCalledWith(scope, mission.id, 's1');
    expect(listHandoffs).not.toHaveBeenCalled();
    expect(prevcAdvance).not.toHaveBeenCalled();
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
            fromAgent: 'nexus-prevc-autopilot',
            evidenceTrust: 'nexus-trusted' as const,
            evidenceIds: [milestoneEvidence1],
            evidenceBinding: {
              missionId: mission.id,
              workflowRevision: 7,
            },
            status: 'success' as const,
            createdAt: 10,
          },
        ],
        submit: vi.fn(),
      },
    }) as never, undefined, undefined, finalStepAuthority());

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
        evidenceIds: [milestoneEvidence1],
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
                fromAgent: 'nexus-prevc-autopilot',
                evidenceTrust: 'nexus-trusted',
                evidenceIds: [milestoneEvidence1],
                evidenceBinding: {
                  missionId: mission.id,
                  workflowRevision: 7,
                },
                status: 'success',
                createdAt: 10,
              },
            ],
            submit: vi.fn(),
          },
        }) as never,
      undefined,
      undefined,
      finalStepAuthority(),
    );

    expect(() => ports.advanceStep('mission-a', scope, 's2')).toThrow(
      /nexus-trusted/,
    );
    expect(prevcAdvance).not.toHaveBeenCalled();
  });

  it('selects the exact step attestation instead of the first handoff id', () => {
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
            fromAgent: 'nexus-prevc-autopilot',
            evidenceTrust: 'nexus-trusted',
            evidenceIds: [milestoneEvidence1, milestoneEvidence2],
            evidenceBinding: {
              missionId: mission.id,
              workflowRevision: 7,
            },
            status: 'success',
            createdAt: 10,
          }],
          submit: vi.fn(),
        },
      }) as never,
      undefined,
      undefined,
      finalStepAuthority(milestoneEvidence2),
    );

    expect(() => ports.advanceStep('mission-a', scope, 's1')).toThrow(
      /remains non-done/,
    );
    expect(prevcAdvance).toHaveBeenCalledWith(
      'mission-a',
      scope,
      's1',
      [milestoneEvidence2],
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
      undefined,
      undefined,
      finalStepAuthority(),
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

  it('complete atomically closes mission status and intent after PREVC proof', () => {
    let mission = makeMission([
      step({
        id: 's1',
        label: 'Design',
        status: 'done',
        evidenceIds: ['ev-1'],
      }),
    ], { intentState: 'executing', intentVersion: 1 });
    const completeFromMissionDriver = vi.fn(
      (
        id: string,
        expectation: {
          expectedUpdatedAt: number;
          expectedIntentVersion: number;
        },
      ) => {
        if (
          id !== mission.id ||
          expectation.expectedUpdatedAt !== mission.updatedAt ||
          expectation.expectedIntentVersion !== mission.intentVersion
        ) {
          return null;
        }
        mission = {
          ...mission,
          status: 'done',
          intentState: 'done',
          updatedAt: mission.updatedAt + 1,
        };
        return mission;
      },
    );
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
            setStatus: vi.fn(),
            completeFromMissionDriver,
            appendLearning: () => mission,
            list: () => [mission],
            create: () => mission,
          },
          handoffs: { list: () => [], submit: vi.fn() },
        }) as never,
    );

    ports.completeMission('mission-a', scope);
    expect(mission.status).toBe('done');
    expect(mission.intentState).toBe('done');
    expect(completeFromMissionDriver).toHaveBeenCalledWith('mission-a', {
      expectedUpdatedAt: 1,
      expectedIntentVersion: 1,
    });
  });

  it('complete fails closed when the terminal CAS loses authority', () => {
    const mission = makeMission(
      [
        step({
          id: 's1',
          label: 'Design',
          status: 'done',
          evidenceIds: ['ev-1'],
        }),
      ],
      { intentState: 'validating', intentVersion: 2 },
    );
    const completeFromMissionDriver = vi.fn(() => null);
    const ports = createProductionApplyPorts(
      {
        advanceMissionStep: vi.fn(),
        isMissionComplete: () => true,
      },
      () =>
        ({
          missions: {
            get: () => mission,
            completeFromMissionDriver,
          },
          handoffs: { list: () => [], submit: vi.fn() },
        }) as never,
    );

    expect(() => ports.completeMission('mission-a', scope)).toThrow(
      /completion CAS changed/i,
    );
    expect(completeFromMissionDriver).toHaveBeenCalledWith('mission-a', {
      expectedUpdatedAt: 1,
      expectedIntentVersion: 2,
    });
    expect(mission).toMatchObject({
      status: 'running',
      intentState: 'validating',
    });
  });

  it('never exposes worker panes to mission-driver recovery', () => {
    const orchestrator: MissionPaneSpec = {
      id: 'spec-orch', missionId: 'mission-a', paneId: 'pane-orch',
      adapterId: 'codex', title: 'Orchestrator', role: 'orchestrator', createdAt: 1,
    };
    const worker: MissionPaneSpec = {
      id: 'spec-worker', missionId: 'mission-a', paneId: 'pane-worker',
      adapterId: 'codex', title: 'Worker', role: 'worker', createdAt: 2,
      workerIncarnationId: 'incarnation-1',
    };
    const liveOrchestratorOnly: PaneSnapshot[] = [{
      paneId: 'pane-orch', sessionId: 'session-orch', title: 'Orchestrator',
      kind: 'cli-agent', state: 'idle', missionId: 'mission-a', role: 'orchestrator',
    }];

    const actionable = actionableMissionPanes([orchestrator, worker]);
    expect(actionable).toEqual([orchestrator]);
    expect(
      findDeadMissionPane('mission-a', actionable, liveOrchestratorOnly),
    ).toBeNull();
  });

  it('keeps orchestrators recoverable but excludes legacy workers too', () => {
    const orchestrator: MissionPaneSpec = {
      id: 'spec-orch', missionId: 'mission-a', paneId: 'pane-orch',
      adapterId: 'codex', title: 'Orchestrator', role: 'orchestrator', createdAt: 1,
    };
    const legacyWorker: MissionPaneSpec = {
      id: 'spec-worker', missionId: 'mission-a', paneId: 'pane-worker',
      adapterId: 'codex', title: 'Worker', role: 'worker', createdAt: 2,
    };

    expect(actionableMissionPanes([orchestrator, legacyWorker])).toEqual([
      orchestrator,
    ]);
    expect(actionableMissionPanes([orchestrator])).toEqual([orchestrator]);
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

  it('recovers only the orchestrator and records success after renderer ACK', async () => {
    let mission = makeMission(
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
    const rebindOrchestratorSession = vi.fn(
      (_missionId: string, sessionId: string) => {
        mission = { ...mission, orchestratorSessionId: sessionId };
        return mission;
      },
    );
    const recoverPane = vi.fn(async () => ({
      requestId: 'recovery-a',
      ok: true as const,
      paneId: 'pane-orch',
      sessionId: 'session-orch-new',
    }));
    const ports = createProductionApplyPorts(
      { advanceMissionStep: vi.fn(), isMissionComplete: () => false },
      () => ({
        missions: {
          get: () => mission,
          appendLearning,
          rebindOrchestratorSession,
          hasCurrentKickoffAcceptance: () => true,
        },
        missionPanes: { list: () => persisted },
        taskDispatches: { list: () => [] },
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

    await ports.respawnFreshContext(mission.id, scope, 'context rot');

    expect(recoverPane).toHaveBeenCalledWith(expect.objectContaining({
      missionId: mission.id,
      paneId: 'pane-orch',
      role: 'orchestrator',
      expectedSessionId: 'session-orch',
      pane: expect.objectContaining({ title: 'Orchestrator' }),
      recap: expect.stringMatching(/Memória compacta[\s\S]*Codex[\s\S]*API integrada/),
    }));
    expect(rebindOrchestratorSession).toHaveBeenCalledWith(
      mission.id,
      'session-orch-new',
    );
    expect(appendLearning).toHaveBeenCalledWith(
      mission.id,
      expect.stringContaining('session-orch-new'),
    );
  });

  it('blocks a dead orchestrator without asking the renderer to respawn it', async () => {
    let mission = makeMission(
      [step({ id: 's1', label: 'Validar entrega', status: 'pending' })],
      {
        orchestratorSessionId: 'session-orch-dead',
        description: 'Concluir a missão com prova real.',
      },
    );
    const persisted: MissionPaneSpec[] = [
      {
        id: 'spec-orch',
        missionId: mission.id,
        paneId: 'pane-orch-dead',
        adapterId: 'codex',
        title: 'Orchestrator',
        role: 'orchestrator',
        createdAt: 1,
      },
    ];
    const update = vi.fn((_missionId: string, patch: Record<string, unknown>) => {
      mission = { ...mission, ...patch } as typeof mission;
      return mission;
    });
    const recoverPane = vi.fn();
    const ports = createProductionApplyPorts(
      { advanceMissionStep: vi.fn(), isMissionComplete: () => false },
      () => ({
        missions: {
          get: () => mission,
          update,
          appendLearning: vi.fn(),
          hasCurrentKickoffAcceptance: () => true,
        },
        missionPanes: { list: () => persisted },
        taskDispatches: { list: () => [] },
        handoffs: { list: () => [] },
      }) as never,
      recoverPane,
      () => [{
        paneId: 'pane-orch-dead',
        sessionId: 'session-orch-dead',
        title: 'Orchestrator',
        kind: 'cli-agent',
        state: 'exited',
        missionId: mission.id,
        role: 'orchestrator',
      }],
    );

    await expect(
      ports.respawnFreshContext(mission.id, scope, 'provider exited'),
    ).rejects.toThrow(/blocked.*Retomar missão/i);
    await expect(
      ports.respawnFreshContext(mission.id, scope, 'provider exited again'),
    ).rejects.toThrow(/blocked.*Retomar missão/i);

    expect(recoverPane).not.toHaveBeenCalled();
    expect(update).toHaveBeenLastCalledWith(
      mission.id,
      expect.objectContaining({
        status: 'blocked',
        intentState: 'blocked_technical',
        description: expect.stringMatching(
          /NEXUS_DEAD_ORCHESTRATOR_RECOVERY_BLOCKED[\s\S]*Retomar missão/,
        ),
      }),
    );
    expect(
      mission.description.match(
        /\[NEXUS_DEAD_ORCHESTRATOR_RECOVERY_BLOCKED\]/g,
      ),
    ).toHaveLength(1);
    expect(mission.description.match(/CTA: Retomar missão/g)).toHaveLength(1);
  });

  it('recovers a dead Maestro after scheduler-owned durable progress', async () => {
    let mission = makeMission([], {
      orchestratorSessionId: 'session-orch-dead',
      intentVersion: 7,
      description: 'Missão com workers em curso.',
    });
    const persisted: MissionPaneSpec[] = [
      {
        id: 'spec-orch',
        missionId: mission.id,
        paneId: 'pane-orch-dead',
        adapterId: 'claude',
        title: 'Orchestrator',
        role: 'orchestrator',
        createdAt: 1,
      },
    ];
    const rebindOrchestratorSession = vi.fn(
      (_missionId: string, sessionId: string) => {
        mission = { ...mission, orchestratorSessionId: sessionId };
        return mission;
      },
    );
    const recoverPane = vi.fn(async () => ({
      requestId: 'recovery-dead',
      ok: true as const,
      paneId: 'pane-orch-dead',
      sessionId: 'session-orch-recovered',
    }));
    const ports = createProductionApplyPorts(
      { advanceMissionStep: vi.fn(), isMissionComplete: () => false },
      () => ({
        missions: {
          get: () => mission,
          rebindOrchestratorSession,
          appendLearning: vi.fn(),
          hasCurrentKickoffAcceptance: () => true,
          update: vi.fn(),
        },
        missionPanes: { list: () => persisted },
        taskDispatches: {
          list: () => [
            {
              missionId: mission.id,
              intentVersion: 7,
              state: 'running',
            },
          ],
        },
        handoffs: {
          list: () => [
            {
              id: 'handoff-queued',
              missionId: mission.id,
              status: 'success',
              authorityOrigin: 'agent',
              deliveryState: 'queued',
              delivered: false,
              summary: 'revisão pronta',
              artifacts: [],
              evidenceIds: [],
              evidenceTrust: 'unverified',
              createdAt: 10,
            },
          ],
        },
      }) as never,
      recoverPane,
      () => [{
        paneId: 'pane-orch-dead',
        sessionId: 'session-orch-dead',
        title: 'Orchestrator',
        kind: 'cli-agent',
        state: 'exited',
        missionId: mission.id,
        role: 'orchestrator',
      }],
    );

    await ports.respawnFreshContext(
      mission.id,
      scope,
      'provider exited mid-delivery',
    );

    expect(recoverPane).toHaveBeenCalled();
    expect(rebindOrchestratorSession).toHaveBeenCalledWith(
      mission.id,
      'session-orch-recovered',
    );
    expect(mission.orchestratorSessionId).toBe('session-orch-recovered');
  });
});

describe('scheduler-owned mission progress', () => {
  it('keeps a dead Maestro advisory after current kickoff dispatched durable work', () => {
    const mission = makeMission([], {
      orchestratorSessionId: 'orchestrator-current',
      intentVersion: 7,
    });

    expect(
      schedulerOwnsMissionProgress(mission, true, [
        {
          missionId: mission.id,
          intentVersion: 7,
          state: 'running',
        },
      ]),
    ).toBe(true);
  });

  it('keeps orchestrator death fail-closed before the first durable dispatch', () => {
    const mission = makeMission([], {
      orchestratorSessionId: 'orchestrator-current',
      intentVersion: 7,
    });

    expect(schedulerOwnsMissionProgress(mission, true, [])).toBe(false);
  });

  it.each([
    {
      name: 'sem kickoff atual',
      kickoffAccepted: false,
      intentVersion: 7,
      state: 'running' as const,
    },
    {
      name: 'dispatch de intent obsoleta',
      kickoffAccepted: true,
      intentVersion: 6,
      state: 'running' as const,
    },
    {
      name: 'dispatch superseded',
      kickoffAccepted: true,
      intentVersion: 7,
      state: 'superseded' as const,
    },
  ])(
    'mantém paneDead fail-closed: $name',
    ({ kickoffAccepted, intentVersion, state }) => {
      const mission = makeMission([], {
        orchestratorSessionId: 'orchestrator-current',
        intentVersion: 7,
      });

      expect(
        schedulerOwnsMissionProgress(mission, kickoffAccepted, [
          {
            missionId: mission.id,
            intentVersion,
            state,
          },
        ]),
      ).toBe(false);
    },
  );
});
