import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { MergeOperationAbortedError, MergeQueueBlockedError, MergeValidationRejectedError, type MergeValidationContext } from './merge-queue';
import { GIT_INTEGRATION_TEST_TIMEOUT_MS, createSignal, tempDir, root, scope, queueState, gitRunner, worktrees, queue, git, write, commitTask, approved, queueEntries } from './merge-queue-test-fixture';

describe('MergeQueue', () => {


  it.runIf(process.platform === 'darwin')(
    'materializes ignored dependencies in the detached validation candidate',
    async () => {
      await commitTask(
        'mission-deps',
        'task-deps',
        'worker-deps',
        'feature-deps.txt',
        'feature\n',
      );
      write(root, 'node_modules/.bin/nexus-test-tool', '#!/bin/sh\nexit 0\n');

      await queue.enqueue({
        scope,
        missionId: 'mission-deps',
        taskId: 'task-deps',
        async validate(context) {
          if (context.phase === 'candidate') {
            expect(
              fs.existsSync(
                path.join(
                  context.checkoutPath,
                  'node_modules/.bin/nexus-test-tool',
                ),
              ),
            ).toBe(true);
            expect(git(context.checkoutPath, 'status', '--porcelain')).toBe('');
          }
          return approved(context);
        },
      });
    },
  );

  it('validates a detached candidate before an exact fast-forward and revalidates after', async () => {
    await commitTask(
      'mission-a',
      'task-a',
      'worker-a',
      'feature-a.txt',
      'feature A\n',
    );
    const originalHead = git(root, 'rev-parse', 'HEAD');
    const phases: string[] = [];

    const result = await queue.enqueue({
      scope,
      missionId: 'mission-a',
      taskId: 'task-a',
      async validate(context) {
        phases.push(context.phase);
        if (context.phase === 'candidate') {
          expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
          expect(context.checkoutPath).not.toBe(root);
          expect(git(context.checkoutPath, 'rev-parse', 'HEAD')).toBe(
            context.candidateSha,
          );
        } else {
          expect(context.checkoutPath).toBe(fs.realpathSync(root));
          expect(git(root, 'rev-parse', 'HEAD')).toBe(context.candidateSha);
        }
        return approved(context);
      },
    });

    expect(phases).toEqual(['candidate', 'post-integration']);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(result.integratedSha);
    expect(fs.readFileSync(path.join(root, 'feature-a.txt'), 'utf8')).toBe(
      'feature A\n',
    );
    expect(queueEntries().at(-1)?.status).toBe('integrated');
    expect(queueEntries().at(-1)?.diffHash).toBe(result.diffHash);
    expect(
      gitRunner.calls.some((call) =>
        call.args.some((arg) => arg === '--force' || arg === '-f' || arg === '--hard'),
      ),
    ).toBe(false);
  });


  it('serializes concurrent requests so the second candidate includes the first', async () => {
    await commitTask('mission-a', 'task-a', 'worker-a', 'a.txt', 'A\n');
    await commitTask('mission-a', 'task-b', 'worker-b', 'b.txt', 'B\n');
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondCandidateStarted = false;
    const firstCandidate = createSignal('firstCandidateStarted');

    const first = queue.enqueue({
      scope,
      missionId: 'mission-a',
      taskId: 'task-a',
      async validate(context) {
        if (context.phase === 'candidate') {
          firstCandidate.notify();
          await firstGate;
        }
        return approved(context);
      },
    });
    const second = queue.enqueue({
      scope,
      missionId: 'mission-a',
      taskId: 'task-b',
      async validate(context) {
        if (context.phase === 'candidate') secondCandidateStarted = true;
        return approved(context);
      },
    });

    // Signal when first candidate validation starts (no fixed sleep / poll).
    // While the first holds the gate, the queue must not start the second.
    await firstCandidate.wait();
    expect(firstCandidate.notified()).toBe(true);
    expect(secondCandidateStarted).toBe(false);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(secondCandidateStarted).toBe(true);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('A\n');
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('B\n');
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);


  it('cancels a queued merge immediately without claim, callback, listener leak, or serialization bypass', async () => {
    await commitTask('mission-a', 'task-a', 'worker-a', 'a.txt', 'A\n');
    await commitTask('mission-a', 'task-b', 'worker-b', 'b.txt', 'B\n');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstCandidate = createSignal('abortedQueueFirstCandidate');
    const secondValidate = vi.fn((context: MergeValidationContext) =>
      approved(context),
    );
    const secondController = new AbortController();
    const reason = new Error('scheduler stopped before queued merge');
    const secondSettled = createSignal('queuedAbortSettled', 250);
    const replacementController = new AbortController();
    const replacementStarted = createSignal('replacementStarted');
    let secondError: unknown;
    let replacement: Promise<unknown> | null = null;
    const first = queue.enqueue({
      scope,
      missionId: 'mission-a',
      taskId: 'task-a',
      async validate(context) {
        if (context.phase === 'candidate') {
          firstCandidate.notify();
          await firstGate;
        }
        return approved(context);
      },
    });
    const second = queue.enqueue({
      scope,
      missionId: 'mission-a',
      taskId: 'task-b',
      signal: secondController.signal,
      validate: secondValidate,
    });
    void second.catch((error: unknown) => {
      secondError = error;
      secondSettled.notify();
    });

    try {
      await firstCandidate.wait();
      expect(getEventListeners(secondController.signal, 'abort')).toHaveLength(1);

      secondController.abort(reason);
      await secondSettled.wait();

      expect(secondError).toBeInstanceOf(MergeOperationAbortedError);
      expect((secondError as Error & { cause?: unknown }).cause).toBe(reason);
      expect(getEventListeners(secondController.signal, 'abort')).toHaveLength(0);
      expect(secondValidate).not.toHaveBeenCalled();
      const waitingSnapshot = queue.snapshot(scope);
      expect(waitingSnapshot.activeTaskKey).toBe(
        waitingSnapshot.entries[0]?.taskKey,
      );
      expect(waitingSnapshot).toMatchObject({
        blocked: null,
        entries: [{
          missionId: 'mission-a',
          taskId: 'task-a',
          status: 'candidate-validating',
        }],
      });

      replacement = queue.enqueue({
        scope,
        missionId: 'mission-a',
        taskId: 'task-b',
        signal: replacementController.signal,
        validate(context) {
          if (context.phase === 'candidate') {
            expect(
              getEventListeners(replacementController.signal, 'abort'),
            ).toHaveLength(0);
            replacementStarted.notify();
          }
          return approved(context);
        },
      });
      expect(
        getEventListeners(replacementController.signal, 'abort'),
      ).toHaveLength(1);
      expect(replacementStarted.notified()).toBe(false);

      releaseFirst();
      await Promise.all([first, replacement]);

      expect(replacementStarted.notified()).toBe(true);
      expect(
        getEventListeners(replacementController.signal, 'abort'),
      ).toHaveLength(0);
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('A\n');
      expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('B\n');
    } finally {
      releaseFirst();
      await Promise.allSettled([
        first,
        second,
        ...(replacement ? [replacement] : []),
      ]);
    }
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);


  it('rolls back an in-flight cancellation as a recoverable merge attempt', async () => {
    await commitTask(
      'mission-abort',
      'task-abort',
      'worker-abort',
      'abort.txt',
      'retry safely\n',
    );
    const originalHead = git(root, 'rev-parse', 'HEAD');
    const controller = new AbortController();
    const reason = new Error('reconciler stopped during merge');
    const attempt = queue.enqueue({
      scope,
      missionId: 'mission-abort',
      taskId: 'task-abort',
      signal: controller.signal,
      validate(context) {
        if (context.phase === 'candidate') controller.abort(reason);
        return approved(context);
      },
    });

    await expect(attempt).rejects.toThrow(
      /operation aborted.*reconciler stopped during merge/i,
    );
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(fs.existsSync(path.join(root, 'abort.txt'))).toBe(false);
    expect(queue.snapshot(scope).blocked).toMatchObject({
      disposition: 'retryable',
    });

    await expect(
      queue.retryRecoverable({
        scope,
        missionId: 'mission-abort',
        taskId: 'task-abort',
        validate: approved,
      }),
    ).resolves.toMatchObject({
      integratedSha: expect.any(String),
    });
    expect(fs.readFileSync(path.join(root, 'abort.txt'), 'utf8')).toBe(
      'retry safely\n',
    );
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);


  it('keeps merge serialization scoped so independent projects can validate concurrently', async () => {
    await commitTask('mission-a', 'task-a', 'worker-a', 'a.txt', 'A\n');
    const secondRoot = path.join(tempDir, 'repo-two');
    fs.mkdirSync(secondRoot, { recursive: true });
    git(secondRoot, 'init', '-b', 'main');
    git(secondRoot, 'config', 'user.name', 'Nexus Test');
    git(secondRoot, 'config', 'user.email', 'nexus@example.test');
    write(secondRoot, 'base.txt', 'base\n');
    git(secondRoot, 'add', '.');
    git(secondRoot, 'commit', '-m', 'initial');
    const secondScope: ProjectExecutionScope = {
      ...scope,
      projectId: '22222222-2222-4222-8222-222222222222',
      checkoutId: 'checkout-merge-test-two',
      rootRealPath: fs.realpathSync(secondRoot),
    };
    const secondTask = await worktrees.create({
      scope: secondScope,
      missionId: 'mission-b',
      taskId: 'task-b',
      workerId: 'worker-b',
      ownership: { files: ['b.txt'], symbols: [], domains: [] },
    });
    write(secondTask.worktreePath, 'b.txt', 'B\n');
    git(secondTask.worktreePath, 'add', '.');
    git(secondTask.worktreePath, 'commit', '-m', 'implement task-b');

    let releaseValidation: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const firstStarted = createSignal('crossProjectFirstCandidate');
    const secondStarted = createSignal('crossProjectSecondCandidate');
    const first = queue.enqueue({
      scope,
      missionId: 'mission-a',
      taskId: 'task-a',
      async validate(context) {
        if (context.phase === 'candidate') {
          firstStarted.notify();
          await gate;
        }
        return approved(context);
      },
    });
    const second = queue.enqueue({
      scope: secondScope,
      missionId: 'mission-b',
      taskId: 'task-b',
      async validate(context) {
        if (context.phase === 'candidate') {
          secondStarted.notify();
          await gate;
        }
        return approved(context);
      },
    });

    // Independent project scopes must reach candidate validation concurrently
    // (not serialized by a global lock). Await both signals, not a wall sleep.
    await Promise.all([firstStarted.wait(), secondStarted.wait()]);
    const projectsValidatedConcurrently =
      firstStarted.notified() && secondStarted.notified();
    releaseValidation?.();
    await Promise.all([first, second]);

    expect(projectsValidatedConcurrently).toBe(true);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('A\n');
    expect(fs.readFileSync(path.join(secondRoot, 'b.txt'), 'utf8')).toBe('B\n');
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);


  it('leaves the branch unchanged and blocks the queue when validation rejects', async () => {
    await commitTask('mission-a', 'task-a', 'worker-a', 'a.txt', 'A\n');
    await commitTask('mission-a', 'task-b', 'worker-b', 'b.txt', 'B\n');
    const originalHead = git(root, 'rev-parse', 'HEAD');

    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-a',
        taskId: 'task-a',
        validate: async () => ({
          sensorsPassed: false,
          reviewPassed: true,
          evidenceIds: ['failed-sensor'],
        }),
      }),
    ).rejects.toThrow(MergeValidationRejectedError);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);

    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-a',
        taskId: 'task-b',
        validate: async (context) => approved(context),
      }),
    ).rejects.toThrow(MergeQueueBlockedError);
    expect(queueState.read(worktrees.scopeKey(scope)).blocked).not.toBeNull();
  });
});
