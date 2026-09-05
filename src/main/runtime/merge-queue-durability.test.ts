import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MergeCasError, MergeConflictError, MergeQueue, MergeValidationRejectedError } from './merge-queue';
import { createSignal, root, runtimeRoot, scope, queueState, gitRunner, worktrees, queue, git, write, commitTask, approved } from './merge-queue-test-fixture';

describe('MergeQueue', () => {


  it('rolls back a retried candidate when authority is revoked during validation', async () => {
    await commitTask(
      'mission-retry-revoked-during-validation',
      'task-retry-revoked-during-validation',
      'worker-retry-revoked-during-validation',
      'retry-revoked-during-validation.txt',
      'integrated but retry must remain blocked\n',
    );
    await expect(queue.enqueue({
      scope,
      missionId: 'mission-retry-revoked-during-validation',
      taskId: 'task-retry-revoked-during-validation',
      validate(context) {
        if (context.phase === 'post-integration') {
          return {
            sensorsPassed: false,
            reviewPassed: true,
            evidenceIds: ['retry-revoked-during-validation-rejection'],
          };
        }
        return approved(context);
      },
    })).rejects.toThrow(MergeValidationRejectedError);

    const blocked = queue.snapshot(scope);
    const validationStarted = createSignal('retry-recovery-validation-started');
    const resumeValidation = createSignal('retry-recovery-validation-resume');
    const finalize = vi.fn();
    let authorized = true;
    const retry = queue.retry({
      scope,
      missionId: 'mission-retry-revoked-during-validation',
      taskId: 'task-retry-revoked-during-validation',
      expectedStateRevision: blocked.revision,
      acknowledgement: {
        evidenceIds: ['retry-revoked-during-validation-new'],
      },
      assertCurrentAuthority: () => {
        if (!authorized) throw new Error('mission lifecycle authority revoked');
      },
      async validate(context) {
        if (context.phase === 'post-integration') {
          validationStarted.notify();
          await resumeValidation.wait();
        }
        return approved(context);
      },
      finalize,
    });

    await validationStarted.wait();
    authorized = false;
    resumeValidation.notify();
    await expect(retry).rejects.toThrow(/authority.*revoked/i);

    expect(finalize).not.toHaveBeenCalled();
    expect(queue.snapshot(scope)).toMatchObject({
      activeTaskKey: null,
      blocked: {
        errorName: 'MergeAuthorityRevokedError',
        disposition: 'terminal',
      },
      entries: [{
        status: 'blocked',
        attempt: 2,
        integratedSha: undefined,
      }],
    });
  });


  it('keeps the durable integration when finalizer fails so its receipt can be replayed', async () => {
    await commitTask(
      'mission-finalizer-retry',
      'task-finalizer-retry',
      'worker-finalizer-retry',
      'finalizer-retry.txt',
      'integrated but not finalized\n',
    );
    const failedFinalizer = vi.fn(async () => {
      throw new Error('simulated crash during mission finalization');
    });

    await expect(queue.enqueue({
      scope,
      missionId: 'mission-finalizer-retry',
      taskId: 'task-finalizer-retry',
      validate: approved,
      finalize: failedFinalizer,
    })).rejects.toThrow('simulated crash during mission finalization');

    const integrated = queue.snapshot(scope);
    expect(failedFinalizer).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(root, 'finalizer-retry.txt'), 'utf8')).toBe(
      'integrated but not finalized\n',
    );
    expect(integrated).toMatchObject({
      activeTaskKey: null,
      blocked: null,
      entries: [{
        status: 'integrated',
        integratedSha: git(root, 'rev-parse', 'HEAD'),
      }],
    });
  });


  it('never finalizes externally when the durable integrated transition fails and replays safely', async () => {
    await commitTask(
      'mission-complete-cas-retry',
      'task-complete-cas-retry',
      'worker-complete-cas-retry',
      'complete-cas-retry.txt',
      'persist before receipt\n',
    );
    const originalHead = git(root, 'rev-parse', 'HEAD');
    queueState.failIntegratedWrites();
    const forbiddenFinalizer = vi.fn(async () => {});

    await expect(queue.enqueue({
      scope,
      missionId: 'mission-complete-cas-retry',
      taskId: 'task-complete-cas-retry',
      validate: approved,
      finalize: forbiddenFinalizer,
    })).rejects.toThrow(/persistence CAS could not converge/i);

    expect(forbiddenFinalizer).not.toHaveBeenCalled();
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(fs.existsSync(path.join(root, 'complete-cas-retry.txt'))).toBe(false);
    expect(queue.snapshot(scope)).toMatchObject({
      activeTaskKey: null,
      blocked: {
        errorName: 'MergeQueuePersistenceError',
        disposition: 'retryable',
      },
      entries: [{ status: 'blocked', integratedSha: undefined }],
    });

    const recoveredFinalizer = vi.fn(async () => {});
    const result = await queue.retryRecoverable({
      scope,
      missionId: 'mission-complete-cas-retry',
      taskId: 'task-complete-cas-retry',
      validate: approved,
      finalize: recoveredFinalizer,
    });

    expect(recoveredFinalizer).toHaveBeenCalledOnce();
    expect(git(root, 'rev-parse', 'HEAD')).toBe(result.integratedSha);
    expect(queue.snapshot(scope)).toMatchObject({
      activeTaskKey: null,
      blocked: null,
      entries: [{ status: 'integrated', attempt: 2 }],
    });
  });


  it('recovers an unreadable completion state in the same process without stranding the active queue', async () => {
    await commitTask(
      'mission-complete-read-outage',
      'task-complete-read-outage',
      'worker-complete-read-outage',
      'complete-read-outage.txt',
      'recover without restart\n',
    );
    queueState.failIntegratedWritesThenReads();
    const forbiddenFinalizer = vi.fn(async () => {});

    await expect(queue.enqueue({
      scope,
      missionId: 'mission-complete-read-outage',
      taskId: 'task-complete-read-outage',
      validate: approved,
      finalize: forbiddenFinalizer,
    })).rejects.toThrow(/persistence read failed/i);

    expect(forbiddenFinalizer).not.toHaveBeenCalled();
    expect(fs.readFileSync(
      path.join(root, 'complete-read-outage.txt'),
      'utf8',
    )).toBe('recover without restart\n');
    expect(queue.snapshot(scope)).toMatchObject({
      activeTaskKey: expect.any(String),
      blocked: null,
      entries: [{ status: 'finalizing', integratedSha: expect.any(String) }],
    });

    await Promise.resolve();
    expect(queue.reconcileIfIdle(scope)).toMatchObject({
      action: 'blocked-interrupted',
      fromStatus: 'finalizing',
      integrationState: 'candidate-integrated',
    });
    const recoveredFinalizer = vi.fn(async () => {});
    await queue.retryRecoverable({
      scope,
      missionId: 'mission-complete-read-outage',
      taskId: 'task-complete-read-outage',
      validate: () => {
        throw new Error('finalization recovery must not rerun validation');
      },
      finalize: recoveredFinalizer,
    });

    expect(recoveredFinalizer).toHaveBeenCalledOnce();
    expect(queue.snapshot(scope)).toMatchObject({
      activeTaskKey: null,
      blocked: null,
      entries: [{ status: 'integrated', attempt: 2 }],
    });
  });


  it('durably integrates before an in-flight finalizer can be interrupted', async () => {
    await commitTask(
      'mission-finalizer-crash',
      'task-finalizer-crash',
      'worker-finalizer-crash',
      'finalizer-crash.txt',
      'validated before crash\n',
    );
    const finalizerStarted = createSignal('finalizer-started');
    const releaseInterruptedProcess = createSignal('release-interrupted-finalizer');
    const interrupted = queue.enqueue({
      scope,
      missionId: 'mission-finalizer-crash',
      taskId: 'task-finalizer-crash',
      validate: approved,
      finalize: async () => {
        finalizerStarted.notify();
        await releaseInterruptedProcess.wait();
      },
    });
    await finalizerStarted.wait();
    expect(queue.snapshot(scope).entries[0]).toMatchObject({
      status: 'integrated',
      integratedSha: expect.any(String),
      evidenceIds: expect.arrayContaining([
        expect.stringContaining('evidence-candidate-'),
        expect.stringContaining('evidence-post-integration-'),
      ]),
    });

    const restarted = new MergeQueue({
      runtimeRoot,
      stateStore: queueState,
      worktreeManager: worktrees,
      gitRunner,
    });
    expect(restarted.reconcile(scope)).toEqual({ action: 'none' });

    releaseInterruptedProcess.notify();
    await interrupted;
    expect(restarted.snapshot(scope)).toMatchObject({
      activeTaskKey: null,
      blocked: null,
      entries: [{ status: 'integrated', attempt: 1 }],
    });
  });


  it('blocks on a real merge conflict even when overlap had an explicit dependency', async () => {
    const first = await commitTask(
      'mission-a',
      'task-a',
      'worker-a',
      'shared.txt',
      'first\n',
    );
    await commitTask(
      'mission-a',
      'task-b',
      'worker-b',
      'shared.txt',
      'second\n',
      [{ missionId: 'mission-a', taskId: 'task-a' }],
    );

    const firstResult = await queue.enqueue({
      scope,
      missionId: 'mission-a',
      taskId: 'task-a',
      validate: async (context) => approved(context),
    });
    expect(firstResult.taskHeadSha).toBe(git(first.worktreePath, 'rev-parse', 'HEAD'));

    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-a',
        taskId: 'task-b',
        validate: async (context) => approved(context),
      }),
    ).rejects.toThrow(MergeConflictError);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(firstResult.integratedSha);
    expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe('first\n');
  });


  it('uses compare-and-swap semantics when integration HEAD moves during validation', async () => {
    await commitTask('mission-a', 'task-a', 'worker-a', 'task.txt', 'task\n');

    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-a',
        taskId: 'task-a',
        async validate(context) {
          if (context.phase === 'candidate') {
            write(root, 'external.txt', 'external\n');
            git(root, 'add', '.');
            git(root, 'commit', '-m', 'external advance');
          }
          return approved(context);
        },
      }),
    ).rejects.toThrow(MergeCasError);

    expect(fs.existsSync(path.join(root, 'task.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'external.txt'), 'utf8')).toBe(
      'external\n',
    );
    expect(queueState.read(worktrees.scopeKey(scope)).blocked).not.toBeNull();
  });
});
