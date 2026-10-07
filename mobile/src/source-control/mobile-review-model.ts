// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: rows use the Nexus MobileDiffLine
// shape (kind/text/oldLineNumber/newLineNumber) with a row-index pair instead of token indices,
// the pairing runs over the Nexus LCS lines, no Effect, no review sections. The upstream patch
// parser lives in mobile-review-patch.ts (test oracle only, keeps @pierre/diffs out of the app).
import type { MobileDiffLine } from '../session/mobile-diff-lines'

export type MobileReviewToken = {
  content: string
  readonly color: string | null
  readonly fontStyle: number | null
  readonly diffHighlight?: boolean
}

export type MobileReviewLineRow = MobileDiffLine & {
  readonly id: string
  /** Index (in the same rows array) of the opposite-side line this one replaced. */
  readonly pairIndex: number | null
}

export type MobileReviewLines = {
  readonly cacheKey: string
  readonly rows: MobileReviewLineRow[]
  readonly additions: number
  readonly deletions: number
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const FNV_PRIME_32 = 0x01000193
const SECONDARY_HASH_SEED = 0x9e3779b9
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b

function fnv1a32(input: string, seed: number, multiplier: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, multiplier) >>> 0
  }
  return hash >>> 0
}

// Why: the upstream patch cache key's two FNV hashes, fed line by line so a minified
// multi-megabyte file is never joined into one more string just to key the cache.
function buildLinesCacheKey(lines: readonly MobileDiffLine[], scope: string): string {
  let primary = FNV_OFFSET_BASIS_32
  let secondary = SECONDARY_HASH_SEED
  let length = 0
  for (const line of lines) {
    const framed = `${line.kind}:${line.oldLineNumber ?? ''}:${line.newLineNumber ?? ''}\n`
    primary = fnv1a32(framed, primary, FNV_PRIME_32)
    secondary = fnv1a32(framed, secondary, SECONDARY_HASH_MULTIPLIER)
    primary = fnv1a32(line.text, primary, FNV_PRIME_32)
    secondary = fnv1a32(line.text, secondary, SECONDARY_HASH_MULTIPLIER)
    length += framed.length + line.text.length
  }
  return `${scope}:${length}:${primary.toString(36)}:${secondary.toString(36)}`
}

/**
 * Turns the Nexus LCS lines into review rows. A change block (consecutive
 * deletions/additions) pairs its i-th deletion with its i-th addition, which is
 * how the upstream patch rows pair `comparison` lines for word diffs.
 */
export function buildMobileReviewLines(
  lines: readonly MobileDiffLine[],
  cacheScope: string
): MobileReviewLines {
  const cacheKey = buildLinesCacheKey(lines, cacheScope)
  const pairIndexByRow = new Map<number, number>()
  let additions = 0
  let deletions = 0
  let deletionRows: number[] = []
  let additionRows: number[] = []

  const closeChangeBlock = () => {
    const pairedLineCount = Math.min(deletionRows.length, additionRows.length)
    for (let index = 0; index < pairedLineCount; index += 1) {
      const deletionRow = deletionRows[index]!
      const additionRow = additionRows[index]!
      pairIndexByRow.set(deletionRow, additionRow)
      pairIndexByRow.set(additionRow, deletionRow)
    }
    deletionRows = []
    additionRows = []
  }

  lines.forEach((line, index) => {
    if (line.kind === 'delete') {
      deletions += 1
      deletionRows.push(index)
      return
    }
    if (line.kind === 'add') {
      additions += 1
      additionRows.push(index)
      return
    }
    closeChangeBlock()
  })
  closeChangeBlock()

  return {
    cacheKey,
    additions,
    deletions,
    rows: lines.map((line, index) => ({
      ...line,
      id: `${cacheKey}:row:${index}`,
      pairIndex: pairIndexByRow.get(index) ?? null
    }))
  }
}
