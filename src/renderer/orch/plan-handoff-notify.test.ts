import { describe, expect, it } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import { detectNewPlanHandoffs } from './plan-handoff-notify';

function handoff(partial: Partial<Handoff> & { id: string }): Handoff {
  return {
    claimTrust: 'untrusted',
    status: 'success',
    summary: 'plano escrito em plan.md com riscos e verificação',
    artifacts: [],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: false,
    deliveryState: 'submitted',
    createdAt: 1,
    ...partial,
  };
}

function mission(id: string, lane: 'plan' | 'standard'): Mission {
  return {
    id,
    title: `M ${id}`,
    description: 'goal',
    status: 'running',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 1,
    intentContract: {
      version: 1,
      source: 'typed',
      goal: 'goal',
      acceptanceCriteria: ['c'],
      risk: 'normal',
      executionMode: 'autopilot',
      lane,
      intentVersion: 1,
      budgets: {
        planningTokens: 1000,
        executionTokens: 1000,
        maxWorkers: lane === 'plan' ? 0 : 2,
        maxSteps: 32,
      },
    },
  };
}

describe('detectNewPlanHandoffs', () => {
  it('flags new success handoffs only for plan-lane missions', () => {
    const prev: Handoff[] = [];
    const next = [
      handoff({ id: 'h1', missionId: 'm-plan' }),
      handoff({ id: 'h2', missionId: 'm-std' }),
      handoff({ id: 'h3', missionId: 'm-plan', status: 'failed' }),
    ];
    const missions = [mission('m-plan', 'plan'), mission('m-std', 'standard')];
    const ready = detectNewPlanHandoffs(prev, next, missions);
    expect(ready).toEqual([
      { missionId: 'm-plan', title: 'M m-plan', handoffId: 'h1' },
    ]);
  });

  it('ignores handoffs already known', () => {
    const h = handoff({ id: 'h1', missionId: 'm-plan' });
    const missions = [mission('m-plan', 'plan')];
    expect(detectNewPlanHandoffs([h], [h], missions)).toEqual([]);
  });
});
