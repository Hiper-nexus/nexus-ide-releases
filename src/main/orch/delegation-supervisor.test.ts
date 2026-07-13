import { describe, expect, it } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import {
  DELEGATION_RETRY_MS,
  DELEGATION_SLA_MS,
  delegationRecoveryStage,
} from './delegation-supervisor';

const mission: Mission = {
  id: 'mission-a',
  title: 'Mission A',
  description: '',
  status: 'pending',
  squadId: 'squad-a',
  milestones: [],
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
    createdAt,
  };
}

describe('delegation supervisor policy', () => {
  it('flags a roster mission that never creates a task or worker', () => {
    expect(delegationRecoveryStage({
      mission,
      expectedWorkers: 3,
      workerPanes: 0,
      tasks: 0,
      recoveries: [],
    }, mission.createdAt + DELEGATION_SLA_MS)).toBe(1);
  });

  it('stops observing as soon as real delegation progress exists', () => {
    expect(delegationRecoveryStage({
      mission,
      expectedWorkers: 3,
      workerPanes: 0,
      tasks: 1,
      recoveries: [],
    }, mission.createdAt + DELEGATION_SLA_MS * 2)).toBe(0);
  });

  it('retries once and never loops', () => {
    const first = recovery(mission.createdAt + DELEGATION_SLA_MS);
    const atRetry = first.createdAt + DELEGATION_RETRY_MS;
    const progress = {
      mission,
      expectedWorkers: 3,
      workerPanes: 0,
      tasks: 0,
    };
    expect(delegationRecoveryStage({ ...progress, recoveries: [first] }, atRetry)).toBe(2);
    expect(delegationRecoveryStage({
      ...progress,
      recoveries: [first, recovery(atRetry)],
    }, atRetry + DELEGATION_RETRY_MS * 10)).toBe(0);
  });

  it('does not interfere with squads that have no workers or terminal missions', () => {
    expect(delegationRecoveryStage({
      mission,
      expectedWorkers: 0,
      workerPanes: 0,
      tasks: 0,
      recoveries: [],
    }, Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(delegationRecoveryStage({
      mission: { ...mission, status: 'blocked' },
      expectedWorkers: 3,
      workerPanes: 0,
      tasks: 0,
      recoveries: [],
    }, Number.MAX_SAFE_INTEGER)).toBe(0);
  });
});
