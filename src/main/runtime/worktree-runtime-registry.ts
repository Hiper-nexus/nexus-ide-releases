import { createHash } from "node:crypto";
import type { ProjectExecutionScope } from "../../shared/types";
import type { ProjectRuntimeManager } from "./project-runtime-manager";
import {
  OwnershipOverlapError,
  WorktreeManager,
  type CreateWorktreeInput,
  type WorktreeRecord,
} from "./worktree-manager";
import {
  MergeQueue,
  type EnqueueMergeInput,
  type MergeQueueReconciliationResult,
  type MergeQueueResult,
  type MergeQueueStateSnapshot,
  type RetryMergeInput,
} from "./merge-queue";
import type {
  PreparedWorktreeIntegration,
  PreparedWorktreeNoChangeValidation,
} from "./worktree-contract";
import {
  SqliteMergeQueueStateStore,
  SqliteWorktreeStateStore,
} from "./sqlite-workflow-state-stores";
import { ScopedStoreBinding } from "../orch/scoped-store";
import { inspectGitBinding } from "../context/git-binding";
import type { IntegratedMissionResult } from "../context/context-workflow-service";

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

function sameScope(
  left: ProjectExecutionScope,
  right: ProjectExecutionScope,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath
  );
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
      if (!sameScope(existing.scope, scope))
        throw new Error("worktree runtime scope collision");
      return existing;
    }
    const immutableScope = Object.freeze({ ...scope });
    const runtimeRoot = this.#manager.locationFor(scope).directory;
    const worktreeState = new SqliteWorktreeStateStore(
      this.#manager,
      immutableScope,
    );
    const mergeState = new SqliteMergeQueueStateStore(
      this.#manager,
      immutableScope,
    );
    const worktrees = new WorktreeManager({
      runtimeRoot,
      stateStore: worktreeState,
    });
    const worktreeRecovery = worktreeState.recoverInvalidState(
      worktrees.scopeKey(immutableScope),
    );
    if (worktreeRecovery.action === "quarantined") {
      console.warn(
        `[worktree-runtime] archived ${worktreeRecovery.recordCount} invalid ` +
          `worktree record(s) as ${worktreeRecovery.quarantineId} ` +
          `(${worktreeRecovery.reason}); no Git path or ref was removed`,
      );
    }
    const queue = new MergeQueue({
      runtimeRoot,
      stateStore: mergeState,
      worktreeManager: worktrees,
    });
    // This registry instance is constructed only after the app's
    // single-instance boundary. Any pre-existing `reserved` row belongs to an
    // interrupted prior process and must converge before scheduler dispatch.
    worktrees.reconcileInterruptedReservations(immutableScope);
    // A record left behind by a deleted mission keeps claiming ownership, and
    // the overlap check then blocks every new mission with "worktree ownership
    // overlaps active task <id>" — naming a task that no longer exists, so the
    // operator cannot inspect or clear it. Reconcile only converges `reserved`
    // rows and never saw these. Drop records whose task row is gone; no Git
    // path, ref or worktree is touched.
    this.#purgeOrphanWorktrees(immutableScope, worktrees);
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

  /**
   * `forScope` only runs this sweep once per process (the ScopeRuntime is
   * memoized), so a mission deleted after that first call left its worktree
   * record orphaned for the rest of the process lifetime — permanently
   * blocking any later task whose ownership overlaps it. `create` re-runs
   * the sweep on demand so a stale record cannot wedge every future mission
   * until restart.
   */
  #purgeOrphanWorktrees(
    scope: ProjectExecutionScope,
    worktrees: WorktreeManager,
  ): readonly WorktreeRecord[] {
    try {
      const liveTaskIds = new Set(
        (
          new ScopedStoreBinding(this.#manager, scope)
            .readDatabase()
            .prepare('SELECT id FROM tasks')
            .all() as ReadonlyArray<{ id: string }>
        ).map((row) => row.id),
      );
      const purged = worktrees.purgeRecordsWithoutTask(scope, liveTaskIds);
      if (purged.length > 0) {
        console.warn(
          `[worktree-runtime] dropped ${purged.length} worktree record(s) ` +
            'whose task no longer exists; no Git path or ref was removed',
        );
      }
      return purged;
    } catch (error) {
      // Never block a dispatch attempt on an opportunistic cleanup.
      console.warn('[worktree-runtime] orphan record sweep skipped', error);
      return [];
    }
  }

  async create(input: CreateWorktreeInput): Promise<WorktreeRecord> {
    const runtime = this.forScope(input.scope);
    try {
      return await runtime.worktrees.create(input);
    } catch (error) {
      if (!(error instanceof OwnershipOverlapError)) throw error;
      const purged = this.#purgeOrphanWorktrees(
        input.scope,
        runtime.worktrees,
      );
      if (purged.length === 0) throw error;
      return runtime.worktrees.create(input);
    }
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
      runtime.worktreeState
        .read(runtime.worktrees.scopeKey(scope))
        .records.filter((record) => record.missionId === missionId),
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

  prepareNoChangeValidation(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeNoChangeValidation | null {
    return this.forScope(scope).worktrees.prepareNoChangeValidation(
      scope,
      missionId,
      taskId,
    );
  }

  prepareDiscardedNoChangeValidation(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeNoChangeValidation | null {
    return this.forScope(scope).worktrees.prepareDiscardedNoChangeValidation(
      scope,
      missionId,
      taskId,
    );
  }

  markValidatedNoChange(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    expectedTaskHeadSha: string,
    expectedIntegrationHeadSha: string,
  ): WorktreeRecord {
    return this.forScope(scope).worktrees.markValidatedNoChange(
      scope,
      missionId,
      taskId,
      expectedTaskHeadSha,
      expectedIntegrationHeadSha,
    );
  }

  markDiscardedNoChange(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    expectedTaskHeadSha: string,
    expectedIntegrationHeadSha: string,
  ): WorktreeRecord {
    return this.forScope(scope).worktrees.markDiscardedNoChange(
      scope,
      missionId,
      taskId,
      expectedTaskHeadSha,
      expectedIntegrationHeadSha,
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

  retryRecoverable(input: EnqueueMergeInput): Promise<MergeQueueResult> {
    return this.forScope(input.scope).queue.retryRecoverable(input);
  }

  mergeSnapshot(scope: ProjectExecutionScope): MergeQueueStateSnapshot {
    return this.forScope(scope).queue.snapshot(scope);
  }

  reconcile(scope: ProjectExecutionScope): MergeQueueReconciliationResult {
    return this.forScope(scope).queue.reconcile(scope);
  }

  reconcileMergeIfIdle(
    scope: ProjectExecutionScope,
  ): MergeQueueReconciliationResult {
    return this.forScope(scope).queue.reconcileIfIdle(scope);
  }

  resolveIntegratedMission(
    scope: ProjectExecutionScope,
    missionId: string,
    baseSha: string,
  ): IntegratedMissionResult | null {
    const runtime = this.forScope(scope);
    const key = runtime.worktrees.scopeKey(scope);
    const records = runtime.worktreeState
      .read(key)
      .records.filter((record) => record.missionId === missionId);
    if (
      records.length === 0 ||
      records.some((record) => record.status !== "integrated")
    ) {
      return null;
    }
    const queue = runtime.mergeState.read(key);
    const integratedEntries = new Map(
      queue.entries
        .filter(
          (entry) =>
            entry.missionId === missionId && entry.status === "integrated",
        )
        .map((entry) => [entry.taskKey, entry] as const),
    );
    const queueLessIntegrationHeads: string[] = [];
    for (const record of records) {
      const integratedEntry = integratedEntries.get(record.taskKey);
      if (integratedEntry) {
        if (
          integratedEntry.taskHeadSha !== record.taskHeadSha ||
          integratedEntry.integratedSha !== record.integratedSha
        ) {
          return null;
        }
        continue;
      }
      if (
        record.taskHeadSha !== record.baseSha ||
        record.integratedSha === undefined
      ) {
        return null;
      }
      try {
        const prepared = runtime.worktrees.prepareDiscardedNoChangeValidation(
          scope,
          record.missionId,
          record.taskId,
        );
        if (
          !prepared ||
          prepared.record.id !== record.id ||
          prepared.taskHeadSha !== record.baseSha ||
          prepared.changedFiles.length !== 0
        ) {
          return null;
        }
        queueLessIntegrationHeads.push(prepared.integrationHeadSha);
      } catch {
        return null;
      }
    }
    const git = inspectGitBinding(scope, baseSha);
    if (
      queueLessIntegrationHeads.some(
        (integrationHeadSha) => integrationHeadSha !== git.headSha,
      )
    ) {
      return null;
    }
    const worktreeId = `mission-worktrees:${createHash("sha256")
      .update(
        records
          .map((record) => record.id)
          .sort()
          .join("\0"),
      )
      .digest("hex")}`;
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
  if (!registry)
    throw new Error("worktree runtime registry is not initialized");
  return registry;
}

export function disposeWorktreeRuntimeRegistry(): void {
  registry?.dispose();
  registry = null;
}
