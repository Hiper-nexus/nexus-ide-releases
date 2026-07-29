import { createHash } from "node:crypto";
import type { ProjectExecutionScope } from "../../shared/types";
import type { ProjectRuntimeManager } from "./project-runtime-manager";
import {
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
    try {
      const liveTaskIds = new Set(
        (
          new ScopedStoreBinding(this.#manager, immutableScope)
            .readDatabase()
            .prepare('SELECT id FROM tasks')
            .all() as ReadonlyArray<{ id: string }>
        ).map((row) => row.id),
      );
      const purged = worktrees.purgeRecordsWithoutTask(
        immutableScope,
        liveTaskIds,
      );
      if (purged.length > 0) {
        console.warn(
          `[worktree-runtime] dropped ${purged.length} worktree record(s) ` +
            'whose task no longer exists; no Git path or ref was removed',
        );
      }
    } catch (error) {
      // Never block runtime startup on an opportunistic cleanup.
      console.warn('[worktree-runtime] orphan record sweep skipped', error);
    }
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
    const integratedTaskKeys = new Set(
      queue.entries
        .filter(
          (entry) =>
            entry.missionId === missionId && entry.status === "integrated",
        )
        .map((entry) => entry.taskKey),
    );
    if (
      records.some(
        (record) =>
          !integratedTaskKeys.has(record.taskKey) &&
          !(
            record.taskHeadSha === record.baseSha &&
            record.integratedSha === record.baseSha
          ),
      )
    ) {
      return null;
    }
    const git = inspectGitBinding(scope, baseSha);
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
