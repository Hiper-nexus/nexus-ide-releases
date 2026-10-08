import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'

// F-1037: "Tarefas" e "Novo workspace" são do desktop Orca; host Nexus não oferece.
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('../components/MobileHomeQuickActions', () => ({
  MobileHomeQuickActions: 'MobileHomeQuickActions'
}))
vi.mock('./MobileHomeAccountUsageCards', () => ({
  MobileHomeAccountUsageCards: 'MobileHomeAccountUsageCards'
}))
vi.mock('./MobileHomeResumeCard', () => ({ MobileHomeResumeCard: 'MobileHomeResumeCard' }))
vi.mock('./MobileHomeTasksCard', () => ({ MobileHomeTasksCard: 'MobileHomeTasksCard' }))

import { selectHomeOrcaShortcuts } from './home-orca-shortcuts'
import { MobileHomeListFooter } from './MobileHomeListFooter'

function host(id: string, kind?: 'nexus-bridge'): HostProfile {
  return {
    id,
    name: id,
    endpoint: kind ? 'https://mac.tailnet.ts.net' : 'ws://192.168.1.2:6768',
    deviceToken: 'token',
    publicKeyB64: 'key',
    lastConnected: 1,
    ...(kind ? { kind } : {})
  }
}

describe('selectHomeOrcaShortcuts', () => {
  it('hides the Orca shortcuts when every saved host is Nexus', () => {
    const nexus = host('nexus', 'nexus-bridge')
    expect(selectHomeOrcaShortcuts([nexus], [nexus])).toEqual({
      visible: false,
      connectedHosts: []
    })
  })

  it('keeps them for Orca hosts and never targets a Nexus host', () => {
    const nexus = host('nexus', 'nexus-bridge')
    const orca = host('orca')
    expect(selectHomeOrcaShortcuts([nexus, orca], [nexus, orca])).toEqual({
      visible: true,
      connectedHosts: [orca]
    })
    expect(selectHomeOrcaShortcuts([orca], [])).toEqual({ visible: true, connectedHosts: [] })
  })
})

describe('MobileHomeListFooter', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function renderFooter(showOrcaShortcuts: boolean) {
    await act(async () => {
      renderer = create(
        createElement(MobileHomeListFooter, {
          accountsHosts: [],
          connectedHosts: [],
          primaryHost: null,
          primaryTaskProviders: [],
          showOrcaShortcuts,
          resumeCard: null,
          onCreateWorkspace: () => {},
          onOpenAccounts: () => {},
          onOpenResume: () => {},
          onOpenTasks: () => {},
          onPairDesktop: () => {}
        })
      )
    })
    return renderer!
  }

  it('Nexus only: no Tasks card and no New Workspace shortcut', async () => {
    const footer = await renderFooter(false)
    expect(footer.root.findAllByType('MobileHomeTasksCard' as never)).toHaveLength(0)
    expect(footer.root.findAllByType('Text').map((node) => node.props.children)).not.toContain(
      'Tarefas'
    )
    const quickActions = footer.root.findByType('MobileHomeQuickActions' as never)
    expect(quickActions.props.showCreateWorkspace).toBe(false)
  })

  it('Orca host: Tasks card and New Workspace stay', async () => {
    const footer = await renderFooter(true)
    expect(footer.root.findAllByType('MobileHomeTasksCard' as never)).toHaveLength(1)
    expect(footer.root.findByType('MobileHomeQuickActions' as never).props.showCreateWorkspace).toBe(
      true
    )
  })
})
