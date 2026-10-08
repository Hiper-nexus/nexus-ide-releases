import { describe, expect, it } from 'vitest'
import {
  NEXUS_DIFF_MAX_LINES,
  NexusWorkspaceShapeError,
  nexusDiffLines,
  nexusWorkspaceErrorText,
  parseNexusUnifiedPatch,
  readNexusFileList,
  readNexusGitDiff,
  readNexusGitStatus
} from './nexus-bridge-git-files'

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@ export function a() {',
  ' um',
  '-dois',
  '+DOIS',
  ' tres',
  '@@ -10,2 +10,3 @@',
  ' dez',
  '+-- não é cabeçalho, é uma linha nova que começa com "--"',
  ' onze',
  '\\ No newline at end of file',
  ''
].join('\n')

describe('parseNexusUnifiedPatch (F-1014)', () => {
  it('turns git diff hunks into diff lines with old/new numbers and uncommentable hunk headers', () => {
    const { lines, truncated } = parseNexusUnifiedPatch(PATCH)
    expect(truncated).toBe(false)
    expect(lines).toEqual([
      { kind: 'context', text: '@@ -1,3 +1,3 @@ export function a() {' },
      { kind: 'context', text: 'um', oldLineNumber: 1, newLineNumber: 1 },
      { kind: 'delete', text: 'dois', oldLineNumber: 2 },
      { kind: 'add', text: 'DOIS', newLineNumber: 2 },
      { kind: 'context', text: 'tres', oldLineNumber: 3, newLineNumber: 3 },
      { kind: 'context', text: '@@ -10,2 +10,3 @@' },
      { kind: 'context', text: 'dez', oldLineNumber: 10, newLineNumber: 10 },
      { kind: 'add', text: '-- não é cabeçalho, é uma linha nova que começa com "--"', newLineNumber: 11 },
      { kind: 'context', text: 'onze', oldLineNumber: 11, newLineNumber: 12 }
    ])
  })

  it('stops at the line cap with an explicit flag and ignores the desktop truncation notice', () => {
    const body = Array.from({ length: 10 }, (_, index) => `+linha ${index}`).join('\n')
    expect(parseNexusUnifiedPatch(`@@ -0,0 +1,10 @@\n${body}`, 4)).toEqual({
      lines: [
        { kind: 'context', text: '@@ -0,0 +1,10 @@' },
        { kind: 'add', text: 'linha 0', newLineNumber: 1 },
        { kind: 'add', text: 'linha 1', newLineNumber: 2 },
        { kind: 'add', text: 'linha 2', newLineNumber: 3 }
      ],
      truncated: true
    })
    const cut = parseNexusUnifiedPatch('@@ -1 +1 @@\n-a\n+b\n\n… [diff truncado para proteção da UI]')
    expect(cut.lines.map((line) => line.text)).toEqual(['@@ -1 +1 @@', 'a', 'b'])
  })
})

describe('nexusDiffLines (F-1014)', () => {
  it('shows a new file as all additions, capped, and keeps the desktop truncation flag', () => {
    expect(
      nexusDiffLines({
        kind: 'untracked',
        path: 'n.txt',
        content: 'a\nb\n',
        truncated: true,
        binary: false,
        byteLength: 999_999
      })
    ).toEqual({
      lines: [
        { kind: 'add', text: 'a', newLineNumber: 1 },
        { kind: 'add', text: 'b', newLineNumber: 2 }
      ],
      truncated: true
    })
    const long = Array.from({ length: NEXUS_DIFF_MAX_LINES + 5 }, () => 'x').join('\n')
    const capped = nexusDiffLines({
      kind: 'untracked',
      path: 'n.txt',
      content: long,
      truncated: false,
      binary: false,
      byteLength: long.length
    })
    expect(capped.lines).toHaveLength(NEXUS_DIFF_MAX_LINES)
    expect(capped.truncated).toBe(true)
    expect(nexusDiffLines({ kind: 'binary', path: 'i.png', staged: false })).toEqual({
      lines: [],
      truncated: false
    })
  })
})

describe('bridge reply readers (F-1014)', () => {
  it('rejects malformed replies instead of rendering half a screen', () => {
    expect(() => readNexusGitStatus(null)).toThrow(NexusWorkspaceShapeError)
    expect(() => readNexusGitDiff({ path: 'a', kind: 'patch' })).toThrow(NexusWorkspaceShapeError)
    expect(() => readNexusGitDiff({ kind: 'binary' })).toThrow(NexusWorkspaceShapeError)
    expect(readNexusFileList({ path: '', entries: [{ name: 'a', path: 'a', kind: 'socket' }] }).entries).toEqual(
      []
    )
  })

  it('translates desktop refusals into Portuguese screen text', () => {
    expect(nexusWorkspaceErrorText(new Error('not authorized: secret-file'))).toMatch(/Arquivo sensível/)
    expect(nexusWorkspaceErrorText(new Error('not authorized: path-escapes-checkout'))).toMatch(
      /Link simbólico para fora do checkout/
    )
    expect(nexusWorkspaceErrorText(new Error('not authorized: git-internals'))).toMatch(/\.git\//)
    expect(nexusWorkspaceErrorText(new Error('not authorized: scope'))).toBe(
      'Este aparelho não tem acesso a este pane.'
    )
    expect(nexusWorkspaceErrorText(new Error('algo novo'))).toBe('algo novo')
  })
})
