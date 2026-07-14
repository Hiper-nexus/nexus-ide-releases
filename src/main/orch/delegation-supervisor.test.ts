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

function recovery(createdAt: number, summary = 'recover'): Handoff {
  return {
    id: `handoff-${createdAt}`,
    missionId: mission.id,
    status: 'stalled',
    claimTrust: 'untrusted',
    summary,
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
  orchestratorSessionId: 'orch-session-1',
  intentContract: {
    version: 1,
    source: 'typed',
    goal: 'Implementar login com OAuth',
    acceptanceCriteria: ['Login funciona'],
    risk: 'sensitive',
    executionMode: 'assisted',
    contextPolicy: 'on-demand',
    intentVersion: 1,
    approvedAt: 1_000,
    dispatchedAt: 1_000,
    budgets: {
      planningTokens: 1200,
      executionTokens: 8000,
      maxWorkers: 2,
      maxSteps: 200,
    },
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
      hasBoundOrchestrator: false,
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
          mission: { ...mission, status: 'running', description: 'stale notes' },
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        mission.createdAt + DELEGATION_SLA_MS,
      ),
    ).toBe(0);
  });

  it('flags a dispatched mission that never creates a task or worker', () => {
    const dispatchAt = dispatchedEmpty.intentContract!.dispatchedAt!;
    expect(
      delegationRecoveryStage(
        {
          mission: dispatchedEmpty,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        dispatchAt + DELEGATION_SLA_MS,
      ),
    ).toBe(1);
  });

  it('does not fire stage-1 immediately after long arm + fresh dispatch', () => {
    // Mission armed hours ago; dispatch authorized just now.
    const armedLongAgo: Mission = {
      ...dispatchedEmpty,
      createdAt: 1,
      updatedAt: 1,
      intentContract: {
        ...dispatchedEmpty.intentContract!,
        approvedAt: 1_000_000,
        dispatchedAt: 1_000_000,
      },
    };
    expect(
      delegationRecoveryStage(
        {
          mission: armedLongAgo,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        1_000_000 + DELEGATION_SLA_MS - 1,
      ),
    ).toBe(0);
    expect(
      delegationRecoveryStage(
        {
          mission: armedLongAgo,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        1_000_000 + DELEGATION_SLA_MS,
      ),
    ).toBe(1);
  });

  it('is not supervisable without a bound orchestrator', () => {
    expect(
      isDelegationSupervisable({
        mission: dispatchedEmpty,
        expectedWorkers: 3,
        workerPanes: 0,
        tasks: 0,
        recoveries: [],
        hasBoundOrchestrator: false,
      }),
    ).toBe(false);
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
          hasBoundOrchestrator: true,
        },
        dispatchedEmpty.intentContract!.dispatchedAt! + DELEGATION_SLA_MS * 2,
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
          hasBoundOrchestrator: true,
        },
        dispatchedEmpty.intentContract!.dispatchedAt! + DELEGATION_SLA_MS * 10,
      ),
    ).toBe(0);
  });

  it('retries once and never loops', () => {
    const dispatchAt = dispatchedEmpty.intentContract!.dispatchedAt!;
    const first = recovery(
      dispatchAt + DELEGATION_SLA_MS,
      `recover [recovery:${dispatchedEmpty.id}:stage_1]`,
    );
    const atRetry = first.createdAt + DELEGATION_RETRY_MS;
    const progress = {
      mission: dispatchedEmpty,
      expectedWorkers: 3,
      workerPanes: 0,
      tasks: 0,
      hasBoundOrchestrator: true as const,
    };
    expect(
      delegationRecoveryStage({ ...progress, recoveries: [first] }, atRetry),
    ).toBe(2);
    const second = recovery(
      atRetry,
      `final [recovery:${dispatchedEmpty.id}:stage_2]`,
    );
    expect(
      delegationRecoveryStage(
        {
          ...progress,
          recoveries: [first, second],
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
          hasBoundOrchestrator: true,
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
          hasBoundOrchestrator: true,
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
            hasBoundOrchestrator: true,
          },
          Number.MAX_SAFE_INTEGER,
        ),
      ).toBe(0);
    }
  });
});
