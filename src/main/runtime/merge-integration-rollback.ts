import type { ProjectExecutionScope } from "../../shared/types";
import { MergeCasError } from "./merge-queue-contract";
import {
  GitCommandError,
  WorktreeManager,
  WorktreeStateConflictError,
  type GitRunner,
  type WorktreeRecord,
} from "./worktree-manager";

function assertExactIntegration(
  worktrees: WorktreeManager,
  record: WorktreeRecord,
  expectedHeadSha: string,
  message: string,
): void {
  try {
    worktrees.assertIntegrationUnchanged(record, expectedHeadSha);
  } catch (error) {
    if (error instanceof WorktreeStateConflictError) {
      throw new MergeCasError(message, { cause: error });
    }
    throw error;
  }
}

/**
 * Restores both Git and durable worktree state after any caught failure that
 * follows the candidate CAS. Every mutation is fenced by the exact candidate
 * SHA; checkout drift is terminal instead of being overwritten.
 */
export function rollbackIntegrationCheckout(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly taskId: string;
  readonly taskHeadSha: string;
  readonly integrationBaseSha: string;
  readonly candidateSha: string;
  readonly record: WorktreeRecord;
  readonly git: GitRunner;
  readonly worktrees: WorktreeManager;
}): void {
  assertExactIntegration(
    input.worktrees,
    input.record,
    input.candidateSha,
    "cannot roll back merge failure because integration HEAD changed",
  );
  const refRollback = input.git.run(
    input.record.rootRealPath,
    [
      "update-ref",
      "-m",
      `Nexus rollback ${input.record.taskKey}`,
      input.record.integrationRef,
      input.integrationBaseSha,
      input.candidateSha,
    ],
    { allowFailure: true },
  );
  if (refRollback.status !== 0) {
    throw new MergeCasError("merge rollback compare-and-swap failed", {
      cause: new GitCommandError(
        "git update-ref rollback compare-and-swap failed",
        [
          "update-ref",
          input.record.integrationRef,
          input.integrationBaseSha,
          input.candidateSha,
        ],
        refRollback,
      ),
    });
  }
  const materialize = input.git.run(
    input.record.rootRealPath,
    [
      "read-tree",
      "-u",
      "-m",
      input.candidateSha,
      input.integrationBaseSha,
    ],
    { allowFailure: true },
  );
  if (materialize.status !== 0) {
    throw new MergeCasError(
      "merge ref rolled back but checkout rematerialization failed",
      {
        cause: new GitCommandError(
          "git read-tree rollback materialization failed",
          [
            "read-tree",
            "-u",
            "-m",
            input.candidateSha,
            input.integrationBaseSha,
          ],
          materialize,
        ),
      },
    );
  }
  assertExactIntegration(
    input.worktrees,
    input.record,
    input.integrationBaseSha,
    "merge checkout did not return to the exact integration base",
  );
  input.worktrees.restoreQueuedAfterIntegrationRollback(
    input.scope,
    input.missionId,
    input.taskId,
    input.taskHeadSha,
    input.candidateSha,
  );
}
