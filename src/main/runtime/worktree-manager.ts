import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  GitCommandError,
  ProcessGitRunner,
  assertSafeLocalGitConfig,
  type GitRunner,
} from "./git-command";
import {
  ACTIVE_WORKTREE_STATUSES as ACTIVE_STATUSES,
  OwnershipOverlapError,
  OwnershipViolationError,
  WorktreeStateConflictError,
  WorktreeWorkerConflictError,
  assertIdentifier,
  assertSha,
  cloneWorktreeRecord as cloneRecord,
  digest,
  fileOwnershipClaimsOverlap,
  hasOwnershipOverlap as hasOverlap,
  normalizeFileOwnership,
  normalizeOwnership,
  ownershipOverlap as overlap,
  sameValues,
  worktreeTaskKey,
  type CreateWorktreeInput,
  type IntegrationCheckoutSnapshot,
  type IntegrationCheckoutInspection,
  type PreparedWorktreeIntegration,
  type PreparedWorktreeNoChangeValidation,
  type WorktreeManagerOptions,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from "./worktree-contract";
import { validateWorktreeStateSnapshot } from "./worktree-state";
import { materializeGitWorktree } from "./worktree-cow";

export * from "./git-command";
export * from "./worktree-contract";
export { cowWorktreeAvailable, materializeGitWorktree } from "./worktree-cow";

const MAX_CAS_ATTEMPTS = 16;
export const INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER =
  "[NEXUS_INTERRUPTED_WORKTREE_RESERVATION]";

function assertExecutorOwnershipIsNotAuthority(files: readonly string[]): void {
  const protectedFile = files.find((file) => {
    const normalized = file.replaceAll("\\", "/");
    return (
      normalized === ".nexus/project.json" ||
      normalized === ".context" ||
      normalized.startsWith(".context/")
    );
  });
  if (protectedFile) {
    throw new Error(
      `executor worktrees cannot own context authority: ${protectedFile}`,
    );
  }
}

type RepositorySnapshot = IntegrationCheckoutInspection;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function ensureDirectory(directory: string, parent?: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`runtime path is not a real directory: ${directory}`);
  }
  const real = fs.realpathSync(directory);
  if (parent && !isInside(parent, real)) {
    throw new Error(`runtime path escapes its parent: ${directory}`);
  }
  fs.chmodSync(real, 0o700);
  return real;
}

function gitOutput(
  runner: GitRunner,
  cwd: string,
  args: readonly string[],
): string {
  return runner.run(cwd, args).stdout.trim();
}

export class WorktreeManager {
  readonly runtimeRoot: string;
  readonly worktreesRoot: string;
  readonly #stateStore: WorktreeStateStore;
  readonly #git: GitRunner;
  readonly #now: () => number;

  constructor(options: WorktreeManagerOptions) {
    if (
      !options.stateStore ||
      typeof options.stateStore.read !== "function" ||
      typeof options.stateStore.compareAndSwap !== "function"
    ) {
      throw new Error("a durable worktree state store is required");
    }
    this.runtimeRoot = ensureDirectory(path.resolve(options.runtimeRoot));
    this.worktreesRoot = ensureDirectory(
      path.join(this.runtimeRoot, "worktrees"),
      this.runtimeRoot,
    );
    this.#stateStore = options.stateStore;
    this.#git = options.gitRunner ?? new ProcessGitRunner();
    this.#now = options.now ?? Date.now;
  }

  scopeKey(
    scope: Pick<ProjectExecutionScope, "projectId" | "checkoutId">,
  ): string {
    return digest(
      "worktree-scope",
      assertIdentifier(scope.projectId, "projectId"),
      assertIdentifier(scope.checkoutId, "checkoutId"),
    );
  }

