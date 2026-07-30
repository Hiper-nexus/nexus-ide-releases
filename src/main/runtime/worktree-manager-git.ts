/**
 * Git identity proofs and interrupted-reservation reconciliation.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  assertSafeLocalGitConfig,
  type GitRunner,
} from "./git-command";
import {
  WorktreeStateConflictError,
  assertSha,
  cloneWorktreeRecord as cloneRecord,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type IntegrationCheckoutInspection,
} from "./worktree-contract";
import { validateWorktreeStateSnapshot } from "./worktree-state";
import { INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER } from "./worktree-manager-markers";

const MAX_CAS_ATTEMPTS = 16;

/** Stable contract reason shared with the scheduler merge lane. */
export const TASK_WORKTREE_NOT_CLEAN_MESSAGE = "task worktree must be clean";

export type RepositorySnapshot = IntegrationCheckoutInspection;

export function gitOutput(
  runner: GitRunner,
  cwd: string,
  args: readonly string[],
): string {
  return runner.run(cwd, args).stdout.trim();
}

export function readRepositorySnapshot(
  git: GitRunner,
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
    gitOutput(git, rootRealPath, ["rev-parse", "--show-toplevel"]),
  );
  if (topLevel !== rootRealPath) {
    throw new Error("scope root must equal the canonical Git top-level");
  }
  assertSafeLocalGitConfig(git, rootRealPath);
  let integrationRef: string;
  try {
    integrationRef = gitOutput(git, rootRealPath, [
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
    gitOutput(git, rootRealPath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]),
    "integration HEAD",
  );
  const clean =
    git.run(rootRealPath, [
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

export function assertRepositoryUnchanged(
  git: GitRunner,
  expected: RepositorySnapshot,
  requireClean: boolean,
): void {
  const current = readRepositorySnapshot(
    git,
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

export function assertTaskWorktree(
  git: GitRunner,
  record: WorktreeRecord,
): string {
  const real = fs.realpathSync(record.worktreePath);
  if (real !== record.worktreePath || !fs.statSync(real).isDirectory()) {
    throw new WorktreeStateConflictError("task worktree path changed");
  }
  const topLevel = fs.realpathSync(
    gitOutput(git, real, ["rev-parse", "--show-toplevel"]),
  );
  if (topLevel !== real) {
    throw new WorktreeStateConflictError("task worktree Git root changed");
  }
  const branchRef = gitOutput(git, real, [
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ]);
  if (branchRef !== record.branchRef) {
    throw new WorktreeStateConflictError("task worktree branch changed");
  }
  const repositoryCommonDirectory = fs.realpathSync(
    gitOutput(git, record.rootRealPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
  );
  const worktreeCommonDirectory = fs.realpathSync(
    gitOutput(git, real, [
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
  assertSafeLocalGitConfig(git, real);
  const status = git.run(real, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]).stdout;
  if (status.length > 0) {
    throw new WorktreeStateConflictError(TASK_WORKTREE_NOT_CLEAN_MESSAGE);
  }
  return assertSha(
    gitOutput(git, real, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "task HEAD",
  );
}

export interface ReservationReconcileDeps {
  readonly git: GitRunner;
  readonly worktreesRoot: string;
  snapshot(scopeKey: string): WorktreeStateSnapshot;
  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean;
  failureMessage(error: unknown): string;
  timestamp(): number;
}

export function reconcileInterruptedReservation(
  deps: ReservationReconcileDeps,
  scope: ProjectExecutionScope,
  scopeKey: string,
  taskKey: string,
): WorktreeRecord {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const snapshot = deps.snapshot(scopeKey);
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
      const repository = readRepositorySnapshot(deps.git, scope, true);
      if (
        repository.integrationRef !== current.integrationRef ||
        repository.headSha !== current.baseSha
      ) {
        throw new WorktreeStateConflictError(
          "primary checkout changed after the reserved base was frozen",
        );
      }
      const taskHeadSha = assertTaskWorktree(deps.git, current);
      if (taskHeadSha !== current.baseSha) {
        throw new WorktreeStateConflictError(
          "reserved worktree HEAD diverged from its frozen base",
        );
      }
      next = cloneRecord({
        ...current,
        status: "ready",
        failureReason: undefined,
        updatedAt: deps.timestamp(),
      });
    } catch (error) {
      next = cloneRecord({
        ...current,
        status: "failed",
        failureReason: deps.failureMessage(
          `${INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER} ` +
            `reserved worktree reconciliation failed closed: ` +
            deps.failureMessage(error),
        ),
        updatedAt: deps.timestamp(),
      });
    }

    const records = snapshot.records.map((record, candidateIndex) =>
      candidateIndex === index ? next : record,
    );
    const validated = validateWorktreeStateSnapshot(
      { revision: snapshot.revision, records },
      { scopeKey, worktreesRoot: deps.worktreesRoot },
    ).records;
    if (
      deps.compareAndSwap(scopeKey, snapshot.revision, validated)
    ) {
      return next;
    }
  }
  throw new WorktreeStateConflictError(
    "reserved worktree reconciliation CAS could not converge",
  );
}
