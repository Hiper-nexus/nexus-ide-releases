import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// F-1037: estados do desktop em pt-BR e nada do pane na tela depois da revogação.
vi.mock('react-native', async () => {
  const { createLegendListReactNativeMock } = await import(
    '../test-support/legend-list-react-native-mock'
  )
  return { ...createLegendListReactNativeMock(), ScrollView: 'ScrollView', Alert: { alert: () => {} } }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, canGoBack: () => false })
}))
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight'
}))
const host = vi.hoisted(() => ({ client: null as unknown, state: 'connected' as string }))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => ({ client: host.client, state: host.state })
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: async () => [] }))
vi.mock('../transport/nexus-bridge-rpc-adapter', () => ({
  nexusHostApiOf: (client: { nexus?: unknown } | null) => client?.nexus ?? null
}))
vi.mock('../session/mobile-structured-agent-prompts', () => ({
  decodeApprovalResponseToken: () => null
}))
vi.mock('../session/mobile-native-chat-permission', () => ({ parseApprovalFromStatus: () => null }))
vi.mock('../session/mobile-native-chat-permission-send', () => ({
  sendMobileHookApprovalResponse: async () => 'accepted'
}))
vi.mock('../session/MobileNativeChatPermission', () => ({
  MobileNativeChatPermission: 'MobileNativeChatPermission'
}))
vi.mock('./NexusCommandInput', () => ({ NexusCommandInput: 'NexusCommandInput' }))
vi.mock('./nexus-host-notifications', () => ({
  useNexusActivityNotifications: () => () => {},
  useNexusApprovalNotifications: () => {},
  useNexusHostNotificationFocus: () => null
}))
vi.mock('./use-nexus-host-outbox', () => ({ useNexusHostOutboxFlush: () => 0 }))
vi.mock('./nexus-pane-activity', () => ({
  nexusActivityFromPaneState: () => null,
  useNexusPaneActivity: () => new Map()
}))
vi.mock('./NexusPaneActivityCard', () => ({
  NexusPaneActivityBadge: 'NexusPaneActivityBadge',
  NexusPaneActivityCard: 'NexusPaneActivityCard'
}))
vi.mock('./NexusPaneWorkspace', () => ({
  NexusPaneWorkspace: 'NexusPaneWorkspace',
  NexusWorkspaceOpeners: 'NexusWorkspaceOpeners'
}))

import { NexusHostScreen } from './NexusHostScreen'
import { nexusHostBody, nexusMissionStatusLabel, nexusPaneStateLabel } from './nexus-host-presentation'

const SNAPSHOT = {
  missions: [{ id: 'm1', title: 'Portar o transporte', status: 'running' }],
  panes: [{ paneId: 'p1', paneNumber: 4, title: 'Claude', state: 'busy' }],
  approvals: []
}

function fakeClient() {
  return {
    nexus: {
      snapshot: async () => SNAPSHOT,
      onApprovalsChanged: () => () => {},
      subscribePane: () => () => {},
      closePane: async () => {},
      workspace: {}
    },
    notifyForeground: () => {}
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => [node.props.children].flat().join(''))
}

function byType(renderer: ReactTestRenderer, type: string): ReactTestInstance[] {
  return renderer.root.findAll((node) => (node.type as unknown) === type)
}

function byLabel(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find(
    (node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label
  )
}

describe('rótulos pt-BR do host Nexus', () => {
  it('traduz estados de missão e de pane e deixa passar o desconhecido', () => {
    expect(['running', 'done', 'blocked', 'failed', 'pending'].map(nexusMissionStatusLabel)).toEqual(
      ['em andamento', 'concluída', 'bloqueada', 'falhou', 'pendente']
    )
    expect(['busy', 'idle', 'spawning', 'exited', 'parked'].map(nexusPaneStateLabel)).toEqual([
      'ocupado',
      'ocioso',
      'iniciando',
      'encerrado',
      'estacionado'
    ])
    expect(nexusMissionStatusLabel('archived')).toBe('archived')
    expect(nexusPaneStateLabel('hibernated')).toBe('hibernated')
    expect(nexusPaneStateLabel('constructor')).toBe('constructor')
  })

  it('com a credencial revogada nunca escolhe pane, workspace nem lista', () => {
    expect(nexusHostBody('auth-failed', true, true)).toBe('revoked-pane')
    expect(nexusHostBody('auth-failed', false, false)).toBe('revoked')
    expect(nexusHostBody('connected', true, true)).toBe('workspace')
    expect(nexusHostBody('reconnecting', true, false)).toBe('pane')
    expect(nexusHostBody('connected', false, false)).toBe('list')
  })
})

describe('NexusHostScreen', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    host.state = 'connected'
  })

  it('mostra os estados do desktop em pt-BR e a nota de limitações recolhida', async () => {
    host.client = fakeClient()
    await act(async () => {
      renderer = create(createElement(NexusHostScreen, { hostId: 'h1' }))
    })
    await flush()
    expect(texts(renderer!)).toContain('em andamento')
    expect(byType(renderer!, 'NexusPaneActivityBadge')[0]?.props.fallback).toBe('ocupado')
    expect(texts(renderer!).some((text) => text.startsWith('Não disponível em host Nexus'))).toBe(false)
    await act(async () => byLabel(renderer!, 'Ver o que não funciona aqui').props.onPress())
    expect(texts(renderer!).some((text) => text.startsWith('Não disponível em host Nexus'))).toBe(true)
  })

  it('na revogação some o arquivo/diff aberto e as abas ficam desabilitadas', async () => {
    host.client = fakeClient()
    await act(async () => {
      renderer = create(createElement(NexusHostScreen, { hostId: 'h1' }))
    })
    await flush()
    await act(async () => byLabel(renderer!, 'Abrir pane Claude').props.onPress())
    expect(byType(renderer!, 'NexusCommandInput')).toHaveLength(1)
    // A nota longa não se repete no pane.
    expect(texts(renderer!).some((text) => text.includes('Não disponível em host Nexus'))).toBe(false)
    await act(async () => byType(renderer!, 'NexusWorkspaceOpeners')[0]!.props.onOpen('files'))
    expect(byType(renderer!, 'NexusPaneWorkspace')).toHaveLength(1)

    host.state = 'auth-failed'
    await act(async () => {
      renderer!.update(createElement(NexusHostScreen, { hostId: 'h1' }))
    })
    await flush()
    expect(byType(renderer!, 'NexusPaneWorkspace')).toHaveLength(0)
    expect(byType(renderer!, 'NexusCommandInput')).toHaveLength(0)
    const openers = byType(renderer!, 'NexusWorkspaceOpeners')
    expect(openers).toHaveLength(1)
    expect(openers[0]!.props.disabled).toBe(true)
    expect(texts(renderer!)).toContain('Parear de novo')

    // De volta à lista: missões e panes antigos também foram descartados.
    await act(async () => byLabel(renderer!, 'Voltar para a lista').props.onPress())
    expect(byType(renderer!, 'NexusWorkspaceOpeners')).toHaveLength(0)
    expect(texts(renderer!)).not.toContain('Portar o transporte')
    expect(texts(renderer!)).toContain('Parear de novo')
  })
})
