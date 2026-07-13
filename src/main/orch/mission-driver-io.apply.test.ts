import { describe, expect, it, vi } from 'vitest';
import type { Mission, MissionMilestone } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import { createProductionApplyPorts } from './mission-driver-io';
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
    const prevcAdvance = vi.fn();
    const prevc: PrevcAdvancePort = {
      advanceWorkflowStage: prevcAdvance,
      isWorkflowCompleteOrAbsent: () => true,
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

    expect(prevcAdvance).toHaveBeenCalledWith('mission-a', scope);
    expect(mission.milestones[0]?.status).toBe('done');
    expect(mission.milestones[0]?.evidenceIds).toEqual(['ev-1']);
  });

  it('marks step done before PREVC; PREVC throw still leaves step done (soft-fail)', () => {
    let mission = makeMission([
      step({ id: 's1', label: 'Design', status: 'in-progress' }),
    ]);
    const order: string[] = [];
    const prevc: PrevcAdvancePort = {
      advanceWorkflowStage: () => {
        order.push('prevc');
        throw new Error('workflow not ready for next stage');
      },
      isWorkflowCompleteOrAbsent: () => true,
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

    // Must not throw — soft-fail PREVC after step secured.
    expect(() => ports.advanceStep('mission-a', scope, 's1')).not.toThrow();
    expect(order[0]).toBe('mark-done');
    expect(order).toContain('prevc');
    expect(order).toContain('learn');
    expect(mission.milestones[0]?.status).toBe('done');
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
        advanceWorkflowStage: prevcAdvance,
        isWorkflowCompleteOrAbsent: () => true,
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

  it('rejects advance when no nexus-trusted evidence exists', async () => {
    const mission = makeMission([
      step({ id: 's1', label: 'Design', status: 'in-progress' }),
    ]);
    const prevcAdvance = vi.fn();
    const ports = createProductionApplyPorts(
      {
        advanceWorkflowStage: prevcAdvance,
        isWorkflowCompleteOrAbsent: () => true,
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
        advanceWorkflowStage: prevcAdvance,
        isWorkflowCompleteOrAbsent: () => false,
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
      /PREVC workflow not complete/,
    );
    expect(prevcAdvance).toHaveBeenCalled();
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
        advanceWorkflowStage: vi.fn(),
        isWorkflowCompleteOrAbsent: () => true,
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
});
