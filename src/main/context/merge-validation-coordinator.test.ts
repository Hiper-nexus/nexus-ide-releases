import { describe, expect, it, vi } from 'vitest';
import { MergeValidationCoordinator } from './merge-validation-coordinator';
import type { MergeValidationContext } from '../runtime/merge-queue';
import type { TrustedEvidence } from './sensor-broker';
import type { RunAutomatedReviewInput } from './cli-automated-reviewer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function validationContext(
  overrides: Partial<MergeValidationContext> = {},
): MergeValidationContext {
  return {
    phase: 'candidate',
    scope: {
      version: 1,
      installationId: 'install-a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: '/root',
      identitySource: 'manifest',
    },
    missionId: 'mission-a',
    taskId: 'task-a',
    taskKey: 'k'.repeat(64),
    checkoutPath: '/candidate',
    integrationBaseSha: 'a'.repeat(40),
    taskHeadSha: 'b'.repeat(40),
    candidateSha: 'b'.repeat(40),
    diffHash: 'e'.repeat(64),
    changedFiles: ['src/a.ts'],
    ...overrides,
  };
}

function evidence(
  overrides: Partial<TrustedEvidence> = {},
): TrustedEvidence {
  return {
    id: 'evidence-a',
    producer: 'nexus',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    missionId: 'mission-a',
    sensorId: 'unit',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diffHash: 'e'.repeat(64),
    contextHash: 'd'.repeat(64),
    contractHash: 'c'.repeat(64),
    sensorConfigHash: 's'.repeat(64),
    command: ['/usr/bin/true'],
    exitCode: 0,
    stdoutHash: '1'.repeat(64),
    stderrHash: '2'.repeat(64),
    timedOut: false,
    truncated: false,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    ...overrides,
  };
}

describe('merge validation coordinator', () => {
  it('keeps the merge boundary on the same frozen execution precondition as the guided scheduler', async () => {
    const runSensor = vi.fn();
    const runReview = vi.fn();
    const service = {
      scope: { projectId: 'project-a', checkoutId: 'checkout-a' },
      getMissionWorkflow: vi
        .fn()
        .mockReturnValueOnce({ contract: null, workflow: null })
        .mockReturnValueOnce({
          contract: { contract: {} },
          workflow: { stage: 'review-primary' },
        }),
    } as never;
    const coordinator = new MergeValidationCoordinator(service, {
      runSensor,
      runReview,
    });

    await expect(
      coordinator.validate(validationContext()),
    ).rejects.toThrow(/no frozen workflow/i);
    await expect(
      coordinator.validate(validationContext()),
    ).rejects.toThrow(/only during execution/i);
    expect(runSensor).not.toHaveBeenCalled();
    expect(runReview).not.toHaveBeenCalled();
  });

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
      runSensor: async () => evidence({ headSha: 'f'.repeat(40) }),
      runReview: review,
    });

    await expect(
      coordinator.validate(validationContext()),
    ).rejects.toThrow(/another candidate/i);
    expect(review).not.toHaveBeenCalled();
  });

  it('does not persist sensor evidence after authority is revoked during the sensor await', async () => {
    const sensorResult = deferred<TrustedEvidence>();
    const recordMergeSensorEvidence = vi.fn();
    const recordMergeReviewReport = vi.fn();
    const runSensor = vi.fn(() => sensorResult.promise);
    const runReview = vi.fn();
    const contract = {
      contract: {
        missionId: 'mission-a',
        contractHash: 'c'.repeat(64),
        contextRevision: 'd'.repeat(64),
        requiredSensors: ['unit'],
      },
      author: { id: 'author', sessionId: 'session', provider: 'codex' },
    };
    const service = {
      scope: { projectId: 'project-a', checkoutId: 'checkout-a' },
      getMissionWorkflow: () => ({
        contract,
        workflow: { stage: 'execution' },
      }),
      recordMergeSensorEvidence,
      recordMergeReviewReport,
      compileMissionSnapshot: () => ({ markdown: '# Context' }),
    } as never;
    const coordinator = new MergeValidationCoordinator(service, {
      runSensor,
      runReview,
    });
    const controller = new AbortController();
    let revoked = false;
    const assertCurrentAuthority = vi.fn(() => {
      if (revoked) throw new Error('merge authority revoked');
    });

    const running = coordinator.validate(validationContext({
      signal: controller.signal,
      assertCurrentAuthority,
    }));
    await vi.waitFor(() => expect(runSensor).toHaveBeenCalledOnce());
    revoked = true;
    controller.abort();
    sensorResult.resolve(evidence());

    await expect(running).rejects.toThrow(/authority revoked/i);
    expect(recordMergeSensorEvidence).not.toHaveBeenCalled();
    expect(recordMergeReviewReport).not.toHaveBeenCalled();
    expect(runReview).not.toHaveBeenCalled();
    expect(runSensor).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ sensorId: 'unit' }),
      expect.objectContaining({
        signal: controller.signal,
        assertCurrentAuthority,
      }),
    );
  });

  it('checks authority inside the review persistence callback', async () => {
    const recordMergeSensorEvidence = vi.fn();
    const recordMergeReviewReport = vi.fn();
    let revoked = false;
    const assertCurrentAuthority = vi.fn(() => {
      if (revoked) throw new Error('merge authority revoked');
    });
    const contract = {
      contract: {
        missionId: 'mission-a',
        contractHash: 'c'.repeat(64),
        contextRevision: 'd'.repeat(64),
        requiredSensors: [],
      },
      author: { id: 'author', sessionId: 'session', provider: 'codex' },
    };
    const service = {
      scope: { projectId: 'project-a', checkoutId: 'checkout-a' },
      getMissionWorkflow: () => ({
        contract,
        workflow: { stage: 'execution' },
      }),
      recordMergeSensorEvidence,
      recordMergeReviewReport,
      compileMissionSnapshot: () => ({ markdown: '# Context' }),
    } as never;
    const runReview = vi.fn(async (input: RunAutomatedReviewInput) => {
      revoked = true;
      input.persist({} as never);
      return {
        ready: true,
        gate: {
          ready: true,
          reason: 'ready' as const,
          blockingFindingCount: 0,
          reportCount: 1,
        },
        reports: [],
        evidenceIds: [],
      };
    });
    const coordinator = new MergeValidationCoordinator(service, {
      runReview,
      resolveAuthor: () => ({
        id: 'author',
        sessionId: 'session',
        provider: 'codex',
      }),
    });

    await expect(
      coordinator.validate(validationContext({ assertCurrentAuthority })),
    ).rejects.toThrow(/authority revoked/i);
    expect(recordMergeSensorEvidence).not.toHaveBeenCalled();
    expect(recordMergeReviewReport).not.toHaveBeenCalled();
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({ assertCurrentAuthority }),
    );
  });
});
