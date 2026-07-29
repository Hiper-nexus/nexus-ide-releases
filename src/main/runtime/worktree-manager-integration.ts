/**
 * Integration / no-change preparation helpers for WorktreeManager.
 */

import { createHash } from "node:crypto";
import type { ProjectExecutionScope } from "../../shared/types";
import type { GitRunner } from "./git-command";
import {
  OwnershipViolationError,
  WorktreeStateConflictError,
  assertSha,
  fileOwnershipClaimsOverlap,
  normalizeFileOwnership,
  worktreeTaskKey,
  type IntegrationCheckoutSnapshot,
  type PreparedWorktreeIntegration,
  type PreparedWorktreeNoChangeValidation,
  type WorktreeRecord,
  type WorktreeStateSnapshot,
} from "./worktree-contract";
import { assertTaskWorktree } from "./worktree-manager-git";

export interface IntegrationHost {
  readonly git: GitRunner;
  get(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): WorktreeRecord | null;
  snapshot(scopeKey: string): WorktreeStateSnapshot;
  transition(
    scopeKey: string,
    taskKey: string,
    update: (record: WorktreeRecord) => WorktreeRecord,
  ): WorktreeRecord;
  timestamp(): number;
  scopeKey(scope: ProjectExecutionScope): string;
  integrationSnapshot(record: WorktreeRecord): IntegrationCheckoutSnapshot;
  prepareRecoveryIntegration(
    scope: ProjectExecutionScope,
    missionId: string,
    taskId: string,
  ): PreparedWorktreeIntegration;
}


function prepareNoChangeValidationInternal(
  host: IntegrationHost,
  scope: ProjectExecutionScope,
  missionId: string,
  taskId: string,
  allowIntegrationAdvance: boolean,
): PreparedWorktreeNoChangeValidation | null {
    const record = host.get(scope, missionId, taskId);
    const isFresh = record?.status === "ready";
    const isAlreadyValidated =
      record?.status === "integrated" &&
      record.taskHeadSha === record.baseSha &&
      Boolean(record.integratedSha) &&
      (allowIntegrationAdvance || record.integratedSha === record.baseSha);
    if (!record || (!isFresh && !isAlreadyValidated)) {
      throw new WorktreeStateConflictError(
        "task worktree is not ready for no-change validation",
      );
    }
    const records = host.snapshot(record.scopeKey).records;
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
    const taskHeadSha = assertTaskWorktree(host.git, record);
    const ancestor = host.git.run(
      record.worktreePath,
      ["merge-base", "--is-ancestor", record.baseSha, taskHeadSha],
      { allowFailure: true },
    );
    if (ancestor.status !== 0) {
      throw new WorktreeStateConflictError(
        "task HEAD no longer descends from its frozen base SHA",
      );
    }
    const changedFiles = host.git
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
    const integration = host.integrationSnapshot(record);
    const integrationMatchesBase =
      integration.headSha === record.baseSha ||
      (allowIntegrationAdvance &&
        host.git.run(
          record.rootRealPath,
          [
            "merge-base",
            "--is-ancestor",
            record.baseSha,
            integration.headSha,
          ],
          { allowFailure: true },
        ).status === 0);
    if (!integrationMatchesBase) {
      throw new WorktreeStateConflictError(
        allowIntegrationAdvance
          ? "primary checkout no longer descends from the disposable worktree base"
          : "primary checkout changed after validation worktree creation",
      );
    }
    const diff = host.git.run(record.worktreePath, [
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

export function prepareNoChangeValidation(
  host: IntegrationHost,
  scope: ProjectExecutionScope,
  missionId: string,
  taskId: string,
): PreparedWorktreeNoChangeValidation | null {
  return prepareNoChangeValidationInternal(
    host,
    scope,
    missionId,
    taskId,
    false,
  );
}

/**
 * Proves that a disposable reviewer/advisor worktree stayed byte-clean while
 * allowing unrelated Main-owned integrations to advance the primary branch.
 */
export function prepareDiscardedNoChangeValidation(
  host: IntegrationHost,
  scope: ProjectExecutionScope,
  missionId: string,
  taskId: string,
): PreparedWorktreeNoChangeValidation | null {
  return prepareNoChangeValidationInternal(
    host,
    scope,
    missionId,
    taskId,
    true,
  );
}

export function markValidatedNoChange(
  host: IntegrationHost,
  scope: ProjectExecutionScope,
  missionId: string,
  taskId: string,
  expectedTaskHeadSha: string,
  expectedIntegrationHeadSha: string,
): WorktreeRecord {
    const prepared = prepareNoChangeValidation(host, scope, missionId, taskId);
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
    return host.transition(host.scopeKey(scope), taskKey, (record) => {
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
        updatedAt: host.timestamp(),
      };
    });
}

export function markDiscardedNoChange(
  host: IntegrationHost,
  scope: ProjectExecutionScope,
  missionId: string,
  taskId: string,
  expectedTaskHeadSha: string,
  expectedIntegrationHeadSha: string,
): WorktreeRecord {
  const prepared = prepareDiscardedNoChangeValidation(
    host,
    scope,
    missionId,
    taskId,
  );
  if (
    !prepared ||
    prepared.taskHeadSha !==
      assertSha(expectedTaskHeadSha, "expected disposable task HEAD") ||
    prepared.integrationHeadSha !==
      assertSha(
        expectedIntegrationHeadSha,
        "expected disposable integration HEAD",
      )
  ) {
    throw new WorktreeStateConflictError(
      "disposable no-change Git identity changed before finalization",
    );
  }
  const taskKey = worktreeTaskKey(missionId, taskId);
  return host.transition(host.scopeKey(scope), taskKey, (record) => {
    if (
      record.status === "integrated" &&
      record.taskHeadSha === prepared.taskHeadSha &&
      record.integratedSha
    ) {
      return record;
    }
    if (
      record.status !== "ready" ||
      record.baseSha !== prepared.taskHeadSha
    ) {
      throw new WorktreeStateConflictError(
        "disposable worktree state changed before no-change finalization",
      );
    }
    return {
      ...record,
      status: "integrated",
      taskHeadSha: prepared.taskHeadSha,
      integratedSha: prepared.integrationHeadSha,
      failureReason: undefined,
      updatedAt: host.timestamp(),
    };
  });
}

export function prepareIntegrationInternal(
  host: IntegrationHost,
  scope: ProjectExecutionScope,
  missionId: string,
  taskId: string,
  allowTerminalRecovery: boolean,
): PreparedWorktreeIntegration {
    const record = host.get(scope, missionId, taskId);
    const isOrdinarilyReady =
      record?.status === "ready" || record?.status === "queued";
    const isRecoverable =
      allowTerminalRecovery &&
      (record?.status === "failed" || record?.status === "integrated");
    if (!record || (!isOrdinarilyReady && !isRecoverable)) {
      throw new WorktreeStateConflictError("task worktree is not ready");
    }
    const records = host.snapshot(record.scopeKey).records;
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
    const taskHeadSha = assertTaskWorktree(host.git, record);
    const ancestor = host.git.run(
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
      host.git
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
    const diff = host.git.run(record.worktreePath, [
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
