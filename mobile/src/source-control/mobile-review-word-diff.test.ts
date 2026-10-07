// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: vitest imports; adds a test that only
// the changed span is marked.
import { describe, expect, it } from 'vitest'
import { applyDiffRangesToTokens, computeWordAltDiffRanges } from './mobile-review-word-diff'

describe('computeWordAltDiffRanges', () => {
  it('marks only the changed word on each side', () => {
    const deletionLine = 'const before = 1;'
    const additionLine = 'const after = 1;'
    const ranges = computeWordAltDiffRanges({ deletionLine, additionLine })

    expect(ranges.deletion.map((range) => deletionLine.slice(range.start, range.end))).toEqual([
      'before'
    ])
    expect(ranges.addition.map((range) => additionLine.slice(range.start, range.end))).toEqual([
      'after'
    ])
  })

  it('joins adjacent word replacements across a single shared separator', () => {
    const ranges = computeWordAltDiffRanges({
      deletionLine: 'old old',
      additionLine: 'new new'
    })

    expect(ranges.deletion).toEqual([{ start: 0, end: 'old old'.length }])
    expect(ranges.addition).toEqual([{ start: 0, end: 'new new'.length }])
  })

  it('skips inline word diffs for long lines', () => {
    const longDeletion = `const before = "${'a'.repeat(1_001)}";`
    const longAddition = `const after = "${'b'.repeat(1_001)}";`

    const ranges = computeWordAltDiffRanges({
      deletionLine: longDeletion,
      additionLine: longAddition
    })

    expect(ranges.deletion).toEqual([])
    expect(ranges.addition).toEqual([])
  })
})

describe('applyDiffRangesToTokens', () => {
  it('splits highlighted fragments out of syntax tokens', () => {
    const tokens = [{ content: 'const before = 1;', color: '#fff', fontStyle: null }]
    const nextTokens = applyDiffRangesToTokens(tokens, [{ start: 6, end: 12 }])

    expect(nextTokens).toEqual([
      { content: 'const ', color: '#fff', fontStyle: null, diffHighlight: false },
      { content: 'before', color: '#fff', fontStyle: null, diffHighlight: true },
      { content: ' = 1;', color: '#fff', fontStyle: null, diffHighlight: false }
    ])
  })

  it('skips exhausted ranges when later tokens start after the last range', () => {
    const tokens = [
      { content: 'a', color: '#fff', fontStyle: null },
      { content: 'b', color: '#fff', fontStyle: null }
    ]

    const nextTokens = applyDiffRangesToTokens(tokens, [{ start: 0, end: 1 }])

    expect(nextTokens).toEqual([
      { content: 'a', color: '#fff', fontStyle: null, diffHighlight: true },
      { content: 'b', color: '#fff', fontStyle: null }
    ])
  })
})
