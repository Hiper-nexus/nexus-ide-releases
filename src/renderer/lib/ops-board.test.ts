import { describe, expect, test } from 'vitest';
import type { Mission, MissionStatus } from '../../shared/orch-types';
import {
  BOARD_ORDER,
  MISSION_STATUS_LABELS,
  canDropMission,
  formatAgo,
  groupMissionsIntoColumns,
  isMissionBoardRecovering,
} from './ops-board';

function mkMission(over: Partial<Mission> & { id: string }): Mission {
  return {
    title: over.id,
    description: '',
    status: 'pending',
    milestones: [],
    learnings: '',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

const automaticRecoveryAuthority: Pick<
  Mission,
  'intentVersion' | 'intentContract'
> = {
  intentVersion: 1,
  intentContract: {
    goal: 'Recuperar missão',
    intentVersion: 1,
    approvedAt: 1,
  } as Mission['intentContract'],
};

describe('groupMissionsIntoColumns', () => {
  test('returns the five columns in fixed pipeline order even without missions', () => {
    const columns = groupMissionsIntoColumns([]);

    expect(columns.map((c) => c.status)).toEqual([
      'pending',
      'running',
      'blocked',
      'done',
      'failed',
    ]);
    expect(columns.every((c) => c.missions.length === 0)).toBe(true);
  });

  test('buckets each mission under its status column', () => {
    const missions = [
      mkMission({ id: 'a', status: 'running' }),
      mkMission({ id: 'b', status: 'done' }),
      mkMission({ id: 'c', status: 'running' }),
    ];

    const columns = groupMissionsIntoColumns(missions);
    const byStatus = Object.fromEntries(columns.map((c) => [c.status, c.missions]));

    expect(byStatus.running.map((m: Mission) => m.id)).toEqual(expect.arrayContaining(['a', 'c']));
    expect(byStatus.done.map((m: Mission) => m.id)).toEqual(['b']);
    expect(byStatus.pending).toEqual([]);
  });

  test('sorts missions inside a column by most recent activity first', () => {
    const missions = [
      mkMission({ id: 'old', status: 'pending', updatedAt: 100 }),
      mkMission({ id: 'new', status: 'pending', updatedAt: 300 }),
      mkMission({ id: 'mid', status: 'pending', updatedAt: 200 }),
    ];

    const pending = groupMissionsIntoColumns(missions)[0];

    expect(pending.missions.map((m) => m.id)).toEqual(['new', 'mid', 'old']);
  });

  test('projects a technical retry as operational instead of human-blocked', () => {
    const retrying = mkMission({
      id: 'retry',
      status: 'blocked',
      intentState: 'blocked_technical',
      ...automaticRecoveryAuthority,
    });
    const waiting = mkMission({
      id: 'human',
      status: 'blocked',
      intentState: 'blocked_user',
    });
    const columns = groupMissionsIntoColumns([retrying, waiting]);
    const byStatus = Object.fromEntries(
      columns.map((column) => [column.status, column.missions]),
    );

    expect(isMissionBoardRecovering(retrying)).toBe(true);
    expect(isMissionBoardRecovering(waiting)).toBe(false);
    expect(byStatus.running.map((mission: Mission) => mission.id)).toEqual([
      'retry',
    ]);
    expect(byStatus.blocked.map((mission: Mission) => mission.id)).toEqual([
      'human',
    ]);
  });
});

describe('canDropMission', () => {
  test('rejects dropping a card back onto its own column', () => {
    expect(canDropMission('pending', 'pending')).toBe(false);
  });

  test('rejects dropping into "running" — execução real só via Retomar', () => {
    const others: MissionStatus[] = ['pending', 'blocked', 'done', 'failed'];
    for (const from of others) {
      expect(canDropMission(from, 'running')).toBe(false);
    }
  });

  test('allows planning overrides between non-running columns', () => {
    expect(canDropMission('pending', 'blocked')).toBe(true);
    expect(canDropMission('done', 'pending')).toBe(true);
    expect(canDropMission('blocked', 'failed')).toBe(true);
  });

  test('allows manually closing a running mission as done or failed', () => {
    expect(canDropMission('running', 'done')).toBe(true);
    expect(canDropMission('running', 'failed')).toBe(true);
  });
});

describe('formatAgo', () => {
  const now = 1_000_000_000;

  test('reads "agora" under a minute', () => {
    expect(formatAgo(now, now - 30_000)).toBe('agora');
  });

  test('reads minutes under an hour', () => {
    expect(formatAgo(now, now - 5 * 60_000)).toBe('5min');
  });

  test('reads hours under a day', () => {
    expect(formatAgo(now, now - 3 * 3_600_000)).toBe('3h');
  });

  test('reads days from a day up', () => {
    expect(formatAgo(now, now - 2 * 86_400_000)).toBe('2d');
  });
});

describe('board vocabulary', () => {
  test('labels match the mission vocabulary used across the app', () => {
    expect(MISSION_STATUS_LABELS).toEqual({
      pending: 'na fila',
      running: 'rodando',
      blocked: 'travada',
      done: 'concluída',
      failed: 'falhou',
    });
    expect(BOARD_ORDER).toHaveLength(5);
  });
});
