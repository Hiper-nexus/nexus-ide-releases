import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import {
  groupMissionsForRail,
  missionRailResumeCopy,
  railStatusDisplay,
} from './mission-rail-groups';

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
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.pinned).toEqual(['e']);
    expect(map.active).toEqual(['a']);
    expect(map.queue).toEqual(['b']);
    expect(map.done).toEqual(['c', 'd']);
  });

  it('puts status=running in Em progresso even without live panes', () => {
    // Bug: terminal rodando mas bind pane↔missão ausente → caía em Na fila.
    const sections = groupMissionsForRail({
      missions,
      openMissionIds: new Set(),
      pinnedIds: [],
      query: '',
    });
    const map = Object.fromEntries(
      sections.map((s) => [s.id, s.missions.map((m) => m.id)]),
    );
    expect(map.active).toEqual(['a']);
    // pending sem panes = fila (b e e)
    expect(map.queue).toEqual(['b', 'e']);
  });

  it('puts blocked in Em progresso', () => {
    const blocked = mission({
      id: 'blk',
      title: 'Precisa de ok',
      status: 'blocked',
      updatedAt: 40,
    });
    const sections = groupMissionsForRail({
      missions: [...missions, blocked],
      openMissionIds: new Set(),
      pinnedIds: [],
      query: '',
    });
    const active = sections.find((s) => s.id === 'active')!.missions.map((m) => m.id);
    expect(active).toContain('blk');
    expect(active).toContain('a');
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
    expect(
      sections.find((s) => s.id === 'pinned')?.missions.map((m) => m.id),
    ).toEqual(['e']);
    expect(sections.find((s) => s.id === 'active')?.missions.map((m) => m.id)).toEqual(
      ['a'],
    );
  });
});

describe('railStatusDisplay', () => {
  it('marks live grid as Ao vivo', () => {
    expect(railStatusDisplay('pending', true)).toEqual({
      label: 'Ao vivo',
      tone: 'live',
    });
  });

  it('maps mission status to pill labels', () => {
    expect(railStatusDisplay('pending', false).label).toBe('Na fila');
    expect(railStatusDisplay('running', false).label).toBe('Em curso');
    expect(railStatusDisplay('blocked', false).label).toBe('Travada');
    expect(railStatusDisplay('done', false).label).toBe('Concluída');
    expect(railStatusDisplay('failed', false).label).toBe('Falhou');
  });
});

describe('missionRailResumeCopy', () => {
  it('labels an off-grid running mission as recoverable instead of focusable', () => {
    expect(missionRailResumeCopy('running', false)).toEqual({
      meta: 'Retomar panes salvos',
      title: 'Panes salvos — clique para retomar',
    });
  });

  it('keeps a live mission focused on its existing grid panes', () => {
    expect(missionRailResumeCopy('running', true)).toEqual({
      meta: null,
      title: 'Missão aberta no grid — clique para focar',
    });
  });
});
