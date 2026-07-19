import { describe, expect, it } from 'vitest';
import { newlyDispatchedPlanMissionIds } from './plan-lane-metrics-store';

describe('newlyDispatchedPlanMissionIds', () => {
  it('does not count full rehydrate from empty prev (avoids metric spam)', () => {
    const prev = new Map<string, string | undefined>();
    const next = [
      { id: 'm1', status: 'running', lane: 'plan' as const },
      { id: 'm2', status: 'running', lane: 'plan' as const },
    ];
    expect(newlyDispatchedPlanMissionIds(prev, next)).toEqual([]);
  });

  it('counts first transition to plan when prev already has missions', () => {
    const prev = new Map<string, string | undefined>([
      ['m0', 'standard'],
      ['m1', 'standard'],
    ]);
    const next = [
      { id: 'm0', status: 'running', lane: 'standard' as const },
      { id: 'm1', status: 'running', lane: 'plan' as const },
    ];
    expect(newlyDispatchedPlanMissionIds(prev, next)).toEqual(['m1']);
  });

  it('does not re-count known plan missions', () => {
    const prev = new Map([['m1', 'plan']]);
    const next = [{ id: 'm1', status: 'running', lane: 'plan' as const }];
    expect(newlyDispatchedPlanMissionIds(prev, next)).toEqual([]);
  });
});
