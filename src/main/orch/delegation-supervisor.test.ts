import { describe, expect, it } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import {
  DELEGATION_RETRY_MS,
  DELEGATION_SLA_MS,
  delegationRecoveryStage,
  isDelegationSupervisable,
} from './delegation-supervisor';

const mission: Mission = {
  id: 'mission-a',
  title: 'Mission A',
  description: '',
  status: 'pending',
  squadId: 'squad-a',
  milestones: [],
  learnings: '',
  createdAt: 1_000,
  updatedAt: 1_000,
};

function recovery(createdAt: number): Handoff {
  return {
    id: `handoff-${createdAt}`,
    missionId: mission.id,
    status: 'stalled',
    claimTrust: 'untrusted',
    summary: 'recover',
    artifacts: [],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: true,
    deliveryState: 'submitted',
    createdAt,
  };
}

/** Dispatched mission that should still be recoverable when empty after SLA. */
const dispatchedEmpty: Mission = {
  ...mission,
  status: 'running',
  description: 'Implementar login com OAuth',
  intentState: 'dispatched',
  intentVersion: 1,
  intentContract: {
    version: 1,
    source: 'typed',
    goal: 'Implementar login com OAuth',
    acceptanceCriteria: ['Login funciona'],
    risk: 'sensitive',
    executionMode: 'assisted',
    contextPolicy: 'on-demand',
    intentVersion: 1,
    budgets: { planningTokens: 1200, executionTokens: 8000, maxWorkers: 2 },
  },
};

describe('delegation supervisor policy', () => {
  it('does NOT recover a squad mission that is only awaiting a goal (NavalhaGO case)', () => {
    const awaiting = {
      mission: {
        ...mission,
        status: 'pending' as const,
        intentState: 'awaiting_goal' as const,
      },
      expectedWorkers: 3,
      workerPanes: 0,
      tasks: 0,
      recoveries: [] as Handoff[],
    };
    expect(isDelegationSupervisable(awaiting)).toBe(false);
    expect(
      delegationRecoveryStage(awaiting, mission.createdAt + DELEGATION_SLA_MS * 10),
    ).toBe(0);
  });

  it('does not recover legacy running shells with zero goal, tasks, or workers', () => {
    // Pre-migration path: status=running was set on squad select without a goal.
    expect(
      delegationRecoveryStage(
        {
          mission: { ...mission, status: 'running' },
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
        },
        mission.createdAt + DELEGATION_SLA_MS,
      ),
    ).toBe(0);
  });

  it('flags a dispatched mission that never creates a task or worker', () => {
    expect(
      delegationRecoveryStage(
        {
          mission: dispatchedEmpty,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
        },
        dispatchedEmpty.createdAt + DELEGATION_SLA_MS,
      ),
    ).toBe(1);
  });

  it('stops observing as soon as real delegation progress exists', () => {
    expect(
      delegationRecoveryStage(
        {
          mission: dispatchedEmpty,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 1,
          recoveries: [],
        },
        dispatchedEmpty.createdAt + DELEGATION_SLA_MS * 2,
      ),
    ).toBe(0);
  });

  it('does not call an orchestrator stalled while its terminal is working', () => {
    expect(
      delegationRecoveryStage(
        {
          mission: dispatchedEmpty,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          orchestratorState: 'busy',
        },
        dispatchedEmpty.createdAt + DELEGATION_SLA_MS * 10,
      ),
    ).toBe(0);
  });

  it('retries once and never loops', () => {
    const first = recovery(dispatchedEmpty.createdAt + DELEGATION_SLA_MS);
    const atRetry = first.createdAt + DELEGATION_RETRY_MS;
    const progress = {
      mission: dispatchedEmpty,
      expectedWorkers: 3,
      workerPanes: 0,
      tasks: 0,
    };
    expect(
      delegationRecoveryStage({ ...progress, recoveries: [first] }, atRetry),
    ).toBe(2);
    expect(
      delegationRecoveryStage(
        {
          ...progress,
          recoveries: [first, recovery(atRetry)],
        },
        atRetry + DELEGATION_RETRY_MS * 10,
      ),
    ).toBe(0);
  });

  it('does not interfere with squads that have no workers or terminal missions', () => {
    expect(
      delegationRecoveryStage(
        {
          mission: dispatchedEmpty,
          expectedWorkers: 0,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
        },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(0);
    expect(
      delegationRecoveryStage(
        {
          mission: { ...dispatchedEmpty, status: 'blocked' },
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
        },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(0);
  });

  it('ignores awaiting_approval and blocked_user forever', () => {
    for (const intentState of ['awaiting_approval', 'blocked_user'] as const) {
      expect(
        delegationRecoveryStage(
          {
            mission: {
              ...dispatchedEmpty,
              status: 'pending',
              intentState,
            },
            expectedWorkers: 5,
            workerPanes: 0,
            tasks: 0,
            recoveries: [],
          },
          Number.MAX_SAFE_INTEGER,
        ),
      ).toBe(0);
    }
  });
});
