import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MergeCasError, MergeQueue, MergeQueueStateError, MergeValidationRejectedError, type MergeQueueStateStore } from './merge-queue';
import { createSignal, root, runtimeRoot, scope, queueState, gitRunner, worktrees, queue, git, write, commitTask, approved, queueEntries } from './merge-queue-test-fixture';

describe('MergeQueue', () => {


  it('invalidates approval when the worker branch changes after candidate validation', async () => {
    const assignment = await commitTask(
      'mission-a',
      'task-a',
      'worker-a',
      'task.txt',
      'task v1\n',
    );
    const originalHead = git(root, 'rev-parse', 'HEAD');

    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-a',
        taskId: 'task-a',
        async validate(context) {
          if (context.phase === 'candidate') {
            write(assignment.worktreePath, 'task.txt', 'task v2\n');
            git(assignment.worktreePath, 'add', '.');
            git(assignment.worktreePath, 'commit', '-m', 'mutate after review');
          }
          return approved(context);
        },
      }),
    ).rejects.toThrow(MergeCasError);

    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(fs.existsSync(path.join(root, 'task.txt'))).toBe(false);
  });


  it('rejects a task HEAD newer than the physical handoff before validation or Git integration effects', async () => {
    const assignment = await commitTask(
      'mission-handoff-pin',
      'task-handoff-pin',
      'worker-handoff-pin',
      'pinned.txt',
      'handoff W\n',
    );
    const handoffHeadSha = git(assignment.worktreePath, 'rev-parse', 'HEAD');
    write(assignment.worktreePath, 'pinned.txt', 'late W2\n');
    git(assignment.worktreePath, 'add', '.');
    git(assignment.worktreePath, 'commit', '-m', 'late commit after handoff');
    const validate = vi.fn(approved);
    const integrationHeadSha = git(root, 'rev-parse', 'HEAD');

    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-handoff-pin',
        taskId: 'task-handoff-pin',
        expectedTaskHeadSha: handoffHeadSha,
        validate,
      }),
    ).rejects.toThrow(/task HEAD.*physical handoff/i);

    expect(validate).not.toHaveBeenCalled();
    expect(git(root, 'rev-parse', 'HEAD')).toBe(integrationHeadSha);
    expect(
      gitRunner.calls.some((call) => call.args[0] === 'merge-tree'),
    ).toBe(false);
    expect(
      worktrees.get(scope, 'mission-handoff-pin', 'task-handoff-pin'),
    ).not.toMatchObject({ status: 'queued' });
  });


  it('rolls back post-integration findings and preserves the worktree for repair', async () => {
    await commitTask('mission-a', 'task-a', 'worker-a', 'post.txt', 'integrated\n');
    const originalHead = git(root, 'rev-parse', 'HEAD');

    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-a',
        taskId: 'task-a',
        async validate(context) {
          if (context.phase === 'post-integration') {
            return {
              sensorsPassed: false,
              reviewPassed: true,
              evidenceIds: ['post-failure'],
            };
          }
          return approved(context);
        },
      }),
    ).rejects.toThrow(MergeValidationRejectedError);

    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(fs.existsSync(path.join(root, 'post.txt'))).toBe(false);
    expect(queueState.read(worktrees.scopeKey(scope)).blocked).toMatchObject({
      disposition: 'repair',
    });
    const repairedWorktree = worktrees.get(scope, 'mission-a', 'task-a');
    expect(repairedWorktree).toMatchObject({ status: 'queued' });
    expect(repairedWorktree).not.toHaveProperty('integratedSha');
  });


  it('rolls back a technical post-integration failure and retries without a wizard', async () => {
    await commitTask(
      'mission-technical',
      'task-technical',
      'worker-technical',
      'technical.txt',
      'retry me\n',
    );
    const originalHead = git(root, 'rev-parse', 'HEAD');
    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-technical',
        taskId: 'task-technical',
        validate: (context) => {
          if (context.phase === 'post-integration') {
            throw new Error('reviewer timed out');
          }
          return approved(context);
        },
      }),
    ).rejects.toThrow('reviewer timed out');

    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(queue.snapshot(scope).blocked).toMatchObject({
      disposition: 'retryable',
    });
    const result = await queue.retryRecoverable({
      scope,
      missionId: 'mission-technical',
      taskId: 'task-technical',
      validate: approved,
    });
    expect(result.integratedSha).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(root, 'technical.txt'), 'utf8')).toBe(
      'retry me\n',
    );
  });


  it('rolls back the exact candidate when mission authority is revoked during post-integration validation', async () => {
    await commitTask(
      'mission-revoked',
      'task-revoked',
      'worker-revoked',
      'revoked.txt',
      'must be rolled back\n',
    );
    const originalHead = git(root, 'rev-parse', 'HEAD');
    const postValidationStarted = createSignal('post-validation-started');
    const resumePostValidation = createSignal('resume-post-validation');
    let authorized = true;
    const finalize = vi.fn();

    const attempt = queue.enqueue({
      scope,
      missionId: 'mission-revoked',
      taskId: 'task-revoked',
      assertCurrentAuthority: () => {
        if (!authorized) throw new Error('mission lifecycle authority revoked');
      },
      async validate(context) {
        if (context.phase === 'post-integration') {
          postValidationStarted.notify();
          await resumePostValidation.wait();
        }
        return approved(context);
      },
      finalize,
    });

    await postValidationStarted.wait();
    expect(git(root, 'rev-parse', 'HEAD')).not.toBe(originalHead);
    expect(fs.existsSync(path.join(root, 'revoked.txt'))).toBe(true);

    authorized = false;
    resumePostValidation.notify();

    await expect(attempt).rejects.toThrow(/authority.*revoked/i);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(fs.existsSync(path.join(root, 'revoked.txt'))).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
    expect(queueEntries().at(-1)).toMatchObject({
      status: 'blocked',
      integratedSha: undefined,
    });
    expect(queue.snapshot(scope).events.at(-1)).toMatchObject({
      type: 'blocked',
      integrationState: 'not-integrated',
    });
    const failedWorktree = worktrees.get(
      scope,
      'mission-revoked',
      'task-revoked',
    );
    expect(failedWorktree).toMatchObject({ status: 'failed' });
    expect(failedWorktree).not.toHaveProperty('integratedSha');
  });


  it('requires injected durable queue state instead of an implicit memory fallback', async () => {
    expect(() =>
      new MergeQueue({
        runtimeRoot,
        stateStore: undefined as unknown as MergeQueueStateStore,
        worktreeManager: worktrees,
      }),
    ).toThrow(/state store/i);
  });


  it('fails closed when durable queue state is structurally inconsistent', async () => {
    await commitTask('mission-state', 'task-state', 'worker-state', 'state.txt', 'state\n');
    const originalHead = git(root, 'rev-parse', 'HEAD');
    const scopeKey = worktrees.scopeKey(scope);
    queueState.overwrite(scopeKey, {
      revision: 1,
      activeTaskKey: null,
      blocked: null,
      events: [],
      entries: [
        {
          id: 'merge-tampered',
          taskKey: '0'.repeat(64),
          missionId: 'mission-state',
          taskId: 'task-state',
          attempt: 1,
          status: 'integrated',
          taskHeadSha: originalHead,
          integrationBaseSha: originalHead,
          candidateSha: originalHead,
          integratedSha: originalHead,
          diffHash: '0'.repeat(64),
          evidenceIds: ['forged-evidence'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-state',
        taskId: 'task-state',
        validate: approved,
      }),
    ).rejects.toThrow(MergeQueueStateError);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
  });
});
