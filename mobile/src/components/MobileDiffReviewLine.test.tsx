import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileDiffLine } from '../session/mobile-diff-lines'
import type { MobileReviewToken } from '../source-control/mobile-review-model'
import { colors } from '../theme/mobile-theme'
import { MobileDiffReviewLine } from './MobileDiffReviewLine'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ MessageSquare: 'MessageSquare' }))

function flatStyle(node: ReactTestInstance): Record<string, unknown> {
  const style = node.props.style as unknown
  return Object.assign({}, ...(Array.isArray(style) ? style : [style]))
}

function leafTexts(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root
    .findAllByType('Text' as never)
    .filter((node) => node.children.every((child) => typeof child === 'string'))
}

describe('MobileDiffReviewLine', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(line: MobileDiffLine, tokens: ReadonlyArray<MobileReviewToken> | null) {
    act(() => {
      renderer = create(
        createElement(MobileDiffReviewLine, {
          line,
          tokens,
          comments: [],
          staleCommentIds: new Set(),
          active: false,
          onAddNote: () => {},
          onEditNote: () => {}
        })
      )
    })
    return renderer!
  }

  it('paints syntax colors and a word-diff background only on the changed span', () => {
    const view = render({ kind: 'add', text: 'const after = 1;', newLineNumber: 3 }, [
      { content: 'const', color: colors.syntaxKeyword, fontStyle: null, diffHighlight: false },
      { content: ' ', color: null, fontStyle: null, diffHighlight: false },
      { content: 'after', color: colors.syntaxVariable, fontStyle: null, diffHighlight: true },
      { content: ' = 1;', color: null, fontStyle: null, diffHighlight: false }
    ])
    const byContent = new Map(leafTexts(view).map((node) => [node.children.join(''), node]))

    expect(flatStyle(byContent.get('after')!)).toMatchObject({
      color: colors.syntaxVariable,
      backgroundColor: colors.diffAddedWordBg
    })
    expect(flatStyle(byContent.get('const')!)).toEqual({ color: colors.syntaxKeyword })
    expect(flatStyle(byContent.get(' = 1;')!).backgroundColor).toBeUndefined()
  })

  it('uses the deleted word tint on deleted rows', () => {
    const view = render({ kind: 'delete', text: 'before', oldLineNumber: 3 }, [
      { content: 'before', color: null, fontStyle: null, diffHighlight: true }
    ])
    const node = leafTexts(view).find((candidate) => candidate.children.join('') === 'before')!
    expect(flatStyle(node).backgroundColor).toBe(colors.diffDeletedWordBg)
  })

  it('read-only rows (Nexus host, F-1014) are not note buttons', () => {
    const onAddNote = vi.fn()
    act(() => {
      renderer = create(
        createElement(MobileDiffReviewLine, {
          line: { kind: 'add', text: 'x', newLineNumber: 7 },
          tokens: null,
          comments: [],
          staleCommentIds: new Set(),
          active: false,
          onAddNote,
          onEditNote: () => {},
          readOnly: true
        })
      )
    })
    const code = renderer!.root.findByType('Pressable' as never)
    expect(code.props.disabled).toBe(true)
    expect(code.props.accessibilityRole).toBe('text')
    expect(code.props.accessibilityLabel).toBe('Added line 7')
    code.props.onPress()
    expect(onAddNote).not.toHaveBeenCalled()
  })

  it('shows the raw line text until its block is highlighted', () => {
    const view = render(
      { kind: 'context', text: 'plain row', oldLineNumber: 1, newLineNumber: 1 },
      null
    )
    expect(leafTexts(view).some((node) => node.children.join('') === 'plain row')).toBe(true)
  })
})
