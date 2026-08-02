import { beforeEach, describe, expect, it } from 'vitest';

import { missionBlockCause } from '../../shared/mission-block-cause';
import { TASK_DISPATCH_HEARTBEAT_LEASE_MS } from './task-dispatch-lifecycle';
import { STALLED_MERGE_ATTEMPT_MS } from '../runtime/merge-stall-watchdog';
import {
  HOLDER_MERGE_DEADLINE_UPPER_BOUND_MS,
  HOLDER_WORKER_LEASE_UPPER_BOUND_MS,
  OWNERSHIP_WAIT_CEILING_MS,
  clearOwnershipWaitEdge,
  crossMissionOwnershipConflict,
  decideOwnershipWait,
  findOwnershipWaitCycle,
  ownershipWaitEdges,
  pruneOwnershipWaitEdgesForMission,
  recordOwnershipWaitEdge,
  resetOwnershipWaitGraph,
  type OwnershipWaitEdge,
} from './mission-ownership-wait';

/** Shape-compatible stand-in for runtime/worktree-contract OwnershipOverlapError. */
function overlapError(input: {
  readonly missionId?: string;
  readonly taskId?: string;
  readonly files?: readonly string[];
  readonly domains?: readonly string[];
}): Error {
  const error = new Error(
    `worktree ownership overlaps active task ${input.missionId}/${input.taskId}`,
  );
  return Object.assign(error, {
    name: 'OwnershipOverlapError',
    conflictingTaskKey: 'deadbeef',
    conflictingMissionId: input.missionId,
    conflictingTaskId: input.taskId,
    files: Object.freeze(input.files ?? ['src/main/orch/a.ts']),
    symbols: Object.freeze([]),
    domains: Object.freeze(input.domains ?? []),
  });
}

const WAITER = Object.freeze({ missionId: 'mission-a', taskId: 'task-1' });

function edge(
  waiterMissionId: string,
  waiterTaskId: string,
  holderMissionId: string,
  holderTaskId = 'held',
): OwnershipWaitEdge {
  return Object.freeze({
    waiterMissionId,
    waiterTaskId,
    holderMissionId,
    holderTaskId,
    since: 0,
  });
}

beforeEach(() => {
  resetOwnershipWaitGraph();
});

describe('crossMissionOwnershipConflict', () => {
  it('names the holder when another mission holds the claim', () => {
    const conflict = crossMissionOwnershipConflict(
      overlapError({
        missionId: 'mission-b',
        taskId: 'task-9',
        files: ['src/main/orch/a.ts'],
        domains: ['guided-implementation'],
      }),
      'mission-a',
    );
    expect(conflict).not.toBeNull();
    expect(conflict?.holderMissionId).toBe('mission-b');
    expect(conflict?.holderTaskId).toBe('task-9');
    expect(conflict?.claims).toEqual([
      'src/main/orch/a.ts',
      'domain:guided-implementation',
    ]);
  });

  it('leaves an INTRA-mission collision exactly as it is today', () => {
    expect(
      crossMissionOwnershipConflict(
        overlapError({ missionId: 'mission-a', taskId: 'task-2' }),
        'mission-a',
      ),
    ).toBeNull();
  });

  it('refuses to wait on an unnamed holder', () => {
    expect(
      crossMissionOwnershipConflict(
        overlapError({ missionId: undefined, taskId: undefined }),
        'mission-a',
      ),
    ).toBeNull();
  });

  it('ignores errors that are not an ownership overlap', () => {
    expect(
      crossMissionOwnershipConflict(new Error('boom'), 'mission-a'),
    ).toBeNull();
  });

  it('unwraps an overlap carried as a cause', () => {
    const wrapped = new Error('dispatch falhou', {
      cause: overlapError({ missionId: 'mission-b', taskId: 'task-9' }),
    });
    expect(
      crossMissionOwnershipConflict(wrapped, 'mission-a')?.holderMissionId,
    ).toBe('mission-b');
  });
});

describe('OWNERSHIP_WAIT_CEILING_MS', () => {
  it('mirrors the real release-chain bounds without drift', () => {
    expect(HOLDER_WORKER_LEASE_UPPER_BOUND_MS).toBe(
      TASK_DISPATCH_HEARTBEAT_LEASE_MS,
    );
    expect(HOLDER_MERGE_DEADLINE_UPPER_BOUND_MS).toBe(STALLED_MERGE_ATTEMPT_MS);
    expect(OWNERSHIP_WAIT_CEILING_MS).toBe(
      TASK_DISPATCH_HEARTBEAT_LEASE_MS + STALLED_MERGE_ATTEMPT_MS,
    );
  });
});