  /**
   * Startup-only recovery for reservations persisted before `git worktree add`
   * and the final `ready` CAS completed. A reservation is promoted only when
   * the primary checkout and linked worktree still prove the exact frozen
   * branch/base/common Git directory. Every other state is terminally failed
   * without deleting any path or ref.
   *
   * Re-running this method is a no-op once every record is non-reserved.
   */
  reconcileInterruptedReservations(
    scope: ProjectExecutionScope,
  ): readonly WorktreeRecord[] {
    const scopeKey = this.scopeKey(scope);
    const taskKeys = this.#snapshot(scopeKey)
      .records.filter((record) => record.status === "reserved")
      .map((record) => record.taskKey);
    return Object.freeze(
      taskKeys.map((taskKey) =>
        this.#reconcileInterruptedReservation(scope, scopeKey, taskKey),
      ),
    );
  }

  /**
   * Drops records whose task row no longer exists.
   *
   * Ownership overlap is checked against every non-terminal record, so a
   * record left behind by a deleted mission keeps claiming files forever and
   * blocks the next mission with "worktree ownership overlaps active task
   * &lt;id&gt;" — pointing at a task that cannot be inspected because it is gone.
   * `reconcileInterruptedReservations` only converges `reserved` rows and
   * never noticed these.
   *
   * Only the record is removed; no Git path, ref or worktree is touched, and a
   * record whose task still exists is never considered.
   */
  purgeRecordsWithoutTask(
    scope: ProjectExecutionScope,
    liveTaskIds: ReadonlySet<string>,
  ): readonly WorktreeRecord[] {
    const scopeKey = this.scopeKey(scope);
    return this.#mutate(scopeKey, (records) => {
      const orphans = records.filter(
        (record) => !liveTaskIds.has(record.taskId),
      );
      if (orphans.length === 0) return { records, result: [] };
      return {
        records: records.filter((record) => liveTaskIds.has(record.taskId)),
        result: orphans,
      };
    });
  }

  create(input: CreateWorktreeInput): WorktreeRecord {
    const repository = this.#repositorySnapshot(input.scope, true);
    const missionId = assertIdentifier(input.missionId, "missionId");
    const taskId = assertIdentifier(input.taskId, "taskId");
    const workerId = assertIdentifier(input.workerId, "workerId");
    const taskKey = worktreeTaskKey(missionId, taskId);
    const scopeKey = this.scopeKey(input.scope);
    const ownership = normalizeOwnership(input.ownership);
    assertExecutorOwnershipIsNotAuthority(ownership.files);
    const dependencies = Object.freeze(
      [
        ...new Set(
          (input.dependsOn ?? []).map((dependency) =>
            worktreeTaskKey(dependency.missionId, dependency.taskId),
          ),
        ),
      ].sort(),
    );
    if (dependencies.includes(taskKey)) {
      throw new Error("a task cannot depend on itself");
    }

    const projectKey = digest("worktree-project", input.scope.projectId);
    const checkoutKey = digest(
      "worktree-checkout",
      input.scope.projectId,
      input.scope.checkoutId,
    );
    const taskDirectory = ensureDirectory(
      path.join(
        this.worktreesRoot,
        `project-${projectKey}`,
        `checkout-${checkoutKey}`,
      ),
      this.worktreesRoot,
    );
    const worktreePath = path.join(taskDirectory, `task-${taskKey}`);
    const branchRef = `refs/heads/nexus/${projectKey.slice(0, 16)}/${taskKey.slice(0, 32)}`;
    const now = this.#timestamp();
    const candidate = cloneRecord({
      id: `worktree-${taskKey}`,
      scopeKey,
      projectId: input.scope.projectId,
      checkoutId: input.scope.checkoutId,
      missionId,
      taskId,
      taskKey,
      workerId,
      rootRealPath: repository.rootRealPath,
      worktreePath,
      branchRef,
      integrationRef: repository.integrationRef,
      baseSha: repository.headSha,
      ownership,
      dependencies,
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });

    const reservation = this.#mutate(scopeKey, (records) => {
      const existing = records.find((record) => record.taskKey === taskKey);
      if (existing) {
        if (
          existing.rootRealPath !== repository.rootRealPath ||
          existing.integrationRef !== repository.integrationRef
        ) {
          throw new WorktreeStateConflictError(
            "task worktree belongs to another checkout root",
          );
        }
        if (existing.workerId !== workerId) {
          throw new WorktreeWorkerConflictError();
        }
        if (
          !sameValues(existing.ownership.files, ownership.files) ||
          !sameValues(existing.ownership.symbols, ownership.symbols) ||
          !sameValues(existing.ownership.domains, ownership.domains) ||
          !sameValues(existing.dependencies, dependencies)
        ) {
          throw new WorktreeStateConflictError(
            "task ownership and dependencies are immutable after reservation",
          );
        }
        if (existing.status === "ready" || existing.status === "queued") {
          return { records, result: { record: existing, isNew: false } };
        }
        throw new WorktreeStateConflictError(
          `task worktree is already ${existing.status}`,
        );
      }

      for (const dependency of dependencies) {
        const dependencyRecord = records.find(
          (record) => record.taskKey === dependency,
        );
        if (
          !dependencyRecord ||
          dependencyRecord.status === "failed" ||
          dependencyRecord.status === "abandoned"
        ) {
          throw new WorktreeStateConflictError(
            `explicit dependency is unavailable: ${dependency}`,
          );
        }
      }

      for (const record of records) {
        if (!ACTIVE_STATUSES.has(record.status)) continue;
        const claimOverlap = overlap(ownership, record.ownership);
        if (
          hasOverlap(claimOverlap) &&
          !dependencies.includes(record.taskKey)
        ) {
          throw new OwnershipOverlapError(record.taskKey, claimOverlap);
        }
      }
      if (
        records.some(
          (record) =>
            record.worktreePath === worktreePath ||
            record.branchRef === branchRef,
        )
      ) {
        throw new WorktreeStateConflictError(
          "derived worktree path or branch is already reserved",
        );
      }
      return {
        records: [...records, candidate],
        result: { record: candidate, isNew: true },
      };
    });

    if (!reservation.isNew) {
      this.#assertWorktree(reservation.record);
      return cloneRecord(reservation.record);
    }

    try {
      this.#assertRepositoryUnchanged(repository, true);
      if (fs.existsSync(worktreePath)) {
        throw new Error("derived worktree path already exists");
      }
      const branchExists = this.#git.run(
        repository.rootRealPath,
        ["show-ref", "--verify", "--quiet", branchRef],
        { allowFailure: true },
      );
      if (branchExists.status === 0) {
        throw new Error("derived Nexus branch already exists");
      }
      if (branchExists.status !== 1) {
        throw new GitCommandError(
          "Git could not verify the derived branch",
          ["show-ref", "--verify", "--quiet", branchRef],
          branchExists,
        );
      }
      // CoW-aware materialization (APFS clonefile path when enabled; else git).
      materializeGitWorktree({
        repositoryRoot: repository.rootRealPath,
        worktreePath,
        branchRef,
        headSha: repository.headSha,
        git: this.#git,
      });
      this.#assertWorktree(candidate);
      this.#assertRepositoryUnchanged(repository, true);
      return this.#transition(scopeKey, taskKey, (record) => ({
        ...record,
        status: "ready",
        updatedAt: this.#timestamp(),
      }));
    } catch (error) {
      this.#transition(scopeKey, taskKey, (record) => ({
        ...record,
        status: "failed",
        failureReason: this.#failureMessage(error),
        updatedAt: this.#timestamp(),
      }));
      throw error;
    }
  }

  get(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): WorktreeRecord | null {
    const key = worktreeTaskKey(missionId, taskId);
    const record =
      this.#snapshot(this.scopeKey(scope)).records.find(
        (candidate) => candidate.taskKey === key,
      ) ?? null;
    if (!record) return null;
    const expectedRoot = path.resolve(scope.rootRealPath);
    const actualRoot = fs.realpathSync(expectedRoot);
    if (
      scope.rootRealPath !== expectedRoot ||
      actualRoot !== expectedRoot ||
      record.rootRealPath !== actualRoot ||
      record.projectId !== scope.projectId ||
      record.checkoutId !== scope.checkoutId
    ) {
      throw new WorktreeStateConflictError(
        "worktree record does not belong to the requested scope root",
      );
    }
    return record;
  }

  prepareIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeIntegration {
    return this.#prepareIntegration(scope, missionId, taskId, false);
  }

  prepareRecoveryIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeIntegration {
    return this.#prepareIntegration(scope, missionId, taskId, true);
  }

  /**
   * Inspect the honest "QA passed without a correction" branch.
   *
   * `null` means there are real committed changes and the ordinary MergeQueue
   * must handle them. A dirty worktree, empty commit, dependency drift, or
   * primary-HEAD drift is an error — none can be reclassified as no-change.
   */
  prepareNoChangeValidation(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeNoChangeValidation | null {
    const record = this.get(scope, missionId, taskId);
    const isFresh = record?.status === "ready";
    const isAlreadyValidated =
      record?.status === "integrated" &&
      record.taskHeadSha === record.baseSha &&
      record.integratedSha === record.baseSha;
    if (!record || (!isFresh && !isAlreadyValidated)) {
      throw new WorktreeStateConflictError(
        "task worktree is not ready for no-change validation",
      );
    }
    const records = this.#snapshot(record.scopeKey).records;
    for (const dependency of record.dependencies) {
      const dependencyRecord = records.find(
        (candidate) => candidate.taskKey === dependency,
      );
      if (dependencyRecord?.status !== "integrated") {
        throw new WorktreeStateConflictError(
          `task dependency is not integrated: ${dependency}`,
        );
      }
    }
    const taskHeadSha = this.#assertWorktree(record);
    const ancestor = this.#git.run(
      record.worktreePath,
      ["merge-base", "--is-ancestor", record.baseSha, taskHeadSha],
      { allowFailure: true },
    );
    if (ancestor.status !== 0) {
      throw new WorktreeStateConflictError(
        "task HEAD no longer descends from its frozen base SHA",
      );
    }
    const changedFiles = this.#git
      .run(record.worktreePath, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "-z",
        "--diff-filter=ACDMRTUXB",
        record.baseSha,
        taskHeadSha,
      ])
      .stdout.split("\0")
      .filter(Boolean);
    if (changedFiles.length > 0) return null;
    if (taskHeadSha !== record.baseSha) {
      throw new WorktreeStateConflictError(
        "validation-only task created an empty commit instead of preserving HEAD",
      );
    }
    const integration = this.integrationSnapshot(record);
    if (integration.headSha !== record.baseSha) {
      throw new WorktreeStateConflictError(
        "primary checkout changed after validation worktree creation",
      );
    }
    const diff = this.#git.run(record.worktreePath, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--full-index",
      record.baseSha,
      taskHeadSha,
    ]).stdout;
    return Object.freeze({
      record,
      taskHeadSha,
      integrationHeadSha: integration.headSha,
      changedFiles: Object.freeze([]) as readonly [],
      diffHash: createHash("sha256").update(diff).digest("hex"),
    });
  }

  /**
   * Durable no-change terminal marker. Re-proves Git immediately before the
   * CAS; normal executor work still cannot reach integration without a diff.
   */
  markValidatedNoChange(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    expectedTaskHeadSha: string,
    expectedIntegrationHeadSha: string,
  ): WorktreeRecord {
    const prepared = this.prepareNoChangeValidation(scope, missionId, taskId);
    if (
      !prepared ||
      prepared.taskHeadSha !==
        assertSha(expectedTaskHeadSha, "expected task HEAD") ||
      prepared.integrationHeadSha !==
        assertSha(expectedIntegrationHeadSha, "expected integration HEAD")
    ) {
      throw new WorktreeStateConflictError(
        "no-change validation Git identity changed before finalization",
      );
    }
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (
        record.status === "integrated" &&
        record.taskHeadSha === prepared.taskHeadSha &&
        record.integratedSha === prepared.integrationHeadSha
      ) {
        return record;
      }
      if (
        record.status !== "ready" ||
        record.baseSha !== prepared.taskHeadSha ||
        prepared.taskHeadSha !== prepared.integrationHeadSha
      ) {
        throw new WorktreeStateConflictError(
          "worktree state changed before no-change finalization",
        );
      }
      return {
        ...record,
        status: "integrated",
        taskHeadSha: prepared.taskHeadSha,
        integratedSha: prepared.integrationHeadSha,
        failureReason: undefined,
        updatedAt: this.#timestamp(),
      };
    });
  }

  #prepareIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    allowTerminalRecovery: boolean,
  ): PreparedWorktreeIntegration {
    const record = this.get(scope, missionId, taskId);
    const isOrdinarilyReady =
      record?.status === "ready" || record?.status === "queued";
    const isRecoverable =
      allowTerminalRecovery &&
      (record?.status === "failed" || record?.status === "integrated");
    if (!record || (!isOrdinarilyReady && !isRecoverable)) {
      throw new WorktreeStateConflictError("task worktree is not ready");
    }
    const records = this.#snapshot(record.scopeKey).records;
    for (const dependency of record.dependencies) {
      const dependencyRecord = records.find(
        (candidate) => candidate.taskKey === dependency,
      );
      if (dependencyRecord?.status !== "integrated") {
        throw new WorktreeStateConflictError(
          `task dependency is not integrated: ${dependency}`,
        );
      }
    }
    const taskHeadSha = this.#assertWorktree(record);
    const ancestor = this.#git.run(
      record.worktreePath,
      ["merge-base", "--is-ancestor", record.baseSha, taskHeadSha],
      { allowFailure: true },
    );
    if (ancestor.status !== 0) {
      throw new WorktreeStateConflictError(
        "task HEAD no longer descends from its frozen base SHA",
      );
    }
    const changedFiles = Object.freeze(
      this.#git
        .run(record.worktreePath, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--name-only",
          "-z",
          "--diff-filter=ACDMRTUXB",
          record.baseSha,
          taskHeadSha,
        ])
        .stdout.split("\0")
        .filter(Boolean)
        .map(normalizeFileOwnership),
    );
    if (changedFiles.length === 0) {
      throw new WorktreeStateConflictError("task has no committed changes");
    }
    const undeclared = changedFiles.filter(
      (file) =>
        !record.ownership.files.some((claim) =>
          fileOwnershipClaimsOverlap(claim, file),
        ),
    );
    if (undeclared.length > 0) throw new OwnershipViolationError(undeclared);
    const diff = this.#git.run(record.worktreePath, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--full-index",
      record.baseSha,
      taskHeadSha,
    ]).stdout;
    return Object.freeze({
      record,
      taskHeadSha,
      changedFiles,
      diffHash: createHash("sha256").update(diff).digest("hex"),
    });
  }

  reopenFailedForRetry(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    expectedTaskHeadSha: string,
  ): WorktreeRecord {
    const expectedHead = assertSha(expectedTaskHeadSha, "task head SHA");
    const prepared = this.prepareRecoveryIntegration(scope, missionId, taskId);
    if (prepared.taskHeadSha !== expectedHead) {
      throw new WorktreeStateConflictError(
        "task HEAD changed before the retry could be reopened",
      );
    }
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (record.status !== "failed" || record.integratedSha !== undefined) {
        throw new WorktreeStateConflictError(
          "only a failed, non-integrated task can be reopened for retry",
        );
      }
      return {
        ...record,
        status: "ready",
        taskHeadSha: undefined,
        integratedSha: undefined,
        failureReason: undefined,
        updatedAt: this.#timestamp(),
      };
    });
  }

  finalizeRecoveredIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    expectedTaskHeadSha: string,
    integratedSha: string,
  ): WorktreeRecord {
    const expectedHead = assertSha(expectedTaskHeadSha, "task head SHA");
    const exactIntegratedSha = assertSha(integratedSha, "integrated SHA");
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (
        record.taskHeadSha !== expectedHead ||
        (record.integratedSha !== undefined &&
          record.integratedSha !== exactIntegratedSha) ||
        (record.status !== "failed" &&
          record.status !== "queued" &&
          record.status !== "integrated")
      ) {
        throw new WorktreeStateConflictError(
          "worktree state does not match the recovered integration",
        );
      }
      return {
        ...record,
        status: "integrated",
        integratedSha: exactIntegratedSha,
        failureReason: undefined,
        updatedAt: this.#timestamp(),
      };
    });
  }

  integrationSnapshot(record: WorktreeRecord): IntegrationCheckoutSnapshot {
    const snapshot = this.inspectIntegration(record);
    if (!snapshot.clean) {
      throw new WorktreeStateConflictError("primary checkout must be clean");
    }
    const { rootRealPath, integrationRef, headSha } = snapshot;
    return Object.freeze({ rootRealPath, integrationRef, headSha });
  }

  inspectIntegration(record: WorktreeRecord): IntegrationCheckoutInspection {
    const snapshot = this.#repositorySnapshot(
      {
        projectId: record.projectId,
        checkoutId: record.checkoutId,
        rootRealPath: record.rootRealPath,
      } as ProjectExecutionScope,
      false,
    );
    if (snapshot.integrationRef !== record.integrationRef) {
      throw new WorktreeStateConflictError("integration branch changed");
    }
    return Object.freeze({ ...snapshot });
  }

  assertIntegrationUnchanged(
    record: WorktreeRecord,
    expectedHeadSha: string,
  ): IntegrationCheckoutSnapshot {
    const snapshot = this.integrationSnapshot(record);
    if (snapshot.headSha !== expectedHeadSha) {
      throw new WorktreeStateConflictError(
        "integration HEAD changed during validation",
      );
    }
    return snapshot;
  }

  markQueued(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    taskHeadSha: string,
  ): WorktreeRecord {
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (record.status !== "ready" && record.status !== "queued") {
        throw new WorktreeStateConflictError("task cannot enter merge queue");
      }
      return {
        ...record,
        status: "queued",
        taskHeadSha: assertSha(taskHeadSha, "task head SHA"),
        updatedAt: this.#timestamp(),
      };
    });
  }

  markIntegrated(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    integratedSha: string,
  ): WorktreeRecord {
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (record.status !== "queued" || !record.taskHeadSha) {
        throw new WorktreeStateConflictError(
          "only a queued task can be marked integrated",
        );
      }
      return {
        ...record,
        status: "integrated",
        integratedSha: assertSha(integratedSha, "integrated SHA"),
        failureReason: undefined,
        updatedAt: this.#timestamp(),
      };
    });
  }

  markFailed(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
    reason: string,
    integratedSha?: string,
  ): WorktreeRecord {
    const taskKey = worktreeTaskKey(missionId, taskId);
    return this.#transition(this.scopeKey(scope), taskKey, (record) => {
      if (record.status === "integrated" || record.status === "abandoned") {
        throw new WorktreeStateConflictError(
          `cannot fail a task that is already ${record.status}`,
        );
      }
      return {
        ...record,
        status: "failed",
        ...(integratedSha
          ? { integratedSha: assertSha(integratedSha, "integrated SHA") }
          : {}),
        failureReason: this.#failureMessage(reason),
        updatedAt: this.#timestamp(),
      };
    });
  }

  #repositorySnapshot(
    scope: Pick<
      ProjectExecutionScope,
      "projectId" | "checkoutId" | "rootRealPath"
    >,
    requireClean: boolean,
  ): RepositorySnapshot {
    const expectedRoot = path.resolve(scope.rootRealPath);
    const rootRealPath = fs.realpathSync(expectedRoot);
    if (
      scope.rootRealPath !== expectedRoot ||
      rootRealPath !== expectedRoot ||
      !fs.statSync(rootRealPath).isDirectory()
    ) {
      throw new Error("scope root is not canonical");
    }
    const topLevel = fs.realpathSync(
      gitOutput(this.#git, rootRealPath, ["rev-parse", "--show-toplevel"]),
    );
    if (topLevel !== rootRealPath) {
      throw new Error("scope root must equal the canonical Git top-level");
    }
    this.#assertSafeRepositoryConfig(rootRealPath);
    let integrationRef: string;
    try {
      integrationRef = gitOutput(this.#git, rootRealPath, [
        "symbolic-ref",
        "--quiet",
        "HEAD",
      ]);
    } catch (error) {
      throw new Error("primary checkout must be on an integration branch", {
        cause: error,
      });
    }
    if (!integrationRef.startsWith("refs/heads/")) {
      throw new Error("primary checkout has an invalid integration ref");
    }
    const headSha = assertSha(
      gitOutput(this.#git, rootRealPath, [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ]),
      "integration HEAD",
    );
    const clean =
      this.#git.run(rootRealPath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]).stdout.length === 0;
    if (requireClean && !clean) {
      throw new Error("primary checkout must be clean");
    }
    return Object.freeze({ rootRealPath, integrationRef, headSha, clean });
  }

  #assertRepositoryUnchanged(
    expected: RepositorySnapshot,
    requireClean: boolean,
  ): void {
    const current = this.#repositorySnapshot(
      {
        projectId: "",
        checkoutId: "",
        rootRealPath: expected.rootRealPath,
      } as ProjectExecutionScope,
      requireClean,
    );
    if (
      current.integrationRef !== expected.integrationRef ||
      current.headSha !== expected.headSha
    ) {
      throw new WorktreeStateConflictError(
        "primary checkout changed after base SHA was frozen",
      );
    }
  }

  #assertWorktree(record: WorktreeRecord): string {
    const real = fs.realpathSync(record.worktreePath);
    if (real !== record.worktreePath || !fs.statSync(real).isDirectory()) {
      throw new WorktreeStateConflictError("task worktree path changed");
    }
    const topLevel = fs.realpathSync(
      gitOutput(this.#git, real, ["rev-parse", "--show-toplevel"]),
    );
    if (topLevel !== real) {
      throw new WorktreeStateConflictError("task worktree Git root changed");
    }
    const branchRef = gitOutput(this.#git, real, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
    if (branchRef !== record.branchRef) {
      throw new WorktreeStateConflictError("task worktree branch changed");
    }
    const repositoryCommonDirectory = fs.realpathSync(
      gitOutput(this.#git, record.rootRealPath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
    const worktreeCommonDirectory = fs.realpathSync(
      gitOutput(this.#git, real, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
    if (worktreeCommonDirectory !== repositoryCommonDirectory) {
      throw new WorktreeStateConflictError(
        "task worktree is not linked to the frozen repository",
      );
    }
    this.#assertSafeRepositoryConfig(real);
    const status = this.#git.run(real, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]).stdout;
    if (status.length > 0) {
      throw new WorktreeStateConflictError("task worktree must be clean");
    }
    return assertSha(
      gitOutput(this.#git, real, ["rev-parse", "--verify", "HEAD^{commit}"]),
      "task HEAD",
    );
  }

  #reconcileInterruptedReservation(
    scope: ProjectExecutionScope,
    scopeKey: string,
    taskKey: string,
  ): WorktreeRecord {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = this.#snapshot(scopeKey);
      const index = snapshot.records.findIndex(
        (record) => record.taskKey === taskKey,
      );
      if (index < 0) {
        throw new WorktreeStateConflictError(
          "reserved worktree state record disappeared",
        );
      }
      const current = snapshot.records[index];
      if (current.status !== "reserved") return cloneRecord(current);

      let next: WorktreeRecord;
      try {
        if (
          current.projectId !== scope.projectId ||
          current.checkoutId !== scope.checkoutId ||
          current.rootRealPath !== scope.rootRealPath
        ) {
          throw new WorktreeStateConflictError(
            "reserved worktree does not belong to the requested scope",
          );
        }
        const repository = this.#repositorySnapshot(scope, true);
        if (
          repository.integrationRef !== current.integrationRef ||
          repository.headSha !== current.baseSha
        ) {
          throw new WorktreeStateConflictError(
            "primary checkout changed after the reserved base was frozen",
          );
        }
        const taskHeadSha = this.#assertWorktree(current);
        if (taskHeadSha !== current.baseSha) {
          throw new WorktreeStateConflictError(
            "reserved worktree HEAD diverged from its frozen base",
          );
        }
        next = cloneRecord({
          ...current,
          status: "ready",
          failureReason: undefined,
          updatedAt: this.#timestamp(),
        });
      } catch (error) {
        next = cloneRecord({
          ...current,
          status: "failed",
          failureReason: this.#failureMessage(
            `${INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER} ` +
              `reserved worktree reconciliation failed closed: ` +
              this.#failureMessage(error),
          ),
          updatedAt: this.#timestamp(),
        });
      }

      const records = snapshot.records.map((record, candidateIndex) =>
        candidateIndex === index ? next : record,
      );
      const validated = validateWorktreeStateSnapshot(
        { revision: snapshot.revision, records },
        { scopeKey, worktreesRoot: this.worktreesRoot },
      ).records;
      if (
        this.#stateStore.compareAndSwap(scopeKey, snapshot.revision, validated)
      ) {
        return next;
      }
      // Another process won the durable CAS. Re-read and re-prove every Git
      // identity rather than applying a decision computed from stale state.
    }
    throw new WorktreeStateConflictError(
      "reserved worktree reconciliation CAS could not converge",
    );
  }

  #assertSafeRepositoryConfig(rootRealPath: string): void {
    assertSafeLocalGitConfig(this.#git, rootRealPath);
  }

  #snapshot(scopeKey: string): WorktreeStateSnapshot {
    try {
      return validateWorktreeStateSnapshot(this.#stateStore.read(scopeKey), {
        scopeKey,
        worktreesRoot: this.worktreesRoot,
      });
    } catch (error) {
      throw new WorktreeStateConflictError(
        error instanceof Error ? error.message : "invalid worktree state",
      );
    }
  }

  #mutate<T>(
    scopeKey: string,
    update: (records: readonly WorktreeRecord[]) => {
      records: readonly WorktreeRecord[];
      result: T;
    },
  ): T {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = this.#snapshot(scopeKey);
      const next = update(snapshot.records);
      let records: readonly WorktreeRecord[];
      try {
        records = validateWorktreeStateSnapshot(
          { revision: snapshot.revision, records: next.records },
          { scopeKey, worktreesRoot: this.worktreesRoot },
        ).records;
      } catch (error) {
        throw new WorktreeStateConflictError(
          error instanceof Error ? error.message : "invalid worktree state",
        );
      }
      if (
        this.#stateStore.compareAndSwap(scopeKey, snapshot.revision, records)
      ) {
        return next.result;
      }
    }
    throw new WorktreeStateConflictError(
      "worktree persistence CAS could not converge",
    );
  }

  #transition(
    scopeKey: string,
    taskKey: string,
    update: (record: WorktreeRecord) => WorktreeRecord,
  ): WorktreeRecord {
    return this.#mutate(scopeKey, (records) => {
      const index = records.findIndex((record) => record.taskKey === taskKey);
      if (index < 0) {
        throw new WorktreeStateConflictError(
          "worktree state record disappeared",
        );
      }
      const updated = cloneRecord(update(records[index]));
      return {
        records: records.map((record, candidateIndex) =>
          candidateIndex === index ? updated : record,
        ),
        result: updated,
      };
    });
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("worktree clock returned an invalid timestamp");
    }
    return value;
  }

  #failureMessage(error: unknown): string {
    try {
      const value = error instanceof Error ? error.message : error;
      const message = (typeof value === "string" ? value : String(value))
        .replaceAll("\0", " ")
        .slice(0, 2_048);
      return message.trim().length > 0
        ? message
        : "worktree operation failed with an unknown error";
    } catch {
      return "worktree operation failed with an unknown error";
    }
  }
}
