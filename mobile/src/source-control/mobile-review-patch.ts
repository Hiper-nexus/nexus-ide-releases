// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: rows use the Nexus review row shape
// with a row-index pair, the cache prefix is the caller scope (no patch hash), no Effect.
//
// Test oracle only: @pierre/diffs is a devDependency. App code must not import this file
// (mobile-review-model.test.ts fails if any non-test module does).
import { parsePatchFiles } from '@pierre/diffs/utils/parsePatchFiles'
import type { ChangeTypes, FileDiffMetadata } from '@pierre/diffs/types'
import type { MobileReviewLineRow } from './mobile-review-model'

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
      parsePatchFiles(text, cacheScope)
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
