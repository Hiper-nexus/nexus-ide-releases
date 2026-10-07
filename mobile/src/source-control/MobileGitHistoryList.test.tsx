import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { MobileGitHistoryList } from './MobileGitHistoryList'

const listMounts = vi.hoisted(() => ({ scrollView: 0 }))

// The real LegendList native build renders against this mock (see the vitest.config.ts
// alias), so the row counts below are the virtualizer's, not a test double's.
vi.mock('react-native', async () => {
  const { createLegendListReactNativeMock } = await import(
    '../test-support/legend-list-react-native-mock'
  )
  return createLegendListReactNativeMock({
    windowHeight: 800,
    onScrollViewMount: () => {
      listMounts.scrollView += 1
    }
  })
})
vi.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight' }))
vi.mock('../transport/client-context', () => ({ useForceReconnect: () => vi.fn() }))

// Captured at module scope: the list renders rows against Date.now() a few ms later,
// so a 3h offset stays inside the '3h' relative-time bucket.
const RENDER_NOW = Date.now()

function historyResponse(subject: string) {
  return {
    ok: true,
    result: {
      items: [
        {
          id: 'commit-1',
          displayId: 'c0mm1t1',
          subject,
          author: 'Ada',
          parentIds: [],
          timestamp: RENDER_NOW - 3 * 3_600_000
        }
      ]
    }
  }
}

function manyCommitsResponse(count: number) {
  return {
    ok: true,
    result: {
      items: Array.from({ length: count }, (_, index) => ({
        id: `commit-${index}`,
        displayId: `c${index}`,
        subject: `commit subject ${index}`,
        author: 'Ada',
        parentIds: [],
        timestamp: RENDER_NOW - index * 60_000
      }))
    }
  }
}

const compareResponse = {
  ok: true,
  result: { entries: [{ path: 'src/app.ts', added: 3, removed: 1 }] }
}

