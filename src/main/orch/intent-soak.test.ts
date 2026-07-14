// @vitest-environment node
/**
 * Long-horizon soak without Electron GUI: advance fake timers through 10
 * minutes of delegation-supervisor scans and assert intent-first invariants
 * hold (no recovery for awaiting_goal; staged recovery only after dispatch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELEGATION_SCAN_MS,
  DELEGATION_SLA_MS,
  delegationRecoveryStage,
  isDelegationSupervisable,
} from './delegation-supervisor';
import type { Handoff, Mission } from '../../shared/orch-types';
import { compileIntentContract } from '../../shared/mission-intent';

const TEN_MIN_MS = 10 * 60_000;

function awaitingMission(createdAt: number): Mission {
  return {
    id: 'm-await',
    title: 'NavalhaGO',
    description: '',
    status: 'pending',
    squadId: 'navalha',
    milestones: [],
    learnings: '',
    intentState: 'awaiting_goal',
    intentVersion: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

function dispatchedMission(dispatchedAt: number): Mission {
  const contract = {
    ...compileIntentContract({
      goal: 'Implementar feature sob soak',
      intentVersion: 1,
    }),
    approvedAt: dispatchedAt,
    dispatchedAt,
  };
  return {
    id: 'm-dispatch',
    title: 'Soak mission',
    description: contract.goal,
    status: 'running',
    squadId: 'navalha',
    milestones: [],
    learnings: '',
    intentState: 'dispatched',
    intentVersion: 1,
    intentContract: contract,
    orchestratorSessionId: 'orch-1',
    createdAt: dispatchedAt - 3_600_000,
    updatedAt: dispatchedAt,
  };
}

describe('intent-first 10-minute soak (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('awaiting_goal stays non-supervisable for a full 10 minutes', () => {
    const t0 = Date.now();
    const mission = awaitingMission(t0);
    const progress = {
      mission,
      expectedWorkers: 4,
      workerPanes: 0,
      tasks: 0,
      recoveries: [] as Handoff[],
      hasBoundOrchestrator: false,
    };

    const scans = Math.ceil(TEN_MIN_MS / DELEGATION_SCAN_MS);
    for (let i = 0; i < scans; i += 1) {
      vi.advanceTimersByTime(DELEGATION_SCAN_MS);
      const now = Date.now();
      expect(isDelegationSupervisable(progress)).toBe(false);
      expect(delegationRecoveryStage(progress, now)).toBe(0);
    }
    expect(Date.now() - t0).toBeGreaterThanOrEqual(TEN_MIN_MS - DELEGATION_SCAN_MS);
  });

  it('dispatched empty mission only recovers after SLA from dispatch, not arm age', () => {
    const dispatchAt = Date.now();
    const mission = dispatchedMission(dispatchAt);
    const progress = {
      mission,
      expectedWorkers: 3,
      workerPanes: 0,
      tasks: 0,
      recoveries: [] as Handoff[],
      hasBoundOrchestrator: true,
      orchestratorState: 'idle' as const,
    };

    // Just after dispatch: still inside SLA
    expect(
      delegationRecoveryStage(progress, dispatchAt + DELEGATION_SLA_MS - 1),
    ).toBe(0);

    // At SLA: stage 1
    expect(
      delegationRecoveryStage(progress, dispatchAt + DELEGATION_SLA_MS),
    ).toBe(1);

    // Soak remaining 10 minutes: with one recovery handoff, stage caps at 2 once.
    const recoveries: Handoff[] = [
      {
        id: 'r1',
        missionId: mission.id,
        status: 'progress',
        claimTrust: 'untrusted',
        summary: `recover [recovery:${mission.id}:stage_1]`,
        artifacts: [],
        evidenceIds: [],
        evidenceTrust: 'unverified',
        delivered: true,
        deliveryState: 'submitted',
        createdAt: dispatchAt + DELEGATION_SLA_MS,
      },
    ];
    const withRecovery = { ...progress, recoveries };
    const end = dispatchAt + TEN_MIN_MS;
    // Before retry window
    expect(
      delegationRecoveryStage(
        withRecovery,
        dispatchAt + DELEGATION_SLA_MS + 1_000,
      ),
    ).toBe(0);
    // After retry window → stage 2 once
    expect(delegationRecoveryStage(withRecovery, end)).toBe(2);

    // Stage 2 already present → never loops
    const both: Handoff[] = [
      ...recoveries,
      {
        ...recoveries[0]!,
        id: 'r2',
        status: 'stalled',
        summary: `final [recovery:${mission.id}:stage_2]`,
        createdAt: end,
      },
    ];
    expect(
      delegationRecoveryStage({ ...progress, recoveries: both }, end + TEN_MIN_MS),
    ).toBe(0);
  });
});
