// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: wrapper único sobre o LegendList usado em HomeScreen/ThreadFeed/ArchivedThreadsScreen — listRef tipado, refreshNonce→refreshing e separador com trailingItem como o FlatList.
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

function useTrailingItemSeparator<ItemT>(
  data: readonly ItemT[],
  Separator: ComponentType<MobileLegendListSeparatorProps<ItemT>> | undefined
): ComponentType<{ leadingItem: ItemT }> | undefined {
  const trailingByLeading = useMemo(() => {
    const next = new Map<ItemT, ItemT>()
    for (let index = 0; index < data.length - 1; index += 1) {
      next.set(data[index], data[index + 1])
    }
    return next
  }, [data])
  return useMemo(() => {
    if (!Separator) {
      return undefined
    }
    return function MobileLegendListSeparator({ leadingItem }: { leadingItem: ItemT }) {
      return <Separator leadingItem={leadingItem} trailingItem={trailingByLeading.get(leadingItem)} />
    }
  }, [Separator, trailingByLeading])
}

/**
 * The one virtualized list for long mobile lists. Rows are recycled into a bounded
 * container pool, so a 2000-commit history mounts only what fits the viewport plus
 * `drawDistance`. Pass state the rows read through `extraData` (memoized): LegendList
 * re-renders visible rows when it changes instead of remounting the list.
 */
export function MobileLegendList<ItemT>({
  data,
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
  const Separator = useTrailingItemSeparator(data, ItemSeparatorComponent)
  return (
    <LegendList<ItemT>
      {...props}
      ref={listRef}
      data={data}
      recycleItems={recycleItems}
      ItemSeparatorComponent={Separator}
      refreshing={Boolean(refreshing) || nonceRefreshing}
    />
  )
}
