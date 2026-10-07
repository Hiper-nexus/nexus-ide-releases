// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: rows use the Nexus MobileDiffLine
// shape (kind/text/oldLineNumber/newLineNumber) with a row-index pair instead of token indices,
// the same pairing also runs over the Nexus LCS lines, no Effect, no review sections.
import { parsePatchFiles } from '@pierre/diffs/utils/parsePatchFiles'
import type { ChangeTypes, FileDiffMetadata } from '@pierre/diffs/types'
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

export type MobileReviewHunkRow = {
  readonly kind: 'hunk'
  readonly id: string
  readonly header: string
  readonly context: string | null
}

export type MobileReviewPatchRow = MobileReviewHunkRow | MobileReviewLineRow

export type MobileReviewRenderableFile = {
  readonly id: string
  readonly cacheKey: string
  readonly path: string
  readonly previousPath: string | null
  readonly changeType: ChangeTypes
  readonly additions: number
  readonly deletions: number
  readonly languageHint: string | null
  readonly rows: ReadonlyArray<MobileReviewPatchRow>
}

export type MobileReviewParsedDiff =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'raw'
      readonly text: string
      readonly reason: string
      readonly notice: string | null
    }
  | {
      readonly kind: 'files'
      readonly files: ReadonlyArray<MobileReviewRenderableFile>
      readonly fileCount: number
      readonly additions: number
      readonly deletions: number
      readonly notice: string | null
    }

export type MobileReviewLines = {
  readonly cacheKey: string
  readonly rows: MobileReviewLineRow[]
  readonly additions: number
  readonly deletions: number
}

function stripTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value
}

function splitTruncationMarker(diff: string): {
  readonly text: string
  readonly truncated: boolean
} {
  const trimmed = diff.trimEnd()
  if (!trimmed.endsWith('[truncated]')) {
    return { text: trimmed, truncated: false }
  }
  return { text: trimmed.replace(/\n*\[truncated\]\s*$/, '').trimEnd(), truncated: true }
}

function runDiffParserSilently<T>(callback: () => T): T {
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    return callback()
  } finally {
    console.error = originalConsoleError
  }
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

function buildPatchCacheKey(patch: string, scope: string): string {
  const normalizedPatch = patch.trim()
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36)
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER
  ).toString(36)
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`
}

// Why: same two FNV hashes as buildPatchCacheKey, fed line by line so a minified
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

function fallbackHunkHeader(hunk: FileDiffMetadata['hunks'][number]): string {
  const deletion = `-${hunk.deletionStart},${hunk.deletionCount}`
  return `@@ ${deletion} +${hunk.additionStart},${hunk.additionCount} @@`
}

function buildRenderableRows(file: FileDiffMetadata): ReadonlyArray<MobileReviewPatchRow> {
  const rows: MobileReviewPatchRow[] = []
  let rowIndex = 0
  const rowId = () => `${file.cacheKey ?? file.name}:row:${rowIndex++}`

  file.hunks.forEach((hunk, hunkIndex) => {
    rows.push({
      kind: 'hunk',
      id: `${file.cacheKey ?? file.name}:hunk:${hunkIndex}`,
      header: fallbackHunkHeader(hunk),
      context: hunk.hunkContext ? stripTrailingNewline(hunk.hunkContext) : null
    })

    let deletionLineNumber = hunk.deletionStart
    let additionLineNumber = hunk.additionStart
    let deletionTokenIndex = hunk.deletionLineIndex
    let additionTokenIndex = hunk.additionLineIndex

    hunk.hunkContent.forEach((segment) => {
      if (segment.type === 'context') {
        for (let index = 0; index < segment.lines; index += 1) {
          rows.push({
            kind: 'context',
            id: rowId(),
            text: stripTrailingNewline(
              file.additionLines[additionTokenIndex] ?? file.deletionLines[deletionTokenIndex] ?? ''
            ),
            oldLineNumber: deletionLineNumber,
            newLineNumber: additionLineNumber,
            pairIndex: null
          })
          deletionLineNumber += 1
          additionLineNumber += 1
          deletionTokenIndex += 1
          additionTokenIndex += 1
        }
        return
      }

      const pairedLineCount = Math.min(segment.deletions, segment.additions)
      const deletionRowStart = rows.length
      const additionRowStart = deletionRowStart + segment.deletions

      for (let index = 0; index < segment.deletions; index += 1) {
        rows.push({
          kind: 'delete',
          id: rowId(),
          text: stripTrailingNewline(file.deletionLines[deletionTokenIndex] ?? ''),
          oldLineNumber: deletionLineNumber,
          pairIndex: index < pairedLineCount ? additionRowStart + index : null
        })
        deletionLineNumber += 1
        deletionTokenIndex += 1
      }

      for (let index = 0; index < segment.additions; index += 1) {
        rows.push({
          kind: 'add',
          id: rowId(),
          text: stripTrailingNewline(file.additionLines[additionTokenIndex] ?? ''),
          newLineNumber: additionLineNumber,
          pairIndex: index < pairedLineCount ? deletionRowStart + index : null
        })
        additionLineNumber += 1
        additionTokenIndex += 1
      }
    })
  })

  return rows
}

function mapRenderableFile(file: FileDiffMetadata): MobileReviewRenderableFile {
  const path = file.name || file.prevName || ''
  const previousPath = file.prevName || null
  const additions = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0)
  const deletions = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0)
  const cacheKey = file.cacheKey ?? `${previousPath ?? 'none'}:${path}:${file.type}`

  return {
    id: cacheKey,
    cacheKey,
    path,
    previousPath,
    changeType: file.type,
    additions,
    deletions,
    languageHint: file.lang ?? null,
    rows: buildRenderableRows(file)
  }
}

/** Parses unified/git patch text (e.g. `git diff` output) into review rows. */
export function buildMobileReviewParsedDiff(
  diff: string | null | undefined,
  cacheScope: string
): MobileReviewParsedDiff {
  const normalized = diff?.trim()
  if (!normalized) {
    return { kind: 'empty' }
  }

  const { text, truncated } = splitTruncationMarker(normalized)
  if (text.length === 0) {
    return { kind: 'empty' }
  }

  const notice = truncated
    ? 'Diff output hit the server size cap. Showing the available excerpt.'
    : null

  try {
    const parsedPatches = runDiffParserSilently(() =>
      parsePatchFiles(text, buildPatchCacheKey(text, cacheScope))
    )
    const files = parsedPatches.flatMap((patch) => patch.files).map(mapRenderableFile)

    if (files.length === 0) {
      return {
        kind: 'raw',
        text,
        reason: truncated
          ? 'Diff was truncated before it could be parsed completely. Showing the raw excerpt.'
          : 'Unsupported diff format. Showing raw patch.',
        notice
      }
    }

    return {
      kind: 'files',
      files,
      fileCount: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      notice
    }
  } catch {
    return {
      kind: 'raw',
      text,
      reason: truncated
        ? 'Diff was truncated before it could be parsed completely. Showing the raw excerpt.'
        : 'Failed to parse patch. Showing raw patch.',
      notice
    }
  }
}
