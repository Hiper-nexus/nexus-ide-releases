import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { groupMissionsForRail } from './mission-rail-groups';

function mission(
  partial: Partial<Mission> & Pick<Mission, 'id' | 'title' | 'status'>,
): Mission {
  return {
    description: '',
    milestones: [],
    createdAt: 1,
    updatedAt: partial.updatedAt ?? 1,
    ...partial,
  };
}

describe('groupMissionsForRail', () => {
  const missions: Mission[] = [
    mission({ id: 'a', title: 'Alpha deploy', status: 'running', updatedAt: 30 }),
    mission({ id: 'b', title: 'Beta docs', status: 'pending', updatedAt: 20 }),
    mission({ id: 'c', title: 'Gamma done', status: 'done', updatedAt: 10 }),
    mission({ id: 'd', title: 'Delta fail', status: 'failed', updatedAt: 5 }),
    mission({ id: 'e', title: 'Pinned old', status: 'pending', updatedAt: 1 }),
  ];

  it('groups pinned, active, queue, and done', () => {
    const sections = groupMissionsForRail({
      missions,
      openMissionIds: new Set(['a']),
      pinnedIds: ['e'],
      query: '',
    });
    const map = Object.fromEntries(sections.map((s) => [s.id, s.missions.map((m) => m.id)]));
    expect(map.pinned).toEqual(['e']);
    expect(map.active).toEqual(['a']);
    expect(map.queue).toEqual(['b']);
    expect(map.done).toEqual(['c', 'd']);
  });

  it('filters by query across title and status', () => {
    const sections = groupMissionsForRail({
      missions,
      openMissionIds: new Set(),
      pinnedIds: [],
      query: 'deploy',
    });
    const all = sections.flatMap((s) => s.missions.map((m) => m.id));
    expect(all).toEqual(['a']);
  });

  it('keeps pinned out of other sections even if active', () => {
    const sections = groupMissionsForRail({
      missions,
      openMissionIds: new Set(['e']),
      pinnedIds: ['e'],
      query: '',
    });
    expect(sections.find((s) => s.id === 'pinned')?.missions.map((m) => m.id)).toEqual([
      'e',
    ]);
    expect(sections.find((s) => s.id === 'active')?.missions).toEqual([]);
  });
});
