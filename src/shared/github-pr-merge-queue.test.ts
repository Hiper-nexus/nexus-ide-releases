import { describe, expect, it } from 'vitest';
import {
  classifyAsyncMergeResponse,
  directMergeBlocker,
  parseRepositoryMergeMetadata,
  planGitHubPREnqueue,
  resolveGitHubPRStackMergeAction,
} from './github-pr-merge-queue';

describe('parseRepositoryMergeMetadata', () => {
  it('marks merge queue required from mergeQueue id or MERGE_QUEUE rule', () => {
    expect(
      parseRepositoryMergeMetadata({ mergeQueue: { id: 'Q' }, autoMergeAllowed: true }, 'main'),
    ).toEqual({ mergeQueueRequired: true, autoMergeAllowed: true });
    expect(
      parseRepositoryMergeMetadata(
        { mergeQueue: null, ref: { rules: { nodes: [{ type: 'MERGE_QUEUE' }] } } },
        'main',
      ),
    ).toEqual({ mergeQueueRequired: true, autoMergeAllowed: null });
    expect(
      parseRepositoryMergeMetadata({ mergeQueue: null, autoMergeAllowed: false }, 'main'),
    ).toEqual({ mergeQueueRequired: false, autoMergeAllowed: false });
  });

  it('leaves mergeQueueRequired null when no branch was probed', () => {
    expect(parseRepositoryMergeMetadata({ mergeQueue: { id: 'Q' } }, undefined)).toEqual({
      mergeQueueRequired: null,
      autoMergeAllowed: null,
    });
  });
});

describe('planGitHubPREnqueue', () => {
  it('uses merge-when-ready on a queue branch and enqueue-now when asked', () => {
    expect(planGitHubPREnqueue({ mergeQueueRequired: true })).toEqual({ kind: 'when-ready' });
    expect(planGitHubPREnqueue({ mergeQueueRequired: true, mode: 'now' })).toEqual({
      kind: 'enqueue-now',
    });
  });

  it('routes stacked PRs through merge-async', () => {
    expect(planGitHubPREnqueue({ stacked: true, mergeQueueRequired: true })).toEqual({
      kind: 'stack-async',
      mergeAction: 'merge_queue',
    });
    expect(planGitHubPREnqueue({ stacked: true, mergeQueueRequired: false })).toEqual({
      kind: 'stack-async',
      mergeAction: 'direct_merge',
    });
  });

  it('refuses immediate enqueue when the base has no merge queue', () => {
    expect(planGitHubPREnqueue({ mergeQueueRequired: false, mode: 'now' })).toEqual({
      kind: 'refuse',
      reason: 'This base branch does not use GitHub merge queue.',
    });
  });
});

describe('classifyAsyncMergeResponse', () => {
  it('treats merged and enqueued as success', () => {
    expect(classifyAsyncMergeResponse({ status: 'enqueued' })).toEqual({ kind: 'success' });
    expect(classifyAsyncMergeResponse({ status: 'merged' })).toEqual({ kind: 'success' });
  });

  it('keeps a pending uuid for polling', () => {
    expect(
      classifyAsyncMergeResponse({ status: 'pending', details: { uuid: 'abc' } }),
    ).toEqual({ kind: 'pending', uuid: 'abc' });
  });
});

describe('directMergeBlocker', () => {
  it('blocks review and merge-queue the way Orca does', () => {
    expect(directMergeBlocker({ reviewDecision: 'REVIEW_REQUIRED' })).toMatch(/review approval/);
    expect(directMergeBlocker({ mergeQueueRequired: true })).toMatch(/merge queue/);
    expect(directMergeBlocker({})).toBeNull();
  });
});

describe('resolveGitHubPRStackMergeAction', () => {
  it('picks merge_queue only when the base requires it', () => {
    expect(resolveGitHubPRStackMergeAction(true)).toBe('merge_queue');
    expect(resolveGitHubPRStackMergeAction(false)).toBe('direct_merge');
    expect(resolveGitHubPRStackMergeAction(null)).toBe('direct_merge');
  });
});
