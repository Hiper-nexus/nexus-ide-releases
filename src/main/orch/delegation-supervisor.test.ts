import { describe, expect, it } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import {
  CHEF_IDLE_BLOCK_AFTER_MS,
  DELEGATION_RETRY_MS,
  DELEGATION_SLA_MS,
  decideChefIdleEscalation,
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
  it('chef idle aguardando workers: abaixo do teto só observa', () => {
    const t0 = 1_000_000;
    expect(
      decideChefIdleEscalation({
        idle: true,
        workerCount: 1,
        missionStatus: 'running',
        trackedSince: t0,
        trackedWorkerCount: 1,
        now: t0 + CHEF_IDLE_BLOCK_AFTER_MS - 1,
      }),
    ).toEqual({ action: 'watch' });
  });

  it('chef idle cruza o teto sem mudança de workers: bloqueia com motivo visível', () => {
    const t0 = 1_000_000;
    expect(
      decideChefIdleEscalation({
        idle: true,
        workerCount: 1,
        missionStatus: 'running',
        trackedSince: t0,
        trackedWorkerCount: 1,
        now: t0 + CHEF_IDLE_BLOCK_AFTER_MS,
      }),
    ).toEqual({ action: 'block', sinceMs: t0 });
  });

  it('mudança no número de workers reinicia o relógio (episódio novo)', () => {
    const t0 = 1_000_000;
    expect(
      decideChefIdleEscalation({
        idle: true,
        workerCount: 2,
        missionStatus: 'running',
        trackedSince: t0,
        trackedWorkerCount: 1,
        now: t0 + CHEF_IDLE_BLOCK_AFTER_MS + 5_000,
      }),
    ).toEqual({ action: 'reset' });
  });

  it('chef ocupado ou missão não-running zera o rastreamento', () => {
    expect(
      decideChefIdleEscalation({
        idle: false,
        workerCount: 1,
        missionStatus: 'running',
        trackedSince: 1_000,
        trackedWorkerCount: 1,
        now: 9_999_999,
      }),
    ).toEqual({ action: 'reset' });
    expect(
      decideChefIdleEscalation({
        idle: true,
        workerCount: 1,
        missionStatus: 'blocked',
        trackedSince: 1_000,
        trackedWorkerCount: 1,
        now: 9_999_999,
      }),
    ).toEqual({ action: 'reset' });
  });

  it('primeira observação idle começa a contar, não bloqueia na hora', () => {
    expect(
      decideChefIdleEscalation({
        idle: true,
        workerCount: 1,
        missionStatus: 'running',
        trackedSince: null,
        trackedWorkerCount: 0,
        now: 5_000_000,
      }),
    ).toEqual({ action: 'watch' });
  });

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

  it('records two bounded recoveries without turning the technical stall into a block', () => {
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
    expect(
      isDelegationSupervisable({
        ...progress,
        recoveries: [first, second],
      }),
    ).toBe(true);
  });

  it('does not reinterpret an operator-blocked mission as a technical recovery', () => {
    expect(
      isDelegationSupervisable({
        mission: { ...dispatchedEmpty, status: 'blocked' },
        expectedWorkers: 3,
        workerPanes: 0,
        tasks: 0,
        recoveries: [],
        hasBoundOrchestrator: true,
      }),
    ).toBe(false);
  });

  it('does not supervise consult-lane missions (read-only contract)', () => {
    expect(
      isDelegationSupervisable({
        mission: {
          ...dispatchedEmpty,
          intentContract: {
            ...dispatchedEmpty.intentContract!,
            lane: 'consult',
            budgets: {
              ...dispatchedEmpty.intentContract!.budgets,
              maxWorkers: 0,
            },
          },
        },
        expectedWorkers: 3,
        workerPanes: 0,
        tasks: 0,
        recoveries: [],
        hasBoundOrchestrator: true,
      }),
    ).toBe(false);
  });

  it('does not supervise plan-lane missions (design-only, no worker SLA)', () => {
    expect(
      isDelegationSupervisable({
        mission: {
          ...dispatchedEmpty,
          intentContract: {
            ...dispatchedEmpty.intentContract!,
            lane: 'plan',
            budgets: {
              ...dispatchedEmpty.intentContract!.budgets,
              maxWorkers: 0,
            },
          },
        },
        expectedWorkers: 3,
        workerPanes: 0,
        tasks: 0,
        recoveries: [],
        hasBoundOrchestrator: true,
      }),
    ).toBe(false);
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
