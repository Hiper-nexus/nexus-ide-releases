import { describe, expect, it } from 'vitest';
import { presentGitHubPRMergeState } from './github-pr-merge-state';

describe('presentGitHubPRMergeState', () => {
  it('uses the merge-queue label and Enfileirar action when a queue is required', () => {
    expect(
      presentGitHubPRMergeState({
        state: 'open',
        mergeQueueRequired: true,
      }),
    ).toMatchObject({
      label: 'Merge queue',
      directMergeAvailable: false,
      autoMergeAction: { kind: 'enable', label: 'Enfileirar' },
    });
  });

  it('hides Enfileirar once auto-merge is already on the queue', () => {
    expect(
      presentGitHubPRMergeState({
        state: 'open',
        mergeQueueRequired: true,
        autoMergeEnabled: true,
      }),
    ).toMatchObject({
      label: 'Na fila',
      autoMergeAction: { kind: 'disable' },
    });
  });

  it('blocks direct merge when review is required', () => {
    expect(
      presentGitHubPRMergeState({
        state: 'open',
        reviewDecision: 'REVIEW_REQUIRED',
        mergeQueueRequired: false,
      }),
    ).toMatchObject({
      label: 'Approval required',
      directMergeAvailable: false,
    });
  });
});