describe('MobileGitHistoryList', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    listMounts.scrollView = 0
  })

  function listElement(client: RpcClient | null, connState: ConnectionState, refreshNonce = 0) {
    return createElement(MobileGitHistoryList, {
      client,
      connState,
      worktreeId: 'wt-1',
      hostId: 'host-1',
      bottomInset: 0,
      refreshNonce
    })
  }

  async function render(client: RpcClient, connState: ConnectionState): Promise<void> {
    await act(async () => {
      renderer = create(listElement(client, connState))
      await Promise.resolve()
    })
  }

  async function update(client: RpcClient | null, connState: ConnectionState): Promise<void> {
    await act(async () => {
      renderer?.update(listElement(client, connState))
      await Promise.resolve()
    })
  }

  // Rendered text only: LegendList hosts carry extraData/context props (some circular),
  // and extraData still holds a collapsed commit's cached files.
  function tree(): string {
    const texts: string[] = []
    const visit = (node: unknown): void => {
      if (typeof node === 'string') {
        texts.push(node)
      } else if (Array.isArray(node)) {
        node.forEach(visit)
      } else if (node && typeof node === 'object' && 'children' in node) {
        visit((node as { children: unknown }).children)
      }
    }
    visit(renderer?.toJSON())
    return texts.join('\n')
  }

  function renderedSubjects(): string[] {
    return (
      renderer?.root
        .findAll(
          (node) =>
            node.type === 'Text' &&
            typeof node.props.children === 'string' &&
            node.props.children.startsWith('commit subject ')
        )
        .map((node) => node.props.children as string) ?? []
    )
  }

  function commitHeaders() {
    return (
      renderer?.root.findAll(
        (node) => node.type === 'Pressable' && node.props.onPress !== undefined
      ) ?? []
    )
  }

  it('mounts only a viewport-sized window of rows for a 2000-commit history', async () => {
    const sendRequest = vi.fn().mockResolvedValue(manyCommitsResponse(2000))
    await render({ sendRequest } as unknown as RpcClient, 'connected')

    const subjects = renderedSubjects()
    expect(subjects).toContain('commit subject 0')
    // A FlatList-style regression mounts far more; LegendList pools ~viewport / row height.
    expect(subjects.length).toBeGreaterThan(0)
    expect(subjects.length).toBeLessThan(60)
    expect(subjects).not.toContain('commit subject 1999')
  })

  it('shows the refresh indicator from a header refresh bump until the new history lands', async () => {
    let releaseRefresh: (() => void) | null = null
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(manyCommitsResponse(3))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRefresh = () => resolve(manyCommitsResponse(4))
          })
      )
    const client = { sendRequest } as unknown as RpcClient
    // LegendList hands its RefreshControl to the ScrollView as the refreshControl prop.
    const refreshing = () =>
      renderer?.root.findByType('ScrollView').props.refreshControl.props.refreshing
    await render(client, 'connected')
    expect(refreshing()).toBe(false)

    await act(async () => {
      renderer?.update(listElement(client, 'connected', 1))
      await Promise.resolve()
    })
    expect(refreshing()).toBe(true)

    await act(async () => {
      releaseRefresh?.()
      await Promise.resolve()
    })
    expect(refreshing()).toBe(false)
    expect(renderedSubjects()).toContain('commit subject 3')
    expect(listMounts.scrollView).toBe(1)
  })

  it('expands a commit and shows its files without remounting the list', async () => {
    const sendRequest = vi
      .fn()
      .mockImplementation((method: string) =>
        Promise.resolve(method === 'git.history' ? manyCommitsResponse(3) : compareResponse)
      )
    await render({ sendRequest } as unknown as RpcClient, 'connected')
    expect(listMounts.scrollView).toBe(1)

    await act(async () => {
      commitHeaders()[0]?.props.onPress()
      await Promise.resolve()
    })
    // expanded + filesById reach the visible row through extraData…
    expect(tree()).toContain('src/app.ts')
    // …while the list itself stays the same mounted instance.
    expect(listMounts.scrollView).toBe(1)

    await act(async () => {
      commitHeaders()[0]?.props.onPress()
    })
    expect(tree()).not.toContain('src/app.ts')
    expect(listMounts.scrollView).toBe(1)
  })

  it('keeps loaded commits visible across a disconnect and its reconnect refetch', async () => {
    let releaseRefetch: (() => void) | null = null
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(historyResponse('first load'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRefetch = () => resolve(historyResponse('after reconnect'))
          })
      )
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'connected')
    expect(tree()).toContain('first load')
    // Rows format the RPC timestamp (epoch ms); a regression to seconds-scaling
    // renders every commit as 'just now' instead.
    expect(tree()).toContain('3h')

    await update(client, 'reconnecting')
    expect(tree()).toContain('first load')

    // The refetch is in flight: old rows must stay up instead of flashing empty.
    await update(client, 'connected')
    expect(tree()).toContain('first load')

    await act(async () => {
      releaseRefetch?.()
      await Promise.resolve()
    })
    expect(tree()).toContain('after reconnect')
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('wipes commits when the worktree identity changes', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(historyResponse('worktree one'))
      .mockReturnValueOnce(new Promise(() => {}))
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'connected')
    expect(tree()).toContain('worktree one')

    await act(async () => {
      renderer?.update(
        createElement(MobileGitHistoryList, {
          client,
          connState: 'connected',
          worktreeId: 'wt-2',
          hostId: 'host-1',
          bottomInset: 0
        })
      )
    })
    expect(tree()).not.toContain('worktree one')
  })

  it('refetches the expanded commit files after a reconnect instead of caching the outage answer', async () => {
    const sendRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'git.history') {
        return Promise.resolve(historyResponse('expandable'))
      }
      return Promise.resolve(compareResponse)
    })
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'connected')
    await update(client, 'disconnected')

    const row = renderer?.root.findAll(
      (node) => node.type === 'Pressable' && node.props.onPress !== undefined
    )[0]
    await act(async () => {
      row?.props.onPress()
    })
    // Offline expand cannot request anything, so nothing is cached as "no file changes".
    expect(tree()).toContain('Waiting for desktop...')
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await update(client, 'connected')
    expect(sendRequest).toHaveBeenCalledWith('git.commitCompare', {
      worktree: 'id:wt-1',
      commitId: 'commit-1'
    })
    expect(tree()).toContain('src/app.ts')
  })
})
