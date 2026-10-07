import { createElement } from 'react'
import type { ViewToken } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMobileReviewLines } from '../source-control/mobile-review-model'
import type { MobileDiffLine } from './mobile-diff-lines'
import { useMobileDiffReviewBlockHighlights } from './use-mobile-diff-review-block-highlights'

type Highlights = ReturnType<typeof useMobileDiffReviewBlockHighlights>
type HarnessProps = Parameters<typeof useMobileDiffReviewBlockHighlights>[0]

let latest: Highlights | null = null
function Harness(props: HarnessProps) {
  latest = useMobileDiffReviewBlockHighlights(props)
  return null
}

function rowsOf(count: number, scope: string, prefix = 'line') {
  const lines: MobileDiffLine[] = Array.from({ length: count }, (_, index) => ({
    kind: 'context',
    text: `${prefix} ${index}`,
    oldLineNumber: index + 1,
    newLineNumber: index + 1
  }))
  return buildMobileReviewLines(lines, scope)
}

async function settle(until: () => boolean) {
  for (let attempt = 0; attempt < 50 && !until(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

function viewable(...indexes: number[]): { viewableItems: ViewToken[] } {
  return {
    viewableItems: indexes.map((index) => ({ index, isViewable: true, item: null, key: `${index}` }))
  }
}

describe('useMobileDiffReviewBlockHighlights', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    latest = null
  })

  it('tokenizes only the blocks in the visible window plus one block below', async () => {
    const review = rowsOf(1_000, 'window')
    const props = { cacheKey: review.cacheKey, filePath: 'notes.txt', rows: review.rows }
    await act(async () => {
      renderer = create(createElement(Harness, props))
    })
    await settle(() => latest?.tokensForRow(399) !== null)

    expect(latest!.tokensForRow(0)).toEqual([{ content: 'line 0', color: null, fontStyle: null }])
    expect(latest!.tokensForRow(399)).not.toBeNull()
    expect(latest!.tokensForRow(400)).toBeNull()
    expect(latest!.tokensForRow(999)).toBeNull()

    act(() => latest!.onViewableItemsChanged(viewable(820, 840)))
    await settle(() => latest?.tokensForRow(999) !== null)

    expect(latest!.tokensForRow(999)).toEqual([
      { content: 'line 999', color: null, fontStyle: null }
    ])
    expect(latest!.tokensForRow(500)).toBeNull()
  })

  it('drops the previous file tokens as soon as the diff content changes', async () => {
    const first = rowsOf(10, 'first')
    await act(async () => {
      renderer = create(
        createElement(Harness, { cacheKey: first.cacheKey, filePath: 'a.txt', rows: first.rows })
      )
    })
    await settle(() => latest?.tokensForRow(0) !== null)
    expect(latest!.tokensForRow(0)).not.toBeNull()

    const second = rowsOf(10, 'second', 'other')
    await act(async () => {
      renderer!.update(
        createElement(Harness, { cacheKey: second.cacheKey, filePath: 'a.txt', rows: second.rows })
      )
    })
    // Never the first file's tokens on the second file's rows.
    expect(latest!.tokensForRow(0)?.[0]?.content ?? 'other 0').toBe('other 0')
    await settle(() => latest?.tokensForRow(0) !== null)
    expect(latest!.tokensForRow(0)?.[0]?.content).toBe('other 0')
  })
})
