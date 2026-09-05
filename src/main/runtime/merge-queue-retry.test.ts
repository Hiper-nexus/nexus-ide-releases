import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MergeCasError, MergeQueue, MergeRetryRequiredError, MergeValidationRejectedError } from './merge-queue';
import { GIT_INTEGRATION_TEST_TIMEOUT_MS, root, runtimeRoot, scope, queueState, gitRunner, worktrees, queue, git, write, commitTask, approved } from './merge-queue-test-fixture';

describe('MergeQueue', () => {


  it('retries a validation failure only with a new commit, revision, or evidence', async () => {
    await commitTask('mission-retry', 'task-retry', 'worker-retry', 'retry.txt', 'v1\n');
    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-retry',
        taskId: 'task-retry',
        validate: async () => ({
          sensorsPassed: false,
          reviewPassed: true,
          evidenceIds: ['rejected-v1'],
        }),
      }),
    ).rejects.toThrow(MergeValidationRejectedError);
    const blocked = queue.snapshot(scope);

    await expect(
      queue.retry({
        scope,
        missionId: 'mission-retry',
        taskId: 'task-retry',
        expectedStateRevision: blocked.revision,
        acknowledgement: {},
        validate: approved,
      }),
    ).rejects.toThrow(MergeRetryRequiredError);
    await expect(
      queue.retry({
        scope,
        missionId: 'mission-retry',
        taskId: 'task-retry',
        expectedStateRevision: blocked.revision,
        acknowledgement: { evidenceIds: ['rejected-v1'] },
        validate: approved,
      }),
    ).rejects.toThrow(MergeRetryRequiredError);
    await expect(
      queue.retry({
        scope,
        missionId: 'mission-retry',
        taskId: 'task-retry',
        expectedStateRevision: blocked.revision - 1,
        acknowledgement: { evidenceIds: ['review-evidence-v2'] },
        validate: approved,
      }),
    ).rejects.toThrow(MergeCasError);

    const result = await queue.retry({
      scope,
      missionId: 'mission-retry',
      taskId: 'task-retry',
      expectedStateRevision: blocked.revision,
      acknowledgement: { evidenceIds: ['review-evidence-v2'] },
      validate: approved,
    });

    expect(result.integratedSha).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(queue.snapshot(scope).events.map((event) => event.type)).toEqual([
      'blocked',
      'retry-acknowledged',
      'integrated',
    ]);
  });


  it('lets the scheduler integrate a corrective worker commit from a repair block', async () => {
    const assignment = await commitTask(
      'mission-commit-retry',
      'task-commit-retry',
      'worker-commit-retry',
      'commit-retry.txt',
      'v1\n',
    );
    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-commit-retry',
        taskId: 'task-commit-retry',
        validate: async () => ({
          sensorsPassed: false,
          reviewPassed: true,
          evidenceIds: ['rejected-v1'],
        }),
      }),
    ).rejects.toThrow(MergeValidationRejectedError);
    write(assignment.worktreePath, 'commit-retry.txt', 'v2\n');
    git(assignment.worktreePath, 'add', '.');
    git(assignment.worktreePath, 'commit', '-m', 'fix validation');
    const result = await queue.retryRecoverable({
      scope,
      missionId: 'mission-commit-retry',
      taskId: 'task-commit-retry',
      validate: approved,
    });
    expect(result.integratedSha).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(root, 'commit-retry.txt'), 'utf8')).toBe(
      'v2\n',
    );
    expect(queue.snapshot(scope)).toMatchObject({
      blocked: null,
      entries: [{ status: 'integrated', attempt: 2 }],
    });
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);


  it('keeps retry recovery pinned to the newly accepted physical handoff HEAD', async () => {
    const assignment = await commitTask(
      'mission-retry-pin',
      'task-retry-pin',
      'worker-retry-pin',
      'retry-pin.txt',
      'W\n',
    );
    const firstHandoffHead = git(
      assignment.worktreePath,
      'rev-parse',
      'HEAD',
    );
    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-retry-pin',
        taskId: 'task-retry-pin',
        expectedTaskHeadSha: firstHandoffHead,
        validate: () => ({
          sensorsPassed: false,
          reviewPassed: true,
          evidenceIds: ['rejected-W'],
        }),
      }),
    ).rejects.toThrow(MergeValidationRejectedError);

    write(assignment.worktreePath, 'retry-pin.txt', 'W2\n');
    git(assignment.worktreePath, 'add', '.');
    git(assignment.worktreePath, 'commit', '-m', 'repair after first handoff');
    const secondHandoffHead = git(
      assignment.worktreePath,
      'rev-parse',
      'HEAD',
    );
    const blockedBeforeStaleRetry = queue.snapshot(scope);
    const staleValidate = vi.fn(approved);

    await expect(
      queue.retryRecoverable({
        scope,
        missionId: 'mission-retry-pin',
        taskId: 'task-retry-pin',
        expectedTaskHeadSha: firstHandoffHead,
        validate: staleValidate,
      }),
    ).rejects.toThrow(/retry task HEAD.*physical handoff/i);

    expect(staleValidate).not.toHaveBeenCalled();
    expect(queue.snapshot(scope)).toEqual(blockedBeforeStaleRetry);

    await expect(
      queue.retryRecoverable({
        scope,
        missionId: 'mission-retry-pin',
        taskId: 'task-retry-pin',
        expectedTaskHeadSha: secondHandoffHead,
        validate: approved,
      }),
    ).resolves.toMatchObject({
      taskHeadSha: secondHandoffHead,
      integratedSha: expect.any(String),
    });
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);


  it.each(['candidate-validating', 'integrating'] as const)(
    'reconciles an interrupted %s attempt into an automatically retryable block',
    async (status) => {
      await commitTask(
        `mission-restart-${status}`,
        `task-restart-${status}`,
        `worker-restart-${status}`,
        `${status}.txt`,
        `${status}\n`,
      );
      const prepared = worktrees.prepareIntegration(
        scope,
        `mission-restart-${status}`,
        `task-restart-${status}`,
      );
      worktrees.markQueued(
        scope,
        prepared.record.missionId,
        prepared.record.taskId,
        prepared.taskHeadSha,
      );
      const scopeKey = worktrees.scopeKey(scope);
      queueState.overwrite(scopeKey, {
        revision: 4,
        activeTaskKey: prepared.record.taskKey,
        blocked: null,
        events: [],
        entries: [{
          id: `merge-${prepared.record.taskKey}`,
          taskKey: prepared.record.taskKey,
          missionId: prepared.record.missionId,
          taskId: prepared.record.taskId,
          attempt: 1,
          status,
          taskHeadSha: prepared.taskHeadSha,
          integrationBaseSha: git(root, 'rev-parse', 'HEAD'),
          ...(status === 'integrating'
            ? {
                candidateSha: prepared.taskHeadSha,
                evidenceIds: ['candidate-evidence'],
              }
            : { evidenceIds: [] }),
          diffHash: prepared.diffHash,
          createdAt: 1,
          updatedAt: 2,
        }],
      });
      const restarted = new MergeQueue({
        runtimeRoot,
        stateStore: queueState,
        worktreeManager: worktrees,
        gitRunner,
        now: () => 1_700_000_000_100,
      });

      expect(restarted.reconcile(scope)).toMatchObject({
        action: 'blocked-interrupted',
        fromStatus: status,
      });
      const recovered = restarted.snapshot(scope);
      expect(recovered.activeTaskKey).toBeNull();
      expect(recovered.blocked).toMatchObject({
        taskKey: prepared.record.taskKey,
        disposition: 'retryable',
      });
      expect(recovered.entries[0]?.status).toBe('blocked');
      expect(recovered.events.at(-1)?.type).toBe('restart-reconciled');
      expect(git(root, 'rev-parse', 'HEAD')).toBe(prepared.record.baseSha);
      await restarted.retryRecoverable({
        scope,
        missionId: prepared.record.missionId,
        taskId: prepared.record.taskId,
        validate: approved,
      });
      expect(restarted.snapshot(scope)).toMatchObject({
        activeTaskKey: null,
        blocked: null,
        entries: [{ status: 'integrated', attempt: 2 }],
      });
    },
  );


  it('records an exact integrated ref without trusting an interrupted dirty checkout', async () => {
    await commitTask(
      'mission-ref-restart',
      'task-ref-restart',
      'worker-ref-restart',
      'ref-restart.txt',
      'candidate\n',
    );
    const prepared = worktrees.prepareIntegration(
      scope,
      'mission-ref-restart',
      'task-ref-restart',
    );
    worktrees.markQueued(
      scope,
      prepared.record.missionId,
      prepared.record.taskId,
      prepared.taskHeadSha,
    );
    const baseSha = git(root, 'rev-parse', 'HEAD');
    const scopeKey = worktrees.scopeKey(scope);
    queueState.overwrite(scopeKey, {
      revision: 4,
      activeTaskKey: prepared.record.taskKey,
      blocked: null,
      events: [],
      entries: [{
        id: `merge-${prepared.record.taskKey}`,
        taskKey: prepared.record.taskKey,
        missionId: prepared.record.missionId,
        taskId: prepared.record.taskId,
        attempt: 1,
        status: 'integrating',
        taskHeadSha: prepared.taskHeadSha,
        integrationBaseSha: baseSha,
        candidateSha: prepared.taskHeadSha,
        diffHash: prepared.diffHash,
        evidenceIds: ['candidate-evidence'],
        createdAt: 1,
        updatedAt: 2,
      }],
    });
    git(root, 'update-ref', 'refs/heads/main', prepared.taskHeadSha, baseSha);
    expect(git(root, 'status', '--porcelain')).not.toBe('');
    const restarted = new MergeQueue({
      runtimeRoot,
      stateStore: queueState,
      worktreeManager: worktrees,
      gitRunner,
    });

    expect(restarted.reconcile(scope)).toMatchObject({
      integrationState: 'candidate-integrated',
    });
    const blocked = restarted.snapshot(scope);
    expect(blocked.blocked?.disposition).toBe('retryable');
    expect(blocked.entries[0]?.integratedSha).toBe(prepared.taskHeadSha);
    await expect(restarted.retry({
      scope,
      missionId: prepared.record.missionId,
      taskId: prepared.record.taskId,
      expectedStateRevision: blocked.revision,
      acknowledgement: { evidenceIds: ['checkout-repaired-evidence'] },
      validate: approved,
    })).rejects.toThrow(MergeCasError);
    expect(restarted.snapshot(scope).blocked).not.toBeNull();
  });


  it('reconciles post-validation after restart and only finalizes after new evidence', async () => {
    await commitTask(
      'mission-post-restart',
      'task-post-restart',
      'worker-post-restart',
      'post-restart.txt',
      'integrated\n',
    );
    let releasePost: (() => void) | undefined;
    let signalPost: (() => void) | undefined;
    const postStarted = new Promise<void>((resolve) => {
      signalPost = resolve;
    });
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const interrupted = queue.enqueue({
      scope,
      missionId: 'mission-post-restart',
      taskId: 'task-post-restart',
      async validate(context) {
        if (context.phase === 'post-integration') {
          signalPost?.();
          await postGate;
        }
        return approved(context);
      },
    });
    const interruptedResult = interrupted.catch((error: unknown) => error);
    await postStarted;
    const integratedHead = git(root, 'rev-parse', 'HEAD');
    const restarted = new MergeQueue({
      runtimeRoot,
      stateStore: queueState,
      worktreeManager: worktrees,
      gitRunner,
      now: () => 1_700_000_000_100,
    });

    expect(restarted.reconcile(scope)).toMatchObject({
      action: 'blocked-interrupted',
      fromStatus: 'post-validating',
      integrationState: 'candidate-integrated',
    });
    const blocked = restarted.snapshot(scope);
    expect(blocked.blocked?.disposition).toBe('retryable');
    const updateRefsBeforeRetry = gitRunner.calls.filter(
      (call) => call.args[0] === 'update-ref',
    ).length;
    const recovered = await restarted.retryRecoverable({
      scope,
      missionId: 'mission-post-restart',
      taskId: 'task-post-restart',
      validate: approved,
    });
    releasePost?.();
    await interruptedResult;

    expect(recovered.integratedSha).toBe(integratedHead);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(integratedHead);
    expect(gitRunner.calls.filter(
      (call) => call.args[0] === 'update-ref',
    )).toHaveLength(updateRefsBeforeRetry);
    expect(restarted.snapshot(scope).events.map((event) => event.type)).toContain(
      'retry-acknowledged',
    );
    expect(restarted.snapshot(scope)).toMatchObject({
      blocked: null,
      entries: [{ status: 'integrated', attempt: 2 }],
    });
    expect(worktrees.get(
      scope,
      'mission-post-restart',
      'task-post-restart',
    )?.status).toBe('integrated');
  });


  it('does not acknowledge a retry after mission authority was revoked', async () => {
    await commitTask(
      'mission-retry-revoked-before-ack',
      'task-retry-revoked-before-ack',
      'worker-retry-revoked-before-ack',
      'retry-revoked-before-ack.txt',
      'integrated but rejected\n',
    );
    await expect(queue.enqueue({
      scope,
      missionId: 'mission-retry-revoked-before-ack',
      taskId: 'task-retry-revoked-before-ack',
      validate(context) {
        if (context.phase === 'post-integration') {
          return {
            sensorsPassed: false,
            reviewPassed: true,
            evidenceIds: ['retry-revoked-before-ack-rejection'],
          };
        }
        return approved(context);
      },
    })).rejects.toThrow(MergeValidationRejectedError);

    const blocked = queue.snapshot(scope);
    await expect(queue.retry({
      scope,
      missionId: 'mission-retry-revoked-before-ack',
      taskId: 'task-retry-revoked-before-ack',
      expectedStateRevision: blocked.revision,
      acknowledgement: { evidenceIds: ['retry-revoked-before-ack-new'] },
      assertCurrentAuthority: () => {
        throw new Error('mission lifecycle authority revoked');
      },
      validate: approved,
    })).rejects.toThrow(/authority.*revoked/i);

    expect(queue.snapshot(scope)).toEqual(blocked);
    expect(queue.snapshot(scope).events).not.toContainEqual(
      expect.objectContaining({ type: 'retry-acknowledged' }),
    );
  });
});
