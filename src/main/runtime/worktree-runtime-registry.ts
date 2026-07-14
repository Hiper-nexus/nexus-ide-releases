import { createHash } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from './project-runtime-manager';
import { WorktreeManager, type CreateWorktreeInput, type WorktreeRecord } from './worktree-manager';
import {
  MergeQueue,
  type EnqueueMergeInput,
  type MergeQueueReconciliationResult,
  type MergeQueueResult,
  type MergeQueueStateSnapshot,
  type RetryMergeInput,
} from './merge-queue';
import type { PreparedWorktreeIntegration } from './worktree-contract';
import {
  SqliteMergeQueueStateStore,
  SqliteWorktreeStateStore,
} from './sqlite-workflow-state-stores';
import { inspectGitBinding } from '../context/git-binding';
import type { IntegratedMissionResult } from '../context/context-workflow-service';

interface ScopeRuntime {
  readonly scope: ProjectExecutionScope;
  readonly worktreeState: SqliteWorktreeStateStore;
  readonly mergeState: SqliteMergeQueueStateStore;
  readonly worktrees: WorktreeManager;
  readonly queue: MergeQueue;
}

function scopeKey(scope: ProjectExecutionScope): string {
  return `${scope.projectId}\0${scope.checkoutId}`;
}

function sameScope(left: ProjectExecutionScope, right: ProjectExecutionScope): boolean {
  return left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath;
}

export class WorktreeRuntimeRegistry {
  readonly #manager: ProjectRuntimeManager;
  readonly #runtimes = new Map<string, ScopeRuntime>();

  constructor(manager: ProjectRuntimeManager) {
    this.#manager = manager;
  }

  forScope(scope: ProjectExecutionScope): ScopeRuntime {
    const key = scopeKey(scope);
    const existing = this.#runtimes.get(key);
    if (existing) {
      if (!sameScope(existing.scope, scope)) throw new Error('worktree runtime scope collision');
      return existing;
    }
    const immutableScope = Object.freeze({ ...scope });
    const runtimeRoot = this.#manager.locationFor(scope).directory;
    const worktreeState = new SqliteWorktreeStateStore(this.#manager, immutableScope);
    const mergeState = new SqliteMergeQueueStateStore(this.#manager, immutableScope);
    const worktrees = new WorktreeManager({ runtimeRoot, stateStore: worktreeState });
    const queue = new MergeQueue({
      runtimeRoot,
      stateStore: mergeState,
      worktreeManager: worktrees,
    });
    queue.reconcile(immutableScope);
    const value = Object.freeze({
      scope: immutableScope,
      worktreeState,
      mergeState,
      worktrees,
      queue,
    });
    this.#runtimes.set(key, value);
    return value;
  }

  create(input: CreateWorktreeInput): WorktreeRecord {
    return this.forScope(input.scope).worktrees.create(input);
  }

  get(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): WorktreeRecord | null {
    return this.forScope(scope).worktrees.get(scope, missionId, taskId);
  }

  listMission(
    scope: ProjectExecutionScope,
    missionId: string,
  ): readonly WorktreeRecord[] {
    const runtime = this.forScope(scope);
    return Object.freeze(
      runtime.worktreeState.read(runtime.worktrees.scopeKey(scope)).records
        .filter((record) => record.missionId === missionId),
    );
  }

  enqueue(input: EnqueueMergeInput): Promise<MergeQueueResult> {
    return this.forScope(input.scope).queue.enqueue(input);
  }

  prepareIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeIntegration {
    return this.forScope(scope).worktrees.prepareIntegration(
      scope,
      missionId,
      taskId,
    );
  }

  markFailed(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    reason: string,
  ): WorktreeRecord {
    return this.forScope(scope).worktrees.markFailed(
      scope,
      missionId,
      taskId,
      reason,
    );
  }

  retry(input: RetryMergeInput): Promise<MergeQueueResult> {
    return this.forScope(input.scope).queue.retry(input);
  }

  mergeSnapshot(scope: ProjectExecutionScope): MergeQueueStateSnapshot {
    return this.forScope(scope).queue.snapshot(scope);
  }

  reconcile(scope: ProjectExecutionScope): MergeQueueReconciliationResult {
    return this.forScope(scope).queue.reconcile(scope);
  }

  resolveIntegratedMission(
    scope: ProjectExecutionScope,
    missionId: string,
    baseSha: string,
  ): IntegratedMissionResult | null {
    const runtime = this.forScope(scope);
    const key = runtime.worktrees.scopeKey(scope);
    const records = runtime.worktreeState.read(key).records
      .filter((record) => record.missionId === missionId);
    if (records.length === 0 || records.some((record) => record.status !== 'integrated')) {
      return null;
    }
    const queue = runtime.mergeState.read(key);
    const integratedTaskKeys = new Set(
      queue.entries
        .filter((entry) => entry.missionId === missionId && entry.status === 'integrated')
        .map((entry) => entry.taskKey),
    );
    if (records.some((record) => !integratedTaskKeys.has(record.taskKey))) return null;
    const git = inspectGitBinding(scope, baseSha);
    const worktreeId = `mission-worktrees:${createHash('sha256')
      .update(records.map((record) => record.id).sort().join('\0'))
      .digest('hex')}`;
    return Object.freeze({ worktreeId, ...git });
  }

  dispose(): void {
    this.#runtimes.clear();
  }
}

let registry: WorktreeRuntimeRegistry | null = null;

export function configureWorktreeRuntimeRegistry(
  manager: ProjectRuntimeManager,
): WorktreeRuntimeRegistry {
  registry?.dispose();
  registry = new WorktreeRuntimeRegistry(manager);
  return registry;
}

export function requireWorktreeRuntimeRegistry(): WorktreeRuntimeRegistry {
  if (!registry) throw new Error('worktree runtime registry is not initialized');
  return registry;
}

export function disposeWorktreeRuntimeRegistry(): void {
  registry?.dispose();
  registry = null;
}
