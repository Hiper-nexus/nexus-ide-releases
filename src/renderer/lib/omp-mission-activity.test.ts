import { describe, expect, it } from 'vitest';
import type { OmpRpcSessionSummary } from '../../shared/omp-rpc-types';
import {
  missionIdsWithOmpWorkers,
  ompRailMetaFragment,
  summarizeOmpMissionActivity,
} from './omp-mission-activity';

function session(
  partial: Partial<OmpRpcSessionSummary> &
    Pick<OmpRpcSessionSummary, 'sessionId' | 'missionId' | 'state'>,
): OmpRpcSessionSummary {
  const state = partial.state;
  const isStreaming = partial.snapshot?.isStreaming ?? false;
  return {
    sessionId: partial.sessionId,
    paneId: partial.paneId ?? `omp-rpc:${partial.sessionId}`,
    kind: partial.kind ?? 'mission',
    title: partial.title ?? 'Reviewer D (omp)',
    missionId: partial.missionId,
    state,
    snapshot: {
      state,
      model: null,
      contextUsage: null,
      isStreaming,
      sessionName: null,
      approvalPolicy: 'safe',
      autoApprovals: 0,
      ...partial.snapshot,
    },
  };
}

describe('summarizeOmpMissionActivity', () => {
  it('counts only matching mission workers', () => {
    const rows = [
      session({ sessionId: 'a', missionId: 'm1', state: 'busy' }),
      session({ sessionId: 'b', missionId: 'm1', state: 'spawning' }),
      session({ sessionId: 'c', missionId: 'm2', state: 'busy' }),
      session({
        sessionId: 'd',
        missionId: 'm1',
        state: 'idle',
        kind: 'panel',
      }),
    ];
    const activity = summarizeOmpMissionActivity(rows, 'm1');
    expect(activity.working).toBe(1);
    expect(activity.starting).toBe(1);
    expect(activity.idle).toBe(0);
    expect(activity.titles).toEqual(['Reviewer D (omp)', 'Reviewer D (omp)']);
  });

  it('treats streaming idle snapshot as working', () => {
    const rows = [
      session({
        sessionId: 'a',
        missionId: 'm1',
        state: 'idle',
        snapshot: {
          state: 'idle',
          model: null,
          contextUsage: null,
          isStreaming: true,
          sessionName: null,
          approvalPolicy: 'safe',
          autoApprovals: 0,
        },
      }),
    ];
    expect(summarizeOmpMissionActivity(rows, 'm1').working).toBe(1);
  });
});

describe('missionIdsWithOmpWorkers', () => {
  it('skips exited and panel sessions', () => {
    const ids = missionIdsWithOmpWorkers([
      session({ sessionId: 'a', missionId: 'm1', state: 'busy' }),
      session({ sessionId: 'b', missionId: 'm2', state: 'exited' }),
      session({
        sessionId: 'c',
        missionId: 'm3',
        state: 'idle',
        kind: 'panel',
      }),
    ]);
    expect([...ids]).toEqual(['m1']);
  });
});

describe('ompRailMetaFragment', () => {
  it('prefers working over idle', () => {
    expect(
      ompRailMetaFragment({
        working: 2,
        starting: 1,
        idle: 3,
        down: 0,
        titles: [],
      }),
    ).toBe('2 omp trabalhando');
  });

  it('returns null when empty', () => {
    expect(
      ompRailMetaFragment({
        working: 0,
        starting: 0,
        idle: 0,
        down: 0,
        titles: [],
      }),
    ).toBeNull();
  });
});
