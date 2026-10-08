// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: block API, Nexus theme colors,
// block-boundary grammar state, LRU and a timed 5k-line / 50k-character stress case.
import { beforeAll, describe, expect, it } from 'vitest'
import { buildMobileDiffLines, type MobileDiffLine } from '../session/mobile-diff-lines'
import { colors } from '../theme/mobile-theme'
import {
  MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE,
  MOBILE_REVIEW_HIGHLIGHT_CACHE_LIMIT,
  highlightMobileReviewBlock,
  mobileReviewBlockCount,
  mobileReviewBlockRange,
  mobileReviewBlocksForWindow,
  readMobileReviewHighlightedBlock,
  resolveMobileReviewLanguage
} from './mobile-review-highlight'
import {
  buildMobileReviewLines,
  type MobileReviewLineRow,
  type MobileReviewToken
} from './mobile-review-model'

let scopeCounter = 0
function reviewOf(lines: MobileDiffLine[]) {
  scopeCounter += 1
  return buildMobileReviewLines(lines, `test-${scopeCounter}`)
}

function contextRows(texts: string[]): MobileDiffLine[] {
  return texts.map((text, index) => ({
    kind: 'context',
    text,
    oldLineNumber: index + 1,
    newLineNumber: index + 1
  }))
}

function joined(tokens: ReadonlyArray<MobileReviewToken> | undefined): string {
  return (tokens ?? []).map((token) => token.content).join('')
}

async function highlightAll(
  review: { cacheKey: string; rows: MobileReviewLineRow[] },
  filePath: string
): Promise<Array<ReadonlyArray<MobileReviewToken>>> {
  const tokens: Array<ReadonlyArray<MobileReviewToken>> = []
  for (let block = 0; block < mobileReviewBlockCount(review.rows.length); block += 1) {
    tokens.push(
      ...(await highlightMobileReviewBlock({
        cacheKey: review.cacheKey,
        filePath,
        rows: review.rows,
        blockIndex: block
      }))
    )
  }
  return tokens
}

function colorOf(tokens: ReadonlyArray<MobileReviewToken>, content: string): string | undefined {
  return tokens.find((token) => token.content.includes(content))?.color?.toLowerCase()
}

describe('resolveMobileReviewLanguage', () => {
  it.each([
    ['src/app.ts', 'typescript'],
    ['src/App.tsx', 'tsx'],
    // JavaScript and JSX reuse the TSX grammar; C++ reuses the C grammar.
    ['src/view.jsx', 'tsx'],
    ['src/index.js', 'tsx'],
    ['scripts/build.mjs', 'tsx'],
    ['config/babel.cjs', 'tsx'],
    ['native/engine.cpp', 'c'],
    ['native/engine.cc', 'c'],
    ['native/engine.hpp', 'c'],
    ['native/engine.h', 'c'],
    ['pyproject.toml', 'toml'],
    ['scripts/run.sh', 'shellscript'],
    ['Dockerfile', 'docker'],
    ['changes.diff', 'diff'],
    ['fix.patch', 'diff'],
    ['notes.txt', 'text'],
    ['assets/logo.unknownext', 'text'],
    // Outside the curated list: shipped as plain text to keep grammars out of the bundle.
    ['config/app.xml', 'text'],
    ['scripts/build.ps1', 'text'],
    ['plugin/init.lua', 'text'],
    // Ruby's grammar embeds cpp and graphql (js/jsx/ts/tsx); kept plain to keep those out.
    ['app/models/user.rb', 'text']
  ])('maps %s to %s', (filePath, language) => {
    expect(resolveMobileReviewLanguage(filePath)).toBe(language)
  })
})

