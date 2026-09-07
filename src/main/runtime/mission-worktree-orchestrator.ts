/**
 * Mission Task Worktree Orchestrator.
 *
 * Integrates Paseo-style branch slugging and worktree provenance with
 * Nexus's WorktreeManager and lifecycle safety.
 *
 * NOT WIRED: `prepareTaskWorktree` and `teardownTaskWorktree` have zero
 * production call sites, and `autoArchiveOnMerge` is written but never read —
 * there is no auto-archive logic anywhere in the repo. Production worktree
 * lifecycle is owned by WorktreeManager, which names branches
 * `refs/heads/nexus/<projectKey>/<taskKey>` rather than the `task/<slug>` this
 * module produces; the two schemes are not reconciled.
 * See docs/qa/items/F-404.md before wiring this up.
 */

import type { ProjectExecutionScope } from '../../shared/types';
import { generateTaskBranchName } from '../../shared/worktree-branch-slug';
import {
  writeWorktreeMetadata,
  readWorktreeMetadata,
  type WorktreeProvenanceMetadata,
} from './worktree-metadata';
import {
  archiveWorktree,
  checkWorktreeStatus,
  type ArchiveWorktreeResult,
} from './worktree-lifecycle';
import type {
  CreateWorktreeInput,
  WorktreeManager,
  WorktreeRecord,
} from './worktree-manager';
import type { GitRunner } from './git-command';

export interface PrepareTaskWorktreeOptions {
  readonly manager: WorktreeManager;
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly workerId: string;
  readonly files?: readonly string[];
  readonly symbols?: readonly string[];
  readonly domains?: readonly string[];
  readonly dependsOn?: readonly { readonly missionId: string; readonly taskId: string }[];
  readonly baseRefName?: string;
}

export interface PreparedTaskWorktreeResult {
  readonly record: WorktreeRecord;
  readonly branchName: string;
  readonly metadata: WorktreeProvenanceMetadata;
}

/**
 * Prepares an isolated worktree for a mission task with canonical branch naming
 * and persisted provenance metadata.
 */
export async function prepareTaskWorktree(
  options: PrepareTaskWorktreeOptions,
): Promise<PreparedTaskWorktreeResult> {
  const branchName = generateTaskBranchName({
    prefix: 'task',
    identifier: options.taskId,
    title: options.taskTitle,
  });

  const input: CreateWorktreeInput = {
    scope: options.scope,
    missionId: options.missionId,
    taskId: options.taskId,
    workerId: options.workerId,
    ownership: {
      files: options.files ?? [],
      symbols: options.symbols ?? [],
      domains: options.domains ?? [],
    },
    ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
  };

  const record = await options.manager.create(input);

  const metadata = writeWorktreeMetadata(record.worktreePath, {
    baseRefName: options.baseRefName ?? 'main',
    branchName,
    missionId: options.missionId,
    taskId: options.taskId,
    taskTitle: options.taskTitle,
    autoArchiveOnMerge: true,
  });

  return Object.freeze({
    record,
    branchName,
    metadata,
  });
}

export interface TeardownTaskWorktreeOptions {
  readonly mainRepoPath: string;
  readonly worktreePath: string;
  readonly force?: boolean;
  readonly deleteBranch?: boolean;
  readonly runner?: GitRunner;
}

/**
 * Tears down and cleans up an isolated worktree when a task is completed, merged or discarded.
 */
export function teardownTaskWorktree(
  options: TeardownTaskWorktreeOptions,
): ArchiveWorktreeResult {
  return archiveWorktree(
    {
      mainRepoPath: options.mainRepoPath,
      worktreePath: options.worktreePath,
      force: options.force,
      deleteBranch: options.deleteBranch,
    },
    options.runner,
  );
}

export { checkWorktreeStatus, readWorktreeMetadata };
