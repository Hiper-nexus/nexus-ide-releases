import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import { loadMobileDiffReviewDiff } from './mobile-diff-review-loaders'

const DELETED_ITEM: MobileDiffReviewQueueItem = {
  key: 'unstaged\0unstaged\0\0deleted.ts',
  scope: 'unstaged',
  area: 'unstaged',
  filePath: 'deleted.ts',
  status: 'deleted',
  title: 'deleted.ts',
  subtitle: 'Unstaged',
  canStage: true,
  canUnstage: false,
  canDiscard: true,
  isGeneratedOrLockFile: false,
  diffIdentity: 'deleted-diff',
  noteCount: 0,
  unsentNoteCount: 0,
  staleNoteCount: 0,
  isReviewed: false,
  changedSinceReview: false
}

function clientWith(response: RpcResponse): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue(response)
  } as unknown as RpcClient
}

function failure(code: string, message: string): RpcResponse {
  return { id: 'rpc-1', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

describe('loadMobileDiffReviewDiff', () => {
  it('returns paired review rows keyed by content, leaving syntax colors to the list', async () => {
    const response: RpcResponse = {
      id: 'rpc-1',
      ok: true,
      result: { kind: 'text', originalContent: 'a\nold\nz\n', modifiedContent: 'a\nnew\nz\n' },
      _meta: { runtimeId: 'runtime-1' }
    }
    const diff = await loadMobileDiffReviewDiff({
      client: clientWith(response),
      worktreeId: 'wt-1',
      item: { ...DELETED_ITEM, status: 'modified' },
      branchCompare: null
    })

    expect(diff.kind).toBe('ready')
    if (diff.kind !== 'ready') {
      return
    }
    expect(diff.cacheKey).toEqual(expect.any(String))
    expect(diff.lines.map(({ kind, text, pairIndex }) => ({ kind, text, pairIndex }))).toEqual([
      { kind: 'context', text: 'a', pairIndex: null },
      { kind: 'delete', text: 'old', pairIndex: 2 },
      { kind: 'add', text: 'new', pairIndex: 1 },
      { kind: 'context', text: 'z', pairIndex: null }
    ])
    expect(diff.lines[0]).not.toHaveProperty('segments')
    expect(diff.hunks).toHaveLength(1)
  })

  it('shows the too-large state for an oversized deleted diff', async () => {
    await expect(
      loadMobileDiffReviewDiff({
        client: clientWith(failure('diff_too_large', 'Diff too large')),
        worktreeId: 'wt-1',
        item: DELETED_ITEM,
        branchCompare: null
      })
    ).resolves.toEqual({ kind: 'too-large', itemKey: DELETED_ITEM.key })
  })

  it('keeps the deleted fallback for hosts that cannot return deleted content', async () => {
    await expect(
      loadMobileDiffReviewDiff({
        client: clientWith(failure('internal_error', 'Unable to read deleted file')),
        worktreeId: 'wt-1',
        item: DELETED_ITEM,
        branchCompare: null
      })
    ).resolves.toEqual({ kind: 'deleted', itemKey: DELETED_ITEM.key })
  })
})
