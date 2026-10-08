import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileLegendList, type MobileLegendListSeparatorProps } from './MobileLegendList'

// Real LegendList native build (vitest.config.ts alias) over the shared RN mock.
vi.mock('react-native', async () => {
  const { createLegendListReactNativeMock } = await import(
    '../test-support/legend-list-react-native-mock'
  )
  return createLegendListReactNativeMock()
})

function Separator({ leadingItem, trailingItem }: MobileLegendListSeparatorProps<unknown>) {
  return createElement('Separator', { label: `${label(leadingItem)}->${label(trailingItem)}` })
}

function label(item: unknown): string {
  return typeof item === 'object' && item !== null ? (item as { id: string }).id : String(item)
}

describe('MobileLegendList separators', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function list(data: readonly unknown[]) {
    return createElement(MobileLegendList, {
      data,
      keyExtractor: (item: unknown, index: number) => `${label(item)}#${index}`,
      renderItem: ({ item }: { item: unknown }) => createElement('Row', { label: label(item) }),
      ItemSeparatorComponent: Separator
    })
  }

  function separatorLabels(): string[] {
    return (renderer?.root.findAll((node) => node.type === 'Separator') ?? []).map(
      (node) => node.props.label as string
    )
  }

  it('pairs every row with its own next neighbour even when primitives repeat', async () => {
    await act(async () => {
      renderer = create(list(['a', 'b', 'a', 'c']))
    })
    // An item-keyed lookup collapses both 'a' rows onto one neighbour.
    expect(separatorLabels().sort()).toEqual(['a->b', 'a->c', 'b->a'])
  })

  it('refreshes a row separator when only its neighbour changes', async () => {
    const first = { id: 'first' }
    const last = { id: 'last' }
    await act(async () => {
      renderer = create(list([first, last]))
    })
    expect(separatorLabels()).toEqual(['first->last'])

    await act(async () => {
      renderer?.update(list([first, { id: 'inserted' }, last]))
    })
    expect(separatorLabels().sort()).toEqual(['first->inserted', 'inserted->last'])
  })
})
