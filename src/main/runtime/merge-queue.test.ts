import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  MergeCasError,
  MergeConflictError,
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

  read(scopeKey: string): MergeQueueStateSnapshot {
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

function commitTask(
  missionId: string,
  taskId: string,
  workerId: string,
  relativePath: string,
  content: string,
  dependsOn: Array<{ missionId: string; taskId: string }> = [],
): WorktreeRecord {
  const record = worktrees.create({
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
    commitTask(
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
    commitTask('mission-a', 'task-a', 'worker-a', 'a.txt', 'A\n');
    commitTask('mission-a', 'task-b', 'worker-b', 'b.txt', 'B\n');
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

  it('keeps merge serialization scoped so independent projects can validate concurrently', async () => {
    commitTask('mission-a', 'task-a', 'worker-a', 'a.txt', 'A\n');
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
    const secondTask = worktrees.create({
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
    commitTask('mission-a', 'task-a', 'worker-a', 'a.txt', 'A\n');
    commitTask('mission-a', 'task-b', 'worker-b', 'b.txt', 'B\n');
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
    commitTask('mission-retry', 'task-retry', 'worker-retry', 'retry.txt', 'v1\n');
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

  it('accepts a retry without acknowledgement evidence after the task commit changes', async () => {
    const assignment = commitTask(
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
    const blocked = queue.snapshot(scope);

    const result = await queue.retry({
      scope,
      missionId: 'mission-commit-retry',
      taskId: 'task-commit-retry',
      expectedStateRevision: blocked.revision,
      acknowledgement: {},
      validate: approved,
    });
    expect(result.integratedSha).toBe(git(root, 'rev-parse', 'HEAD'));
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);

  it.each(['candidate-validating', 'integrating'] as const)(
    'reconciles an interrupted %s attempt into a durable fail-closed block',
    (status) => {
      commitTask(
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
      expect(recovered.blocked?.taskKey).toBe(prepared.record.taskKey);
      expect(recovered.entries[0]?.status).toBe('blocked');
      expect(recovered.events.at(-1)?.type).toBe('restart-reconciled');
      expect(git(root, 'rev-parse', 'HEAD')).toBe(prepared.record.baseSha);
    },
  );

  it('records an exact integrated ref without trusting an interrupted dirty checkout', async () => {
    commitTask(
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
    commitTask(
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
    const updateRefsBeforeRetry = gitRunner.calls.filter(
      (call) => call.args[0] === 'update-ref',
    ).length;
    const recovered = await restarted.retry({
      scope,
      missionId: 'mission-post-restart',
      taskId: 'task-post-restart',
      expectedStateRevision: blocked.revision,
      acknowledgement: { revisionId: 'post-review-revision-2' },
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

  it('keeps an integrated candidate blocked until durable mission finalization succeeds', async () => {
    commitTask(
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

    const blocked = queue.snapshot(scope);
    expect(failedFinalizer).toHaveBeenCalledOnce();
    expect(blocked).toMatchObject({
      activeTaskKey: null,
      blocked: { errorName: 'Error' },
      entries: [{ status: 'blocked', integratedSha: expect.any(String) }],
    });

    const recoveredFinalizer = vi.fn(async () => {});
    await queue.retry({
      scope,
      missionId: 'mission-finalizer-retry',
      taskId: 'task-finalizer-retry',
      expectedStateRevision: blocked.revision,
      acknowledgement: { revisionId: 'finalizer-recovery-2' },
      validate: approved,
      finalize: recoveredFinalizer,
    });

    expect(recoveredFinalizer).toHaveBeenCalledOnce();
    expect(queue.snapshot(scope)).toMatchObject({
      activeTaskKey: null,
      blocked: null,
      entries: [{ status: 'integrated', attempt: 2 }],
    });
  });

  it('blocks on a real merge conflict even when overlap had an explicit dependency', async () => {
    const first = commitTask(
      'mission-a',
      'task-a',
      'worker-a',
      'shared.txt',
      'first\n',
    );
    commitTask(
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
    commitTask('mission-a', 'task-a', 'worker-a', 'task.txt', 'task\n');

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
    const assignment = commitTask(
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

  it('blocks without rollback when post-integration sensors reject the exact candidate', async () => {
    commitTask('mission-a', 'task-a', 'worker-a', 'post.txt', 'integrated\n');

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

    expect(fs.readFileSync(path.join(root, 'post.txt'), 'utf8')).toBe(
      'integrated\n',
    );
    expect(queueState.read(worktrees.scopeKey(scope)).blocked).not.toBeNull();
    expect(
      worktrees.get(scope, 'mission-a', 'task-a'),
    ).toMatchObject({ status: 'failed', integratedSha: git(root, 'rev-parse', 'HEAD') });
  });

  it('requires injected durable queue state instead of an implicit memory fallback', () => {
    expect(() =>
      new MergeQueue({
        runtimeRoot,
        stateStore: undefined as unknown as MergeQueueStateStore,
        worktreeManager: worktrees,
      }),
    ).toThrow(/state store/i);
  });

  it('fails closed when durable queue state is structurally inconsistent', async () => {
    commitTask('mission-state', 'task-state', 'worker-state', 'state.txt', 'state\n');
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
