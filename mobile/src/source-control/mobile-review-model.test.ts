// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: assertions use the Nexus row shape;
// adds LCS pairing tests and line-number parity against a real `git diff`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMobileDiffLines, type MobileDiffLine } from '../session/mobile-diff-lines'
import {
  buildMobileReviewLines,
  buildMobileReviewParsedDiff,
  type MobileReviewLineRow,
  type MobileReviewPatchRow
} from './mobile-review-model'

function realGitDiff(original: string, modified: string, context: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-review-parity-'))
  try {
    writeFileSync(join(dir, 'before.ts'), original)
    writeFileSync(join(dir, 'after.ts'), modified)
    const args = ['diff', '--no-index', '--no-color', '--no-ext-diff', `-U${context}`]
    try {
      return execFileSync('git', [...args, 'before.ts', 'after.ts'], {
        cwd: dir,
        encoding: 'utf8',
        // Why: a user diff.algorithm or color config must not change the oracle.
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
      })
    } catch (error) {
      // `git diff --no-index` exits 1 when the files differ.
      const failure = error as { status?: number; stdout?: string }
      if (failure.status === 1 && failure.stdout) {
        return failure.stdout
      }
      throw error
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function lineRows(rows: ReadonlyArray<MobileReviewPatchRow>): MobileReviewLineRow[] {
  return rows.filter((row): row is MobileReviewLineRow => row.kind !== 'hunk')
}

function numbersOf(line: MobileDiffLine) {
  return {
    kind: line.kind,
    text: line.text,
    oldLineNumber: line.oldLineNumber,
    newLineNumber: line.newLineNumber
  }
}

// Pair indexes point into the array they were built for (patch rows include hunk headers).
function pairsOf(rows: ReadonlyArray<MobileReviewPatchRow>): string[] {
  return lineRows(rows)
    .filter((row) => row.kind === 'delete' && row.pairIndex !== null)
    .map((row) => {
      const partner = rows[row.pairIndex!]
      const partnerLine = partner && partner.kind === 'add' ? partner.newLineNumber : '?'
      return `${row.oldLineNumber}->${partnerLine}`
    })
}

function parseFiles(patch: string) {
  const parsed = buildMobileReviewParsedDiff(patch, 'parity')
  if (parsed.kind !== 'files') {
    throw new Error(`expected files, got ${parsed.kind}`)
  }
  return parsed
}

const ORIGINAL = Array.from(
  { length: 40 },
  (_, index) => `export const value${index + 1} = compute(${index + 1})`
)
const MODIFIED = [...ORIGINAL]
MODIFIED[4] = 'export const value5 = compute(500)'
MODIFIED.splice(11, 2)
MODIFIED.splice(18, 0, 'export const inserted1 = 1', 'export const inserted2 = 2')
MODIFIED[30] = 'export const value31 = recompute(31)'
MODIFIED.push('export const appended = true')
const ORIGINAL_TEXT = `${ORIGINAL.join('\n')}\n`
const MODIFIED_TEXT = `${MODIFIED.join('\n')}\n`

describe('buildMobileReviewParsedDiff', () => {
  it.each([
    ['example.ts', 'example.ts'],
    ['before.ts', 'after.ts']
  ])('preserves repository paths from %s to %s', (previousPath, path) => {
    const parsed = parseFiles(
      [
        `diff --git a/${previousPath} b/${path}`,
        ...(previousPath === path
          ? []
          : ['similarity index 50%', `rename from ${previousPath}`, `rename to ${path}`]),
        `--- a/${previousPath}`,
        `+++ b/${path}`,
        '@@ -1 +1 @@',
        '-before',
        '+after'
      ].join('\n')
    )
    expect(parsed.files[0]).toMatchObject({
      path,
      previousPath: previousPath === path ? null : previousPath,
      additions: 1,
      deletions: 1
    })
  })

  it('builds Nexus-shaped rows with counters and pairs from a unified patch', () => {
    const parsed = parseFiles(
      [
        'diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts',
        'index 1111111..2222222 100644',
        '--- a/apps/mobile/src/a.ts',
        '+++ b/apps/mobile/src/a.ts',
        '@@ -1,2 +1,3 @@',
        '-const before = 1;',
        '+const after = 2;',
        '+console.log(after);',
        ' return true;'
      ].join('\n')
    )

    expect(parsed).toMatchObject({ fileCount: 1, additions: 2, deletions: 1 })
    expect(parsed.files[0]?.rows).toEqual([
      expect.objectContaining({ kind: 'hunk', header: '@@ -1,2 +1,3 @@' }),
      expect.objectContaining({
        kind: 'delete',
        text: 'const before = 1;',
        oldLineNumber: 1,
        pairIndex: 2
      }),
      expect.objectContaining({
        kind: 'add',
        text: 'const after = 2;',
        newLineNumber: 1,
        pairIndex: 1
      }),
      expect.objectContaining({
        kind: 'add',
        text: 'console.log(after);',
        newLineNumber: 2,
        pairIndex: null
      }),
      expect.objectContaining({
        kind: 'context',
        text: 'return true;',
        oldLineNumber: 2,
        newLineNumber: 3,
        pairIndex: null
      })
    ])
  })

  it('treats truncated patches as partial diffs instead of failing', () => {
    const parsed = parseFiles(
      [
        'diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts',
        'index 1111111..2222222 100644',
        '--- a/apps/mobile/src/a.ts',
        '+++ b/apps/mobile/src/a.ts',
        '@@ -1 +1,2 @@',
        ' const before = 1;',
        '+const after = 2;',
        '',
        '[truncated]'
      ].join('\n')
    )
    expect(parsed.notice).toContain('server size cap')
    expect(parsed.files[0]?.rows[0]).toMatchObject({ kind: 'hunk', header: '@@ -1,1 +1,2 @@' })
  })

  it('returns raw text for input that is not a patch', () => {
    expect(buildMobileReviewParsedDiff('just some prose', 'raw')).toMatchObject({ kind: 'raw' })
    expect(buildMobileReviewParsedDiff('  ', 'empty')).toEqual({ kind: 'empty' })
  })
})

describe('buildMobileReviewLines', () => {
  it('pairs the i-th deletion with the i-th addition of each change block', () => {
    const review = buildMobileReviewLines(
      [
        { kind: 'context', text: 'a', oldLineNumber: 1, newLineNumber: 1 },
        { kind: 'delete', text: 'b', oldLineNumber: 2 },
        { kind: 'delete', text: 'c', oldLineNumber: 3 },
        { kind: 'add', text: 'B', newLineNumber: 2 },
        { kind: 'context', text: 'd', oldLineNumber: 4, newLineNumber: 3 },
        { kind: 'add', text: 'E', newLineNumber: 4 },
        { kind: 'delete', text: 'e', oldLineNumber: 5 }
      ],
      'pairs'
    )

    expect(review.rows.map((row) => row.pairIndex)).toEqual([null, 3, null, 1, null, 6, 5])
    expect(review).toMatchObject({ additions: 2, deletions: 3 })
    expect(new Set(review.rows.map((row) => row.id)).size).toBe(review.rows.length)
  })

  it('keys the cache by content, not by array identity', () => {
    const lines: MobileDiffLine[] = [{ kind: 'add', text: 'x', newLineNumber: 1 }]
    const same = buildMobileReviewLines([{ ...lines[0]! }], 'scope')
    expect(buildMobileReviewLines(lines, 'scope').cacheKey).toBe(same.cacheKey)
    expect(
      buildMobileReviewLines([{ kind: 'add', text: 'y', newLineNumber: 1 }], 'scope').cacheKey
    ).not.toBe(same.cacheKey)
    expect(buildMobileReviewLines(lines, 'other-file').cacheKey).not.toBe(same.cacheKey)
  })
})

describe('line-number parity with a real git diff', () => {
  const nexusRows = buildMobileReviewLines(
    buildMobileDiffLines(ORIGINAL_TEXT, MODIFIED_TEXT).lines,
    'parity'
  ).rows

  it('matches every row, number and pair of git diff with full context', () => {
    const file = parseFiles(realGitDiff(ORIGINAL_TEXT, MODIFIED_TEXT, 100_000)).files[0]!
    const gitRows = lineRows(file.rows)

    expect(nexusRows.map(numbersOf)).toEqual(gitRows.map(numbersOf))
    expect(pairsOf(nexusRows)).toEqual(['5->5', '31->31'])
    expect(pairsOf(file.rows)).toEqual(pairsOf(nexusRows))
    expect(file.additions).toBe(nexusRows.filter((row) => row.kind === 'add').length)
    expect(file.deletions).toBe(nexusRows.filter((row) => row.kind === 'delete').length)
  })

  it('finds every row of a default 3-line-context git diff at the same numbers', () => {
    const file = parseFiles(realGitDiff(ORIGINAL_TEXT, MODIFIED_TEXT, 3)).files[0]!
    const gitRows = lineRows(file.rows)
    const nexusKeys = nexusRows.map((row) => JSON.stringify(numbersOf(row)))

    expect(file.rows.filter((row) => row.kind === 'hunk').length).toBeGreaterThan(1)
    let cursor = 0
    for (const row of gitRows) {
      const found = nexusKeys.indexOf(JSON.stringify(numbersOf(row)), cursor)
      expect(found, `git row ${JSON.stringify(numbersOf(row))}`).toBeGreaterThanOrEqual(cursor)
      cursor = found + 1
    }
  })
})