describe('mobileReviewBlocksForWindow', () => {
  it('covers the visible rows plus one block of lookahead, clamped to the file', () => {
    expect(mobileReviewBlockCount(450)).toBe(3)
    expect(mobileReviewBlocksForWindow(0, 0, 450)).toEqual([0, 1])
    expect(mobileReviewBlocksForWindow(390, 420, 450)).toEqual([1, 2])
    expect(mobileReviewBlocksForWindow(199, 200, 1_000)).toEqual([0, 1, 2])
    expect(mobileReviewBlocksForWindow(0, 0, 0)).toEqual([])
    expect(mobileReviewBlockRange(2, 450)).toEqual({ start: 400, end: 450 })
  })
})

describe('highlightMobileReviewBlock', () => {
  // Why: the JS regex engine compiles grammar patterns on first use; on a loaded
  // machine that can exceed Shiki's 500 ms per-line limit and leave the rest of a
  // line plain, so color assertions warm up first and retry on a fresh cache key.
  beforeAll(async () => {
    await highlightAll(reviewOf(contextRows(['const warm = 1 // warm-up'])), 'src/warm.ts')
  })

  it('paints tokens with the Nexus mobile syntax colors', { retry: 3 }, async () => {
    const review = reviewOf(contextRows(['const answer = 42 // note']))
    const [tokens] = await highlightAll(review, 'src/answer.ts')

    expect(joined(tokens)).toBe('const answer = 42 // note')
    expect(colorOf(tokens!, 'const')).toBe(colors.syntaxKeyword.toLowerCase())
    expect(colorOf(tokens!, '42')).toBe(colors.syntaxNumber.toLowerCase())
    expect(colorOf(tokens!, 'note')).toBe(colors.syntaxComment.toLowerCase())
  })

  it.each([
    ['src/index.js', 'const view = <App />'],
    ['native/engine.cpp', 'int main() { return 0; }']
  ])('still colors %s through its substitute grammar', { retry: 3 }, async (filePath, code) => {
    const [tokens] = await highlightAll(reviewOf(contextRows([code])), filePath)

    expect(joined(tokens)).toBe(code)
    const plain = colors.textPrimary.toLowerCase()
    expect(tokens!.some((token) => token.color && token.color.toLowerCase() !== plain)).toBe(true)
  })

  it('keeps lines longer than 1000 characters as raw text', async () => {
    const longLine = `const value = "${'a'.repeat(1_100)}";`
    const review = reviewOf(contextRows(['const before = 1;', longLine, 'const after = 2;']))
    const tokens = await highlightAll(review, 'src/long-line.ts')

    expect(tokens[1]).toEqual([{ content: longLine, color: null, fontStyle: null }])
    expect(tokens[0]!.some((token) => token.color !== null)).toBe(true)
    expect(tokens[2]!.some((token) => token.color !== null)).toBe(true)
  })

  it('keeps every row of 200-row blocks on its own old/new line numbers', async () => {
    // 400 x 400 stays under the LCS cell cap, so this exercises real change pairing.
    const original = Array.from({ length: 400 }, (_, index) => `const keep_${index + 1} = 1`)
    const modified = original.map((line, index) =>
      index % 7 === 3 ? `const changed_${index + 1} = 2` : line
    )
    const review = reviewOf(
      buildMobileDiffLines(`${original.join('\n')}\n`, `${modified.join('\n')}\n`).lines
    )
    const tokens = await highlightAll(review, 'src/blocks.ts')

    expect(review.rows.length).toBeGreaterThan(2 * MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE)
    expect(tokens).toHaveLength(review.rows.length)
    review.rows.forEach((row, index) => {
      expect(joined(tokens[index]), `row ${index}`).toBe(row.text)
      const lineNumber = row.kind === 'add' ? row.newLineNumber : row.oldLineNumber
      expect(row.text).toContain(`_${lineNumber} =`)
    })
  })

  it('carries grammar state across the 200-row block boundary', { retry: 3 }, async () => {
    const texts = [
      ...Array.from(
        { length: MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE - 1 },
        (_, i) => `const a${i} = ${i}`
      ),
      '/* comment opened in block 0',
      'still inside the comment',
      '*/',
      'const after = 1'
    ]
    const sequential = reviewOf(contextRows(texts))
    const tokens = await highlightAll(sequential, 'src/state.ts')
    expect(colorOf(tokens[MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE]!, 'still inside the comment')).toBe(
      colors.syntaxComment.toLowerCase()
    )

    const isolated = reviewOf(contextRows(texts))
    const [firstRowOfBlock1] = await highlightMobileReviewBlock({
      cacheKey: isolated.cacheKey,
      filePath: 'src/state.ts',
      rows: isolated.rows,
      blockIndex: 1
    })
    expect(joined(firstRowOfBlock1)).toBe('still inside the comment')
    expect(
      firstRowOfBlock1!.every(
        (token) => token.color?.toLowerCase() !== colors.syntaxComment.toLowerCase()
      )
    ).toBe(true)
  })

  it('reads deleted rows inside a comment opened on a context row', { retry: 3 }, async () => {
    const review = reviewOf([
      { kind: 'context', text: '/* opened before the change', oldLineNumber: 1, newLineNumber: 1 },
      { kind: 'delete', text: 'removed words inside', oldLineNumber: 2 },
      { kind: 'add', text: 'added words inside', newLineNumber: 2 },
      { kind: 'context', text: '*/', oldLineNumber: 3, newLineNumber: 3 },
      { kind: 'context', text: 'const after = 1', oldLineNumber: 4, newLineNumber: 4 }
    ])
    const [, deleted, added] = await highlightAll(review, 'src/comment.ts')
    const comment = colors.syntaxComment.toLowerCase()
    const allComment = (tokens: ReadonlyArray<MobileReviewToken> | undefined) =>
      (tokens ?? []).every(
        (token) => token.content.trim() === '' || token.color?.toLowerCase() === comment
      )

    expect(joined(deleted)).toBe('removed words inside')
    expect(allComment(deleted)).toBe(true)
    expect(allComment(added)).toBe(true)
  })

  it('carries the old-file state into deleted rows of the next block', { retry: 3 }, async () => {
    const size = MOBILE_REVIEW_HIGHLIGHT_BLOCK_SIZE
    const review = reviewOf([
      ...contextRows([
        ...Array.from({ length: size - 1 }, (_, i) => `const a${i} = ${i}`),
        '/* opened at the end of block 0'
      ]),
      { kind: 'delete', text: 'removed at the start of block 1', oldLineNumber: size + 1 },
      { kind: 'context', text: '*/', oldLineNumber: size + 2, newLineNumber: size + 1 }
    ])
    const tokens = await highlightAll(review, 'src/boundary.ts')

    expect(joined(tokens[size])).toBe('removed at the start of block 1')
    expect(colorOf(tokens[size]!, 'removed')).toBe(colors.syntaxComment.toLowerCase())
  })

  it('adds word-diff emphasis only on the changed span of paired rows', async () => {
    const review = reviewOf([
      { kind: 'delete', text: 'const before = 1;', oldLineNumber: 1 },
      { kind: 'add', text: 'const after = 1;', newLineNumber: 1 }
    ])
    const [deleted, added] = await highlightAll(review, 'src/word.ts')
    const emphasized = (tokens: ReadonlyArray<MobileReviewToken> | undefined) =>
      (tokens ?? [])
        .filter((token) => token.diffHighlight)
        .map((token) => token.content)
        .join('')

    expect(emphasized(deleted)).toBe('before')
    expect(emphasized(added)).toBe('after')
    expect(joined(deleted)).toBe('const before = 1;')
  })

  it('serves repeated blocks from an LRU cache and evicts the oldest', async () => {
    const review = reviewOf(contextRows(['plain text']))
    const input = { cacheKey: review.cacheKey, filePath: 'notes.txt', rows: review.rows }
    const first = await highlightMobileReviewBlock({ ...input, blockIndex: 0 })
    expect(await highlightMobileReviewBlock({ ...input, blockIndex: 0 })).toBe(first)
    expect(readMobileReviewHighlightedBlock({ ...input, blockIndex: 0 })).toBe(first)

    for (let index = 0; index < MOBILE_REVIEW_HIGHLIGHT_CACHE_LIMIT; index += 1) {
      const other = reviewOf(contextRows([`other ${index}`]))
      await highlightMobileReviewBlock({
        cacheKey: other.cacheKey,
        filePath: 'notes.txt',
        rows: other.rows,
        blockIndex: 0
      })
    }
    expect(readMobileReviewHighlightedBlock({ ...input, blockIndex: 0 })).toBeUndefined()
  })

  it('processes a 5k-line diff with a 50k-character minified line in bounded time', async () => {
    const calls = Array.from({ length: 10_000 }, (_, i) => `f${i}()`).join(',')
    const minifiedOld = `var a=${calls};`.slice(0, 50_000)
    const minifiedNew = `${minifiedOld.slice(0, 49_990)}g()};`.padEnd(50_000, ' ')
    const original = Array.from(
      { length: 5_000 },
      (_, index) => `export const value${index} = compute(${index}, 'item-${index}')`
    )
    original[500] = minifiedOld
    original[1_201] = minifiedOld
    const modified = [...original]
    modified[1_200] = "export const value1200 = compute(1200, 'changed')"
    modified[1_201] = minifiedNew

    // Why: CPU time of this process, not wall time, so a loaded CI box measures our
    // work instead of the scheduler; wall time is still printed and capped as a hang guard.
    const cpuMsSince = (since: ReturnType<typeof process.cpuUsage>) => {
      const used = process.cpuUsage(since)
      return (used.user + used.system) / 1_000
    }
    const parseCpu = process.cpuUsage()
    const review = buildMobileReviewLines(
      buildMobileDiffLines(`${original.join('\n')}\n`, `${modified.join('\n')}\n`).lines,
      'stress'
    )
    const parseCpuMs = cpuMsSince(parseCpu)

    // The longest CPU slice between two event-loop turns is how long the JS thread
    // would stay blocked on the device.
    let sliceCpu = process.cpuUsage()
    let longestSliceCpuMs = 0
    let ticking = true
    const tick = () => {
      longestSliceCpuMs = Math.max(longestSliceCpuMs, cpuMsSince(sliceCpu))
      sliceCpu = process.cpuUsage()
      if (ticking) {
        setTimeout(tick, 0)
      }
    }
    setTimeout(tick, 0)
    const highlightCpu = process.cpuUsage()
    const highlightStart = performance.now()
    const tokens = await highlightAll(review, 'dist/bundle.ts')
    const highlightWallMs = performance.now() - highlightStart
    const highlightCpuMs = cpuMsSince(highlightCpu)
    ticking = false

    console.info(
      `[mobile-review-highlight] rows=${review.rows.length}`,
      `parseCpu=${parseCpuMs.toFixed(0)}ms`,
      `highlightCpu=${highlightCpuMs.toFixed(0)}ms`,
      `highlightWall=${highlightWallMs.toFixed(0)}ms`,
      `longestSliceCpu=${longestSliceCpuMs.toFixed(0)}ms`
    )
    const rawRows = review.rows.flatMap((row, index) => (row.text.length === 50_000 ? [index] : []))
    expect(rawRows.length).toBe(3)
    for (const index of rawRows) {
      expect(tokens[index]).toEqual([
        { content: review.rows[index]!.text, color: null, fontStyle: null }
      ])
    }
    expect(tokens).toHaveLength(review.rows.length)
    expect(parseCpuMs).toBeLessThan(1_500)
    expect(highlightCpuMs).toBeLessThan(8_000)
    expect(longestSliceCpuMs).toBeLessThan(1_000)
    expect(highlightWallMs).toBeLessThan(60_000)
  })
})
