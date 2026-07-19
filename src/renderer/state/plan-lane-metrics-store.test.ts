import { describe, expect, it } from 'vitest';
import { newlyDispatchedPlanMissionIds } from './plan-lane-metrics-store';

describe('newlyDispatchedPlanMissionIds', () => {
  it('counts first sighting of a plan mission', () => {
    const prev = new Map<string, string | undefined>();
    const next = [
      { id: 'm1', status: 'running', lane: 'plan' as const },
      { id: 'm2', status: 'running', lane: 'standard' as const },
    ];
    expect(newlyDispatchedPlanMissionIds(prev, next)).toEqual(['m1']);
  });

  it('does not re-count known plan missions', () => {
    const prev = new Map([['m1', 'plan']]);
    const next = [{ id: 'm1', status: 'running', lane: 'plan' as const }];
    expect(newlyDispatchedPlanMissionIds(prev, next)).toEqual([]);
  });

  it('counts when lane becomes plan', () => {
    const prev = new Map([['m1', 'standard']]);
    const next = [{ id: 'm1', status: 'running', lane: 'plan' as const }];
    expect(newlyDispatchedPlanMissionIds(prev, next)).toEqual(['m1']);
  });
});
