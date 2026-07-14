import { describe, expect, it } from 'vitest';
import type { Mission } from './orch-types';
import {
  isMissionGreen,
  missionEndorphinForTransition,
} from './mission-endorphin';

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    title: 'Ship UI',
    description: '',
    status: 'running',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('missionEndorphinForTransition', () => {
  it('dispara Luz Verde quando done com evidência', () => {
    const next = mission({
      status: 'done',
      milestones: [
        {
          id: 's1',
          label: 'test',
          status: 'done',
          evidenceIds: ['ev:1'],
        },
      ],
    });
    expect(isMissionGreen(next)).toBe(true);
    const hit = missionEndorphinForTransition('running', next);
    expect(hit?.kind).toBe('green');
    expect(hit?.kicker).toMatch(/Luz Verde/i);
  });

  it('dispara done sem evidência', () => {
    const next = mission({ status: 'done', milestones: [] });
    expect(isMissionGreen(next)).toBe(false);
    expect(missionEndorphinForTransition('running', next)?.kind).toBe('done');
  });

  it('ignora status estável', () => {
    expect(
      missionEndorphinForTransition('done', mission({ status: 'done' })),
    ).toBeNull();
  });

  it('dispara failed', () => {
    const hit = missionEndorphinForTransition(
      'running',
      mission({ status: 'failed' }),
    );
    expect(hit?.kind).toBe('failed');
  });
});
