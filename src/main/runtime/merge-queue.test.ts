import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  MergeCasError,
  MergeConflictError,
  MergeOperationAbortedError,
  MergeQueue,
  MergeQueueBlockedError,
  MergeRetryRequiredError,
  MergeQueueStateError,
  MergeValidationRejectedError,
  type MergeQueueEntry,
  type MergeQueueStateSnapshot,
  type MergeQueueStateStore,
  type MergeValidationContext,
  type MergeValidationDecision,
} from './merge-queue';
import { STALLED_MERGE_ATTEMPT_MS } from './merge-stall-watchdog';
import {
  ProcessGitRunner,
  WorktreeManager,
  type GitRunOptions,
  type GitRunner,
  type GitResult,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from './worktree-manager';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
// These are real Git integration tests: each case creates repositories and
// worktrees, commits, checks out detached candidates, and runs validations.
// Measured isolated cost of the concurrent-serialization case is ~1.7–2.0s;
// under full Vitest worker-pool + multi-file git contention the same case can
// spend several extra seconds waiting on ProcessGitRunner (not a logic bug).
// Default 5s is insufficient under that load; 15s is a measured budget that
// still fails closed if the queue truly deadlocks.
const GIT_INTEGRATION_TEST_TIMEOUT_MS = 15_000;

vi.setConfig({ testTimeout: GIT_INTEGRATION_TEST_TIMEOUT_MS });

/**
 * One-shot async signal for coordination tests.
 * Prefer notify/await over polling: under git contention a 5s poll budget
 * could expire while the suite still has a 15s test timeout remaining.
 * Timeout uses the same measured GIT_INTEGRATION_TEST_TIMEOUT_MS budget.
 */
function createSignal(label: string, timeoutMs = GIT_INTEGRATION_TEST_TIMEOUT_MS): {
  readonly notified: () => boolean;
  readonly notify: () => void;
  readonly wait: () => Promise<void>;
} {
  let done = false;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = async (): Promise<void> => {
    if (done) return;
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`signal(${label}) timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
  return {
    notified: () => done,
    notify: () => {
      if (done) return;
      done = true;
      resolve();
    },
    wait,
  };
}

class MemoryWorktreeStateStore implements WorktreeStateStore {
  readonly #states = new Map<string, WorktreeStateSnapshot>();

  read(scopeKey: string): WorktreeStateSnapshot {
    return this.#states.get(scopeKey) ?? { revision: 0, records: [] };
  }

  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean {
    const current = this.read(scopeKey);
    if (current.revision !== expectedRevision) return false;
    this.#states.set(scopeKey, {
      revision: current.revision + 1,
      records: structuredClone(records),
    });
    return true;
  }
}

class MemoryMergeQueueStateStore implements MergeQueueStateStore {
  readonly #states = new Map<string, MergeQueueStateSnapshot>();
  #integratedWriteFailuresRemaining = 0;
  #readFailuresAfterIntegratedWrites = 0;
  #readFailuresRemaining = 0;

  read(scopeKey: string): MergeQueueStateSnapshot {
    if (this.#readFailuresRemaining > 0) {
      this.#readFailuresRemaining -= 1;
      throw new Error('simulated merge queue read outage');
    }
    return (
      this.#states.get(scopeKey) ?? {
        revision: 0,
        activeTaskKey: null,
        blocked: null,
        events: [],
        entries: [],
      }
    );
  }

  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    state: Omit<MergeQueueStateSnapshot, 'revision'>,
  ): boolean {
    if (
      this.#integratedWriteFailuresRemaining > 0 &&
      state.entries.some((entry) => entry.status === 'integrated')
    ) {
      this.#integratedWriteFailuresRemaining -= 1;
      if (this.#integratedWriteFailuresRemaining === 0) {
        this.#readFailuresRemaining =
          this.#readFailuresAfterIntegratedWrites;
        this.#readFailuresAfterIntegratedWrites = 0;
      }
      return false;
    }
    const current = this.read(scopeKey);
    if (current.revision !== expectedRevision) return false;
    this.#states.set(scopeKey, {
      ...structuredClone(state),
      revision: current.revision + 1,
    });
    return true;
  }

  overwrite(scopeKey: string, state: MergeQueueStateSnapshot): void {
    this.#states.set(scopeKey, structuredClone(state));
  }

  failIntegratedWrites(count = 16): void {
    this.#integratedWriteFailuresRemaining = count;
  }

  failIntegratedWritesThenReads(
    writeCount = 16,
    readCount = 1,
  ): void {
    this.#integratedWriteFailuresRemaining = writeCount;
    this.#readFailuresAfterIntegratedWrites = readCount;
  }
}

class RecordingGitRunner implements GitRunner {
  readonly calls: Array<{ cwd: string; args: readonly string[] }> = [];
  readonly #delegate = new ProcessGitRunner();

  run(cwd: string, args: readonly string[], options?: GitRunOptions): GitResult {
    this.calls.push({ cwd, args: [...args] });
    return this.#delegate.run(cwd, args, options);
  }
}

let tempDir = '';
let root = '';
let runtimeRoot = '';
let scope: ProjectExecutionScope;
let worktreeState: MemoryWorktreeStateStore;
let queueState: MemoryMergeQueueStateStore;
let gitRunner: RecordingGitRunner;
let worktrees: WorktreeManager;
let queue: MergeQueue;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(cwd: string, relativePath: string, content: string): void {
  const file = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

async function commitTask(
  missionId: string,
  taskId: string,
  workerId: string,
  relativePath: string,
  content: string,
  dependsOn: Array<{ missionId: string; taskId: string }> = [],
): Promise<WorktreeRecord> {
  const record = await worktrees.create({
    scope,
    missionId,
    taskId,
    workerId,
    ownership: { files: [relativePath], symbols: [], domains: [] },
    dependsOn,
  });
  write(record.worktreePath, relativePath, content);
  git(record.worktreePath, 'add', '.');
  git(record.worktreePath, 'commit', '-m', `implement ${taskId}`);
  return record;
}

function approved(
  context: MergeValidationContext,
): MergeValidationDecision {
  return {
    sensorsPassed: true,
    reviewPassed: true,
    evidenceIds: [`evidence-${context.phase}-${context.taskKey.slice(0, 8)}`],
  };
}

function queueEntries(): readonly MergeQueueEntry[] {
  return queueState.read(worktrees.scopeKey(scope)).entries;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-merge-queue-'));
  root = path.join(tempDir, 'repo');
  runtimeRoot = path.join(tempDir, 'runtime');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  write(root, 'shared.txt', 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  scope = {
    version: 1,
    installationId: 'installation-test',
    projectId: PROJECT_ID,
    checkoutId: 'checkout-merge-test',
    rootRealPath: fs.realpathSync(root),
    identitySource: 'manifest',
  };
  worktreeState = new MemoryWorktreeStateStore();
  queueState = new MemoryMergeQueueStateStore();
  gitRunner = new RecordingGitRunner();
  worktrees = new WorktreeManager({
    runtimeRoot,
    stateStore: worktreeState,
    gitRunner,
    now: () => 1_700_000_000_000,
  });
  queue = new MergeQueue({
    runtimeRoot,
    stateStore: queueState,
    worktreeManager: worktrees,
    gitRunner,
    now: () => 1_700_000_000_000,
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('MergeQueue', () => {
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

describe('orphaned mission block retirement', () => {
  it('lifts a block whose mission no longer exists and unbricks the scope', async () => {
    await commitTask('mission-dead', 'task-dead', 'worker-dead', 'dead.txt', 'D\n');
    await commitTask('mission-live', 'task-live', 'worker-live', 'live.txt', 'L\n');

    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-dead',
        taskId: 'task-dead',
        validate: async () => ({
          sensorsPassed: false,
          reviewPassed: true,
          evidenceIds: ['rejected-dead'],
        }),
      }),
    ).rejects.toThrow(MergeValidationRejectedError);

    // A different mission inherits the block while the owner still exists.
    await expect(
      queue.enqueue({
        scope,
        missionId: 'mission-live',
        taskId: 'task-live',
        validate: approved,
      }),
    ).rejects.toThrow(MergeQueueBlockedError);

    // Owner alive → retirement refuses to touch the block.
    expect(queue.retireOrphanedMissionBlock(scope, () => true)).toBeNull();
    expect(queue.snapshot(scope).blocked).not.toBeNull();

    // Owner mission removed → the block is provably unownable and lifts.
    const retired = queue.retireOrphanedMissionBlock(
      scope,
      (missionId) => missionId !== 'mission-dead',
    );
    expect(retired?.errorName).toBe('MergeValidationRejectedError');

    const after = queue.snapshot(scope);
    expect(after.blocked).toBeNull();
    // Audit evidence survives: the blocked entry and a reconciliation event.
    expect(
      after.entries.some(
        (entry) => entry.missionId === 'mission-dead' && entry.status === 'blocked',
      ),
    ).toBe(true);
    expect(after.events.at(-1)).toMatchObject({
      type: 'restart-reconciled',
      fromStatus: 'blocked',
    });

    // The scope is usable again end-to-end.
    const result = await queue.enqueue({
      scope,
      missionId: 'mission-live',
      taskId: 'task-live',
      validate: approved,
    });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(result.integratedSha);
    expect(fs.readFileSync(path.join(root, 'live.txt'), 'utf8')).toBe('L\n');
  });

  it('returns null when the scope has no block', () => {
    expect(queue.retireOrphanedMissionBlock(scope, () => false)).toBeNull();
  });
});

describe('same-process stalled merge watchdog (deadline + dead-letter)', () => {
  const ENQUEUED_AT = 1_700_000_000_000;

  function candidateCheckoutsOnDisk(): readonly string[] {
    const scopeDirectory = path.join(
      queue.candidatesRoot,
      `scope-${worktrees.scopeKey(scope)}`,
    );
    if (!fs.existsSync(scopeDirectory)) return [];
    return fs.readdirSync(scopeDirectory);
  }

  it(
    'dead-letters an abandoned candidate validation past the deadline with an ' +
      'actionable reason, releases its resources, and lets the queue move on',
    async () => {
      // Regressão do incidente de 31/07/2026: entrada presa em
      // candidate-validating por 22,7 min NO MESMO processo, blocked=null,
      // 91 ticks com applied=0 — a promise de validação nunca voltou.
      await commitTask(
        'mission-stalled',
        'task-stalled',
        'worker-stalled',
        'stalled.txt',
        'abandoned mid-validation\n',
      );
      await commitTask(
        'mission-next',
        'task-next',
        'worker-next',
        'next.txt',
        'must still integrate\n',
      );

      const validationStarted = createSignal('stalled-validation-started');
      const resumeZombie = createSignal('resume-zombie-validation');
      const abandoned = queue.enqueue({
        scope,
        missionId: 'mission-stalled',
        taskId: 'task-stalled',
        async validate(context) {
          if (context.phase === 'candidate') {
            validationStarted.notify();
            await resumeZombie.wait();
          }
          return approved(context);
        },
      });
      await validationStarted.wait();
      expect(queue.snapshot(scope).entries[0]?.status).toBe(
        'candidate-validating',
      );
      // O recurso está preso: o checkout do candidato existe em disco.
      expect(candidateCheckoutsOnDisk()).toHaveLength(1);

      // 91 ticks dentro do prazo (o incidente real): o watchdog NÃO dispara —
      // deadline generoso, nunca menor que o bound da validação.
      for (let tick = 1; tick <= 91; tick += 1) {
        expect(
          queue.reconcileIfStalled(scope, ENQUEUED_AT + tick * 15_000),
        ).toEqual({ action: 'none' });
      }
      expect(queue.snapshot(scope).entries[0]?.status).toBe(
        'candidate-validating',
      );

      // Deadline vencido: a entrada NÃO fica lá — vira dead-letter.
      const firedAt = ENQUEUED_AT + STALLED_MERGE_ATTEMPT_MS + 1;
      expect(queue.reconcileIfStalled(scope, firedAt)).toMatchObject({
        action: 'blocked-interrupted',
        fromStatus: 'candidate-validating',
        integrationState: 'not-integrated',
      });

      const after = queue.snapshot(scope);
      expect(after.activeTaskKey).toBeNull();
      expect(after.blocked).toMatchObject({
        errorName: 'MergeStalledError',
        disposition: 'retryable',
      });
      // Reason acionável: o que estava fazendo, há quanto tempo, o que fazer.
      expect(after.blocked?.reason).toMatch(/candidate-validating/);
      expect(after.blocked?.reason).toMatch(/25 min/);
      expect(after.blocked?.reason).toMatch(/watchdog/i);
      expect(after.blocked?.reason).toMatch(/retry|retomar/i);
      // A entrada continua visível como falha (não é "resolvida" em silêncio).
      expect(
        after.entries.find((entry) => entry.missionId === 'mission-stalled'),
      ).toMatchObject({ status: 'blocked', failureReason: after.blocked?.reason });
      // Recurso liberado: o checkout do candidato foi removido.
      expect(candidateCheckoutsOnDisk()).toHaveLength(0);
      // Retryable não condena o worktree da task: ele fica para o retry.
      expect(
        worktrees.get(scope, 'mission-stalled', 'task-stalled'),
      ).not.toMatchObject({ status: 'failed' });

      // Nada foi afrouxado: enquanto o dead-letter não é reconhecido, o scope
      // continua fail-closed para novas entradas.
      await expect(
        queue.enqueue({
          scope,
          missionId: 'mission-next',
          taskId: 'task-next',
          validate: approved,
        }),
      ).rejects.toThrow(MergeQueueBlockedError);

      // A lane automática do produto destrava o retryable sem wizard…
      const retried = await queue.retryRecoverable({
        scope,
        missionId: 'mission-stalled',
        taskId: 'task-stalled',
        validate: approved,
      });
      expect(git(root, 'rev-parse', 'HEAD')).toBe(retried.integratedSha);

      // …e a fila volta a processar as demais entradas.
      const next = await queue.enqueue({
        scope,
        missionId: 'mission-next',
        taskId: 'task-next',
        validate: approved,
      });
      expect(git(root, 'rev-parse', 'HEAD')).toBe(next.integratedSha);
      expect(fs.readFileSync(path.join(root, 'next.txt'), 'utf8')).toBe(
        'must still integrate\n',
      );

      // A tentativa zumbi acordando depois não corrompe nada: a autoridade
      // dela foi superada e ela apenas rejeita.
      resumeZombie.notify();
      await expect(abandoned).rejects.toThrow();
      const settled = queue.snapshot(scope);
      expect(settled.blocked).toBeNull();
      expect(git(root, 'rev-parse', 'HEAD')).toBe(next.integratedSha);
      expect(
        settled.entries.find((entry) => entry.missionId === 'mission-stalled'),
      ).toMatchObject({ status: 'integrated', attempt: 2 });
    },
  );

  it('never touches a healthy validation still inside the deadline', async () => {
    await commitTask(
      'mission-healthy',
      'task-healthy',
      'worker-healthy',
      'healthy.txt',
      'slow but alive\n',
    );
    const validationStarted = createSignal('healthy-validation-started');
    const resumeValidation = createSignal('resume-healthy-validation');
    const attempt = queue.enqueue({
      scope,
      missionId: 'mission-healthy',
      taskId: 'task-healthy',
      async validate(context) {
        if (context.phase === 'candidate') {
          validationStarted.notify();
          await resumeValidation.wait();
        }
        return approved(context);
      },
    });
    await validationStarted.wait();

    // Um tick aquém do deadline: falso positivo mataria validação viva.
    expect(
      queue.reconcileIfStalled(
        scope,
        ENQUEUED_AT + STALLED_MERGE_ATTEMPT_MS - 1,
      ),
    ).toEqual({ action: 'none' });
    expect(queue.snapshot(scope)).toMatchObject({
      activeTaskKey: expect.any(String),
      blocked: null,
      entries: [{ status: 'candidate-validating' }],
    });

    resumeValidation.notify();
    const result = await attempt;
    expect(git(root, 'rev-parse', 'HEAD')).toBe(result.integratedSha);
    expect(queue.snapshot(scope)).toMatchObject({
      activeTaskKey: null,
      blocked: null,
      entries: [{ status: 'integrated', attempt: 1 }],
    });
  });
});
