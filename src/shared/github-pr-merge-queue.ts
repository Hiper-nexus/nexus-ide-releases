// Adapted from stablyai/orca @ 93334dc53fccdb7348d09fc28067ba6d3dec36ea
// (src/main/github/client.ts detectRepositoryMergeMetadata,
// github-pr-stack-async-merge.ts, getPRMergeBlocker).
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt.
// Nexus changes: pure functions only — no `gh` CLI, no Electron, no cache.

export type GitHubRepositoryMergeMetadata = {
  mergeQueueRequired: boolean | null;
  autoMergeAllowed: boolean | null;
};

export type GitHubPRStackMergeAction = 'direct_merge' | 'merge_queue';

export type GitHubPREnqueueMode = 'when-ready' | 'now';

export type GitHubPREnqueuePlan =
  | { kind: 'when-ready' }
  | { kind: 'enqueue-now' }
  | { kind: 'stack-async'; mergeAction: GitHubPRStackMergeAction }
  | { kind: 'refuse'; reason: string };

export type AsyncMergeResponse = {
  status?: unknown;
  details?: {
    message?: unknown;
    uuid?: unknown;
  };
};

export type AsyncMergeResult =
  | { kind: 'pending'; uuid: string }
  | { kind: 'success' }
  | { kind: 'failure'; message: string };

type MergeQueueRepository = {
  autoMergeAllowed?: unknown;
  mergeQueue?: { id?: unknown } | null;
  ref?: { rules?: { nodes?: ({ type?: unknown } | null)[] | null } | null } | null;
};

export function parseRepositoryMergeMetadata(
  repository: MergeQueueRepository | null | undefined,
  branchName: string | undefined,
): GitHubRepositoryMergeMetadata {
  return {
    mergeQueueRequired: branchName
      ? Boolean(repository?.mergeQueue) ||
        Boolean(repository?.ref?.rules?.nodes?.some((rule) => rule?.type === 'MERGE_QUEUE'))
      : null,
    autoMergeAllowed:
      typeof repository?.autoMergeAllowed === 'boolean' ? repository.autoMergeAllowed : null,
  };
}

export function resolveGitHubPRStackMergeAction(
  mergeQueueRequired: boolean | null | undefined,
): GitHubPRStackMergeAction {
  return mergeQueueRequired === true ? 'merge_queue' : 'direct_merge';
}

export function classifyAsyncMergeResponse(response: AsyncMergeResponse): AsyncMergeResult {
  if (response.status === 'merged' || response.status === 'enqueued') {
    return { kind: 'success' };
  }
  if (response.status === 'pending' && typeof response.details?.uuid === 'string') {
    return { kind: 'pending', uuid: response.details.uuid };
  }
  const message =
    typeof response.details?.message === 'string'
      ? response.details.message
      : 'GitHub could not merge this stack.';
  return { kind: 'failure', message };
}

export function directMergeBlocker(input: {
  reviewDecision?: string | null;
  mergeQueueRequired?: boolean | null;
}): string | null {
  if (input.reviewDecision === 'REVIEW_REQUIRED') {
    return 'This pull request requires review approval before it can be merged.';
  }
  if (input.reviewDecision === 'CHANGES_REQUESTED') {
    return 'This pull request has requested changes and cannot be merged yet.';
  }
  if (input.mergeQueueRequired === true) {
    return 'This pull request must be merged through GitHub merge queue. Use Merge when ready instead.';
  }
  return null;
}

/**
 * Orca: fila do GitHub = "Merge when ready" (auto-merge) na branch com
 * merge queue; stack usa PUT merge-async com merge_action=merge_queue;
 * enqueue imediato só quando o operador pede `now`.
 */
export function planGitHubPREnqueue(input: {
  mergeQueueRequired?: boolean | null;
  stacked?: boolean;
  mode?: GitHubPREnqueueMode;
}): GitHubPREnqueuePlan {
  const mode = input.mode ?? 'when-ready';
  if (input.stacked) {
    return {
      kind: 'stack-async',
      mergeAction: resolveGitHubPRStackMergeAction(input.mergeQueueRequired),
    };
  }
  if (input.mergeQueueRequired === true) {
    return mode === 'now' ? { kind: 'enqueue-now' } : { kind: 'when-ready' };
  }
  if (mode === 'when-ready') {
    return { kind: 'when-ready' };
  }
  return {
    kind: 'refuse',
    reason: 'This base branch does not use GitHub merge queue.',
  };
}

export function normalizeMergeStateStatus(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.trim().toUpperCase();
}
