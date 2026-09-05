import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { MergeQueue, type MergeQueueEntry, type MergeQueueStateSnapshot, type MergeQueueStateStore, type MergeValidationContext, type MergeValidationDecision } from './merge-queue';
import { ProcessGitRunner, WorktreeManager, type GitRunOptions, type GitRunner, type GitResult, type WorktreeRecord, type WorktreeStateSnapshot, type WorktreeStateStore } from './worktree-manager';
// Shared real-Git fixture; Vitest isolates this module for each focused suite.


export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
// These are real Git integration tests: each case creates repositories and
// worktrees, commits, checks out detached candidates, and runs validations.
// Measured isolated cost of the concurrent-serialization case is ~1.7–2.0s;
// under full Vitest worker-pool + multi-file git contention the same case can
// spend several extra seconds waiting on ProcessGitRunner (not a logic bug).
// Default 5s is insufficient under that load; 15s is a measured budget that
// still fails closed if the queue truly deadlocks.
export const GIT_INTEGRATION_TEST_TIMEOUT_MS = 15_000;

vi.setConfig({ testTimeout: GIT_INTEGRATION_TEST_TIMEOUT_MS });

/**
 * One-shot async signal for coordination tests.
 * Prefer notify/await over polling: under git contention a 5s poll budget
 * could expire while the suite still has a 15s test timeout remaining.
 * Timeout uses the same measured GIT_INTEGRATION_TEST_TIMEOUT_MS budget.
 */
export function createSignal(label: string, timeoutMs = GIT_INTEGRATION_TEST_TIMEOUT_MS): {
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

export class MemoryWorktreeStateStore implements WorktreeStateStore {
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

export class MemoryMergeQueueStateStore implements MergeQueueStateStore {
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

export class RecordingGitRunner implements GitRunner {
  readonly calls: Array<{ cwd: string; args: readonly string[] }> = [];
  readonly #delegate = new ProcessGitRunner();

  run(cwd: string, args: readonly string[], options?: GitRunOptions): GitResult {
    this.calls.push({ cwd, args: [...args] });
    return this.#delegate.run(cwd, args, options);
  }
}

export let tempDir = '';
export let root = '';
export let runtimeRoot = '';
export let scope: ProjectExecutionScope;
export let worktreeState: MemoryWorktreeStateStore;
export let queueState: MemoryMergeQueueStateStore;
export let gitRunner: RecordingGitRunner;
export let worktrees: WorktreeManager;
export let queue: MergeQueue;

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function write(cwd: string, relativePath: string, content: string): void {
  const file = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

export async function commitTask(
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

export function approved(
  context: MergeValidationContext,
): MergeValidationDecision {
  return {
    sensorsPassed: true,
    reviewPassed: true,
    evidenceIds: [`evidence-${context.phase}-${context.taskKey.slice(0, 8)}`],
  };
}

export function queueEntries(): readonly MergeQueueEntry[] {
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
  write(root, '.gitignore', 'node_modules/\n');
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
