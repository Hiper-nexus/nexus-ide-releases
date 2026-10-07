import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewToken } from 'react-native'
import {
  MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE,
  highlightMobileReviewBlock,
  mobileReviewBlocksForWindow,
  readMobileReviewHighlightedBlock
} from '../source-control/mobile-review-highlight'
import type { MobileReviewLineRow, MobileReviewToken } from '../source-control/mobile-review-model'

type BlockTokens = ReadonlyMap<number, ReadonlyArray<ReadonlyArray<MobileReviewToken>>>

type HighlightedBlocks = {
  readonly key: string | null
  readonly tokens: BlockTokens
}

const EMPTY_BLOCKS: HighlightedBlocks = { key: null, tokens: new Map() }
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 10 }

/**
 * Syntax colors for the review list, one 200-row block at a time: only blocks
 * on screen (plus the next one) are tokenized, sequentially, off the load path.
 */
export function useMobileDiffReviewBlockHighlights(input: {
  cacheKey: string | null
  filePath: string | null
  rows: ReadonlyArray<MobileReviewLineRow>
}) {
  const { cacheKey, filePath, rows } = input
  const [blocks, setBlocks] = useState<HighlightedBlocks>(EMPTY_BLOCKS)
  const latestRef = useRef({ cacheKey, filePath, rows })
  latestRef.current = { cacheKey, filePath, rows }
  const requestedRef = useRef<{ key: string | null; blocks: Set<number> }>({
    key: null,
    blocks: new Set()
  })
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  const commitBlock = useCallback(
    (key: string, blockIndex: number, tokens: ReadonlyArray<ReadonlyArray<MobileReviewToken>>) => {
      setBlocks((previous) => {
        if (latestRef.current.cacheKey !== key) {
          return previous
        }
        const next = new Map(previous.key === key ? previous.tokens : undefined)
        next.set(blockIndex, tokens)
        return { key, tokens: next }
      })
    },
    []
  )

  const requestBlocks = useCallback(
    (blockIndexes: readonly number[]) => {
      const { cacheKey: key, filePath: path, rows: currentRows } = latestRef.current
      if (!key || !path) {
        return
      }
      if (requestedRef.current.key !== key) {
        requestedRef.current = { key, blocks: new Set() }
      }
      const requested = requestedRef.current.blocks
      for (const blockIndex of blockIndexes) {
        if (requested.has(blockIndex)) {
          continue
        }
        requested.add(blockIndex)
        const blockInput = { cacheKey: key, filePath: path, rows: currentRows, blockIndex }
        const cached = readMobileReviewHighlightedBlock(blockInput)
        if (cached) {
          commitBlock(key, blockIndex, cached)
          continue
        }
        // Why: one block at a time, in request order, so a block can continue the
        // grammar state of the one above it and the JS thread gets turns in between.
        queueRef.current = queueRef.current.then(async () => {
          if (latestRef.current.cacheKey !== key) {
            requested.delete(blockIndex)
            return
          }
          try {
            commitBlock(key, blockIndex, await highlightMobileReviewBlock(blockInput))
          } catch {
            requested.delete(blockIndex)
          }
        })
      }
    },
    [commitBlock]
  )

  useEffect(() => {
    if (cacheKey && filePath) {
      requestBlocks(mobileReviewBlocksForWindow(0, 0, latestRef.current.rows.length))
    }
  }, [cacheKey, filePath, requestBlocks])

  // Why: FlatList rejects a new onViewableItemsChanged after mount, so this stays
  // stable and reads the current file through refs.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    let first = Number.POSITIVE_INFINITY
    let last = Number.NEGATIVE_INFINITY
    for (const item of viewableItems) {
      if (typeof item.index === 'number') {
        first = Math.min(first, item.index)
        last = Math.max(last, item.index)
      }
    }
    if (first <= last) {
      requestBlocks(mobileReviewBlocksForWindow(first, last, latestRef.current.rows.length))
    }
  }).current

  const tokensForRow = (index: number): ReadonlyArray<MobileReviewToken> | null => {
    if (blocks.key !== cacheKey) {
      return null
    }
    const block = blocks.tokens.get(Math.floor(index / MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE))
    return block?.[index % MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE] ?? null
  }

  return {
    highlightVersion: blocks,
    onViewableItemsChanged,
    tokensForRow,
    viewabilityConfig: VIEWABILITY_CONFIG
  }
}
