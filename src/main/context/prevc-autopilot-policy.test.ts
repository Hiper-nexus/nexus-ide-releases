import { describe, expect, it } from 'vitest';
import { autopilotActionFor, missionPlanIntegrated } from './prevc-autopilot-policy';

describe('PREVC autopilot policy', () => {
  it('never leaves execution until every sealed task has an integrated worktree', () => {
    expect(missionPlanIntegrated([], [])).toBe(false);
    expect(missionPlanIntegrated(['a', 'b'], [
      { taskId: 'a', status: 'integrated' },
      { taskId: 'b', status: 'ready' },
    ])).toBe(false);
    expect(missionPlanIntegrated(['a', 'b'], [
      { taskId: 'a', status: 'integrated' },
      { taskId: 'b', status: 'integrated' },
    ])).toBe(true);
  });

  it('maps each native stage to a deterministic motor action', () => {
    expect(autopilotActionFor('planning', false, false)).toBe('advance');
    expect(autopilotActionFor('review-primary', false, false)).toBe('review');
    expect(autopilotActionFor('execution', false, true)).toBe('wait-execution');
    expect(autopilotActionFor('execution', true, true)).toBe('advance');
    expect(autopilotActionFor('validation-primary', true, true)).toBe('validate');
    expect(autopilotActionFor('confirmation', true, true)).toBe('advance');
    expect(autopilotActionFor('complete', true, true)).toBe('complete');
  });
});
