// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: wrapper único sobre o LegendList usado em HomeScreen/ThreadFeed/ArchivedThreadsScreen — listRef tipado, refreshNonce→refreshing e separador por índice com trailingItem como o FlatList.
import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'
import {
  LegendList,
  type LegendListProps,
  type LegendListRef,
  type LegendListRenderItemProps
} from '@legendapp/list/react-native'

export type {
  LegendListRef as MobileLegendListRef,
  LegendListRenderItemProps as MobileLegendListRenderItemProps,
  OnViewableItemsChanged as MobileOnViewableItemsChanged
} from '@legendapp/list/react-native'

// FlatList handed separators both neighbours; LegendList only passes the leading one.
export type MobileLegendListSeparatorProps<ItemT> = {
  leadingItem: ItemT
  trailingItem: ItemT | undefined
}

export type MobileLegendListProps<ItemT> = Omit<
  LegendListProps<ItemT>,
  'data' | 'renderItem' | 'children' | 'ItemSeparatorComponent' | 'ref'
> & {
  data: readonly ItemT[]
  renderItem: (info: LegendListRenderItemProps<ItemT>) => ReactNode
  listRef?: Ref<LegendListRef>
  /**
   * Bumped by an external refresh (a header button, pull-to-refresh that bumps a reload
   * nonce). Shows the refresh indicator from the bump until the list receives new data.
   */
  refreshNonce?: number
  ItemSeparatorComponent?: ComponentType<MobileLegendListSeparatorProps<ItemT>>
}

// A refresh whose data never changes (offline, identical reply) must not spin forever.
export const REFRESH_NONCE_INDICATOR_MAX_MS = 10_000

/** `refreshing` for a nonce-driven reload: true from the bump until `data` changes identity. */
export function useRefreshNonceRefreshing(refreshNonce: number | undefined, data: unknown): boolean {
  const [seenNonce, setSeenNonce] = useState(refreshNonce)
  const [bump, setBump] = useState<{ readonly data: unknown } | null>(null)
  if (refreshNonce !== seenNonce) {
    // Derived state from the previous render (React's "storing info from previous renders").
    setSeenNonce(refreshNonce)
    setBump({ data })
  }
  useEffect(() => {
    if (!bump) {
      return
    }
    const timer = setTimeout(() => setBump(null), REFRESH_NONCE_INDICATOR_MAX_MS)
    return () => clearTimeout(timer)
  }, [bump])
  return bump !== null && bump.data === data
}

type RenderItem<ItemT> = (info: LegendListRenderItemProps<ItemT>) => ReactNode

/**
 * Separators are rendered inside each row from the row's index, not looked up by item:
 * equal primitives (or a repeated object) would collide in an item-keyed lookup. The
 * row only re-renders on extraData changes, so the list's data rides along in the
 * extraData handed to LegendList — a neighbour change then refreshes the hairlines —
 * while renderItem still receives the caller's own extraData.
 */
function useSeparatedRows<ItemT>(
  data: readonly ItemT[],
  renderItem: RenderItem<ItemT>,
  extraData: unknown,
  Separator: ComponentType<MobileLegendListSeparatorProps<ItemT>> | undefined
): { renderItem: RenderItem<ItemT>; extraData: unknown } {
  const listExtraData = useMemo(
    () => (Separator ? [extraData, data] : extraData),
    [Separator, data, extraData]
  )
  const separatedRenderItem = useMemo<RenderItem<ItemT>>(() => {
    if (!Separator) {
      return renderItem
    }
    return function renderSeparatedItem(info) {
      const trailingIndex = info.index + 1
      return (
        <>
          {renderItem({ ...info, extraData })}
          {trailingIndex < info.data.length ? (
            <Separator leadingItem={info.item} trailingItem={info.data[trailingIndex]} />
          ) : null}
        </>
      )
    }
  }, [Separator, extraData, renderItem])
  return { renderItem: separatedRenderItem, extraData: listExtraData }
}

/**
 * The one virtualized list for long mobile lists. Rows are recycled into a bounded
 * container pool, so a 2000-commit history mounts only what fits the viewport plus
 * `drawDistance`. Pass state the rows read through `extraData` (memoized): LegendList
 * re-renders visible rows when it changes instead of remounting the list.
 */
export function MobileLegendList<ItemT>({
  data,
  renderItem,
  extraData,
  listRef,
  refreshNonce,
  refreshing,
  ItemSeparatorComponent,
  // Rows here hold hooks keyed to their item (host cards, picker rows), so a reused
  // container must remount rather than inherit another item's state.
  recycleItems = false,
  ...props
}: MobileLegendListProps<ItemT>): ReactElement {
  const nonceRefreshing = useRefreshNonceRefreshing(refreshNonce, data)
  const rows = useSeparatedRows(data, renderItem, extraData, ItemSeparatorComponent)
  return (
    <LegendList<ItemT>
      {...props}
      ref={listRef}
      data={data}
      renderItem={rows.renderItem}
      extraData={rows.extraData}
      recycleItems={recycleItems}
      refreshing={Boolean(refreshing) || nonceRefreshing}
    />
  )
}
