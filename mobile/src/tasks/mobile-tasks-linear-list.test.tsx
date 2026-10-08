import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { linearRowExtraData, renderMobileTasksLinearList } from './mobile-tasks-linear-list'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'

const rowRenders = vi.hoisted(() => ({ count: 0 }))

// Real LegendList native build (vitest.config.ts alias) over the shared RN mock.
vi.mock('react-native', async () => {
  const { createLegendListReactNativeMock } = await import(
    '../test-support/legend-list-react-native-mock'
  )
  return createLegendListReactNativeMock()
})
vi.mock('./mobile-tasks-dependencies', async () => {
  const { MobileLegendList } = await import('../components/MobileLegendList')
  return {
    ActivityIndicator: 'ActivityIndicator',
    ChevronDown: 'ChevronDown',
    MobileLegendList,
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
    colors: new Proxy({}, { get: () => '#000' }),
    spacing: new Proxy({}, { get: () => 8 }),
    triggerMediumImpact: () => {},
    // One logo per issue row: counts how often the visible rows render.
    TaskProviderLogo: () => {
      rowRenders.count += 1
      return null
    }
  }
})
vi.mock('./mobile-tasks-legacy-styles', () => ({
  styles: new Proxy({}, { get: () => ({}) }),
  getPrSignalToneStyle: () => ({})
}))
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  createLinearTask: (issue: unknown) => ({ provider: 'linear', issue }),
  formatUpdatedAt: () => 'now',
  linearIssueSecondaryParts: () => []
}))

function issue(index: number) {
  return {
    id: `issue-${index}`,
    title: `Issue ${index}`,
    updatedAt: '2026-10-01T00:00:00Z',
    state: { name: 'Todo', color: '#888' }
  }
}

const issues = [issue(1), issue(2), issue(3)]
const entries = issues.map((item) => ({ type: 'issue' as const, issue: item }))
const displayProperties = new Set(['state', 'updated'])

function model(overrides: Record<string, unknown> = {}): ConnectionPresentationModel {
  return {
    effectiveLinearDisplayProperties: displayProperties,
    emptyLabel: 'No issues',
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    linearBoardSections: [],
    linearIssuesForView: issues,
    linearListEntries: entries,
    linearViewMode: 'list',
    loading: false,
    mutatingStatus: false,
    refreshTasks: () => {},
    refreshing: false,
    setActionItem: () => {},
    setLinearStatusPickerItem: () => {},
    ...overrides
  } as unknown as ConnectionPresentationModel
}

function LinearList({ value }: { value: ConnectionPresentationModel }) {
  return renderMobileTasksLinearList(value)
}

describe('Linear issue list rows', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    rowRenders.count = 0
  })

  it('keeps one extraData object per display set and mutating state', () => {
    expect(linearRowExtraData(displayProperties, false)).toBe(
      linearRowExtraData(displayProperties, false)
    )
    expect(linearRowExtraData(displayProperties, true)).not.toBe(
      linearRowExtraData(displayProperties, false)
    )
  })

  it('does not re-render visible rows when the screen re-renders with nothing new', async () => {
    await act(async () => {
      renderer = create(createElement(LinearList, { value: model() }))
    })
    const mounted = rowRenders.count
    expect(mounted).toBe(issues.length)

    // A fresh model object (new insets literal too) is what an unrelated screen render hands in.
    await act(async () => {
      renderer?.update(createElement(LinearList, { value: model() }))
    })
    expect(rowRenders.count).toBe(mounted)

    // …but a value the rows read still reaches them.
    await act(async () => {
      renderer?.update(createElement(LinearList, { value: model({ mutatingStatus: true }) }))
    })
    expect(rowRenders.count).toBeGreaterThan(mounted)
  })
})
