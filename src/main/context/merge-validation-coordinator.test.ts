import { describe, expect, it, vi } from 'vitest';
import { MergeValidationCoordinator } from './merge-validation-coordinator';

describe('merge validation coordinator', () => {
  it('rejects a sensor result bound to another candidate before review', async () => {
    const contract = {
      contract: {
        missionId: 'mission-a', contractHash: 'c'.repeat(64),
        contextRevision: 'd'.repeat(64), requiredSensors: ['unit'],
      },
      author: { id: 'author', sessionId: 'session', provider: 'codex' },
    };
    const service = {
      scope: { projectId: 'project-a', checkoutId: 'checkout-a' },
      getMissionWorkflow: () => ({ contract, workflow: { stage: 'execution' } }),
      recordMergeSensorEvidence: vi.fn(),
      recordMergeReviewReport: vi.fn(),
      compileMissionSnapshot: () => ({ markdown: '# Context' }),
    } as never;
    const review = vi.fn();
    const coordinator = new MergeValidationCoordinator(service, {
      runSensor: async () => ({
        id: 'evidence-a', producer: 'nexus', projectId: 'project-a',
        checkoutId: 'checkout-a', missionId: 'mission-a', sensorId: 'unit',
        baseSha: 'a'.repeat(40), headSha: 'f'.repeat(40), diffHash: 'e'.repeat(64),
        contextHash: 'd'.repeat(64), contractHash: 'c'.repeat(64),
        sensorConfigHash: 's'.repeat(64), command: ['/usr/bin/true'], exitCode: 0,
        stdoutHash: '1'.repeat(64), stderrHash: '2'.repeat(64), timedOut: false,
        truncated: false, startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
      }),
      runReview: review,
    });

    await expect(coordinator.validate({
      phase: 'candidate',
      scope: {
        version: 1, installationId: 'install-a', projectId: 'project-a',
        checkoutId: 'checkout-a', rootRealPath: '/root', identitySource: 'manifest',
      },
      missionId: 'mission-a', taskId: 'task-a', taskKey: 'k'.repeat(64),
      checkoutPath: '/candidate', integrationBaseSha: 'a'.repeat(40),
      taskHeadSha: 'b'.repeat(40), candidateSha: 'b'.repeat(40),
      diffHash: 'e'.repeat(64), changedFiles: ['src/a.ts'],
    })).rejects.toThrow(/another candidate/i);
    expect(review).not.toHaveBeenCalled();
  });
});
