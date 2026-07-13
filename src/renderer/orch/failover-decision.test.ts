import { describe, expect, it } from 'vitest';
import {
  isSameAccountFailover,
  resolveContinuityMission,
} from './failover-decision';

describe('isSameAccountFailover', () => {
  it('never lets equal labels override crossAccount:true', () => {
    expect(
      isSameAccountFailover({
        crossAccount: true,
        fromAccountId: 'a',
        toAccountId: 'b',
        fromAccountLabel: 'Work',
        toAccountLabel: 'Work',
      }),
    ).toBe(false);
  });

  it('honors crossAccount:false even when labels differ', () => {
    expect(
      isSameAccountFailover({
        crossAccount: false,
        fromAccountId: 'a',
        toAccountId: 'a',
        fromAccountLabel: 'A',
        toAccountLabel: 'B',
      }),
    ).toBe(true);
  });

  it('uses account ids when flag is absent', () => {
    expect(
      isSameAccountFailover({
        fromAccountId: 'a',
        toAccountId: 'b',
        fromAccountLabel: 'X',
        toAccountLabel: 'X',
      }),
    ).toBe(false);
    expect(
      isSameAccountFailover({
        fromAccountId: 'a',
        toAccountId: 'a',
        fromAccountLabel: 'X',
        toAccountLabel: 'Y',
      }),
    ).toBe(true);
  });
});

describe('resolveContinuityMission', () => {
  const missions = [
    { id: 'm-global', title: 'Global first', status: 'running' },
    { id: 'm-pane', title: 'Pane mission', status: 'running' },
    { id: 'm-blocked', title: 'Blocked', status: 'blocked' },
  ];

  it('prefers pane-bound mission over global running list', () => {
    const r = resolveContinuityMission({
      paneId: 'p1',
      paneMissions: { p1: 'm-pane' },
      missions,
    });
    expect(r.missionId).toBe('m-pane');
    expect(r.openWorkHint).toContain('m-pane');
    expect(r.openWorkHint).toContain('m-global');
  });

  it('falls back to event mission id then open missions', () => {
    const r = resolveContinuityMission({
      paneId: 'orphan',
      paneMissions: {},
      missions,
      eventMissionId: 'm-blocked',
    });
    expect(r.missionId).toBe('m-blocked');
  });
});