describe('decideOwnershipWait', () => {
  const conflict = Object.freeze({
    holderMissionId: 'mission-b',
    holderTaskId: 'task-9',
    claims: Object.freeze(['src/main/orch/a.ts']),
  });

  it('WAITS naming who holds instead of killing the dispatch', () => {
    const decision = decideOwnershipWait({
      conflict,
      waiter: WAITER,
      since: 1_000,
      now: 1_000 + 30_000,
      holdersSeen: 1,
      edges: [edge('mission-a', 'task-1', 'mission-b', 'task-9')],
    });
    expect(decision.kind).toBe('wait');
    expect(decision.reason).toContain('mission-b');
    expect(decision.reason).toContain('task-9');
    expect(decision.waitedMs).toBe(30_000);
  });

  it('EXPIRES with an actionable reason when the holder never releases', () => {
    const decision = decideOwnershipWait({
      conflict,
      waiter: WAITER,
      since: 1_000,
      now: 1_000 + OWNERSHIP_WAIT_CEILING_MS,
      holdersSeen: 1,
      edges: [edge('mission-a', 'task-1', 'mission-b', 'task-9')],
    });
    expect(decision.kind).toBe('expired');
    expect(decision.reason).toContain('mission-b');
    expect(decision.reason).toMatch(/libere a reserva/iu);
  });

  it('DETECTS mutual wait before the ceiling instead of sleeping forever', () => {
    const decision = decideOwnershipWait({
      conflict,
      waiter: WAITER,
      since: 1_000,
      now: 1_000 + 5_000,
      holdersSeen: 1,
      edges: [
        edge('mission-a', 'task-1', 'mission-b', 'task-9'),
        edge('mission-b', 'task-9', 'mission-a', 'task-1'),
      ],
    });
    expect(decision.kind).toBe('deadlock');
    if (decision.kind !== 'deadlock') return;
    expect(decision.cycle).toEqual(['mission-a', 'mission-b', 'mission-a']);
    expect(decision.reason).toMatch(/espera mútua/iu);
  });

  it('names starvation by distinct holders, not just a stuck reservation', () => {
    const decision = decideOwnershipWait({
      conflict,
      waiter: WAITER,
      since: 1_000,
      now: 1_000 + OWNERSHIP_WAIT_CEILING_MS,
      holdersSeen: 4,
      edges: [edge('mission-a', 'task-1', 'mission-b', 'task-9')],
    });
    expect(decision.kind).toBe('expired');
    expect(decision.reason).toMatch(/4 reservas/iu);
  });

  it('every named outcome is presented as an ownership conflict', () => {
    const outcomes = [
      decideOwnershipWait({
        conflict,
        waiter: WAITER,
        since: 0,
        now: 30_000,
        holdersSeen: 1,
        edges: [edge('mission-a', 'task-1', 'mission-b', 'task-9')],
      }),
      decideOwnershipWait({
        conflict,
        waiter: WAITER,
        since: 0,
        now: OWNERSHIP_WAIT_CEILING_MS,
        holdersSeen: 1,
        edges: [edge('mission-a', 'task-1', 'mission-b', 'task-9')],
      }),
      decideOwnershipWait({
        conflict,
        waiter: WAITER,
        since: 0,
        now: 5_000,
        holdersSeen: 1,
        edges: [
          edge('mission-a', 'task-1', 'mission-b', 'task-9'),
          edge('mission-b', 'task-9', 'mission-a', 'task-1'),
        ],
      }),
    ];
    for (const outcome of outcomes) {
      expect(
        missionBlockCause({ description: `## Bloqueio\n${outcome.reason}` })
          .code,
      ).toBe('ownership-conflict');
    }
  });
});

describe('findOwnershipWaitCycle', () => {
  it('returns null when the wait chain terminates', () => {
    expect(
      findOwnershipWaitCycle(
        [
          edge('mission-a', 'task-1', 'mission-b'),
          edge('mission-b', 'task-9', 'mission-c'),
        ],
        'mission-a',
      ),
    ).toBeNull();
  });

  it('finds a cycle longer than two missions', () => {
    expect(
      findOwnershipWaitCycle(
        [
          edge('mission-a', 'task-1', 'mission-b'),
          edge('mission-b', 'task-9', 'mission-c'),
          edge('mission-c', 'task-4', 'mission-a'),
        ],
        'mission-a',
      ),
    ).toEqual(['mission-a', 'mission-b', 'mission-c', 'mission-a']);
  });

  it('does not report a cycle that never returns to the waiter', () => {
    expect(
      findOwnershipWaitCycle(
        [
          edge('mission-a', 'task-1', 'mission-b'),
          edge('mission-b', 'task-9', 'mission-c'),
          edge('mission-c', 'task-4', 'mission-b'),
        ],
        'mission-a',
      ),
    ).toBeNull();
  });
});

describe('ownership wait graph registry', () => {
  it('records and clears the edge a waiting task holds', () => {
    recordOwnershipWaitEdge(edge('mission-a', 'task-1', 'mission-b', 'task-9'));
    expect(ownershipWaitEdges()).toHaveLength(1);
    clearOwnershipWaitEdge('mission-a', 'task-1');
    expect(ownershipWaitEdges()).toHaveLength(0);
  });

  it('replaces the edge when the holder changes', () => {
    recordOwnershipWaitEdge(edge('mission-a', 'task-1', 'mission-b', 'task-9'));
    recordOwnershipWaitEdge(edge('mission-a', 'task-1', 'mission-c', 'task-3'));
    expect(ownershipWaitEdges()).toEqual([
      expect.objectContaining({ holderMissionId: 'mission-c' }),
    ]);
  });

  it('prunes only this mission ghost edges, never a peer wait', () => {
    recordOwnershipWaitEdge(edge('mission-a', 'task-1', 'mission-b', 'task-9'));
    recordOwnershipWaitEdge(edge('mission-a', 'task-2', 'mission-b', 'task-9'));
    recordOwnershipWaitEdge(edge('mission-b', 'task-9', 'mission-c', 'task-3'));
    pruneOwnershipWaitEdgesForMission('mission-a', new Set(['task-1']));
    expect(
      ownershipWaitEdges().map(
        (entry) => `${entry.waiterMissionId}/${entry.waiterTaskId}`,
      ),
    ).toEqual(['mission-a/task-1', 'mission-b/task-9']);
  });
});
