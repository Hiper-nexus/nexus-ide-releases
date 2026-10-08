import { describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('expo-notifications', () => ({
  scheduleNotificationAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios', Version: '18' }
}))

import { getNotificationNavigationTarget } from '../notifications/notification-routing'
import type { NexusApproval, NexusOpsSnapshot } from '../transport/nexus-bridge-rpc-adapter'
import {
  createNexusApprovalNotifier,
  nexusApprovalNotificationData,
  noteNexusHostNotificationTap,
  readNexusNotificationFocus,
  resolveNexusNotificationFocus,
  takeNexusHostNotificationFocus,
  type NexusApprovalNotificationRequest
} from './nexus-host-notifications'
import type { NexusPaneActivityTransition } from './nexus-pane-activity'

function approval(requestId: string, paneId = 'p1'): NexusApproval {
  return {
    requestId,
    revision: 1,
    paneId,
    provider: 'claude',
    tool: 'Bash',
    summary: `rodar ${requestId}`,
    options: [{ optionId: 'accept', label: 'Aceitar', kind: 'accept' }],
    responseCapability: 'live',
    expiresAt: 0
  } as unknown as NexusApproval
}

const PANES = [{ paneId: 'p1', title: 'Claude', state: 'busy', kind: 'cli-agent' }]

function memoryKv() {
  const kv = new Map<string, string>()
  return {
    kv,
    getItem: async (key: string) => kv.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      kv.set(key, value)
    }
  }
}

function notifierWith(kv = memoryKv(), canNotify = true) {
  const scheduled: NexusApprovalNotificationRequest[] = []
  const dismissed: string[] = []
  const notifier = createNexusApprovalNotifier({
    storage: kv,
    canNotify: async () => canNotify,
    sound: async () => false,
    schedule: async (request) => {
      scheduled.push(request)
    },
    dismiss: async (identifier) => {
      dismissed.push(identifier)
    }
  })
  const away = (approvals: NexusApproval[], hostId = 'host-a') =>
    notifier.onApprovals({ hostId, hostName: 'Mac', approvals, panes: PANES, attention: 'away' })
  return { notifier, scheduled, dismissed, away, kv }
}

describe('notificação de aprovação do host Nexus', () => {
  it('o mesmo pedido notifica uma vez só, também depois de reconectar', async () => {
    const t = notifierWith()
    expect(await t.away([approval('r1')])).toEqual(['r1'])
    // approvals.changed repetido e o snapshot relido depois da reconexão.
    expect(await t.away([approval('r1')])).toEqual([])
    expect(await t.away([approval('r1'), approval('r2')])).toEqual(['r2'])
    expect(t.scheduled.map((request) => request.identifier)).toEqual([
      'nexus-approval:host-a:r1',
      'nexus-approval:host-a:r2'
    ])
    expect(t.scheduled[0]).toMatchObject({
      title: 'Aprovação pendente · Mac',
      body: 'Claude: Bash — rodar r1',
      sound: false,
      data: { hostId: 'host-a', nexusHost: { paneId: 'p1', requestId: 'r1' } }
    })
  })

  it('dois pushes simultâneos não notificam o mesmo pedido duas vezes', async () => {
    const t = notifierWith()
    const [first, second] = await Promise.all([t.away([approval('r1')]), t.away([approval('r1')])])
    expect([...first, ...second]).toEqual(['r1'])
    expect(t.scheduled).toHaveLength(1)
  })

  it('o livro-razão sobrevive a reiniciar o app (outro notificador, mesmo disco)', async () => {
    const kv = memoryKv()
    await notifierWith(kv).away([approval('r1')])
    const restarted = notifierWith(kv)
    expect(await restarted.away([approval('r1')])).toEqual([])
    expect(restarted.scheduled).toEqual([])
  })

  it('olhando a lista de aprovações não notifica — e o pedido conta como visto', async () => {
    const t = notifierWith()
    await t.notifier.onApprovals({
      hostId: 'host-a',
      hostName: 'Mac',
      approvals: [approval('r1')],
      panes: PANES,
      attention: 'watching'
    })
    expect(await t.away([approval('r1')])).toEqual([])
    expect(t.scheduled).toEqual([])
  })

  it('sem consentimento/permissão não agenda nada (nunca pede permissão)', async () => {
    const t = notifierWith(memoryKv(), false)
    expect(await t.away([approval('r1')])).toEqual([])
    expect(t.scheduled).toEqual([])
  })

  it('pedido respondido sai da bandeja; hosts têm livros separados', async () => {
    const t = notifierWith()
    await t.away([approval('r1')])
    await t.away([])
    expect(t.dismissed).toEqual(['nexus-approval:host-a:r1'])
    expect(await t.away([approval('r1')], 'host-b')).toEqual(['r1'])
  })

  it('aprovação sem resposta ao vivo não notifica', async () => {
    const t = notifierWith()
    const stale = { ...approval('r1'), responseCapability: 'none' } as unknown as NexusApproval
    expect(await t.away([stale])).toEqual([])
  })
})

describe('toque na notificação', () => {
  const data = nexusApprovalNotificationData('host-a', { paneId: 'p1', requestId: 'r1' })

  it('o roteamento de toque existente abre o host Nexus', () => {
    expect(
      getNotificationNavigationTarget(data, { knownHostIds: new Set(['host-a']) })
    ).toEqual({ hostId: 'host-a', sessionTarget: null })
  })

  it('o toque deixa o foco para a tela do host, uma vez', () => {
    noteNexusHostNotificationTap(data, { remote: false })
    expect(takeNexusHostNotificationFocus('host-b')).toBeNull()
    expect(takeNexusHostNotificationFocus('host-a')).toEqual({
      hostId: 'host-a',
      paneId: 'p1',
      requestId: 'r1'
    })
    expect(takeNexusHostNotificationFocus('host-a')).toBeNull()
  })

  it('push remoto não escolhe foco; dado malformado é ignorado', () => {
    noteNexusHostNotificationTap(data, { remote: true })
    expect(takeNexusHostNotificationFocus('host-a')).toBeNull()
    expect(readNexusNotificationFocus({ hostId: 'host-a', nexusHost: { paneId: 1 } })).toBeNull()
    expect(readNexusNotificationFocus(null)).toBeNull()
  })

  it('aprovação ainda pendente foca a lista; já respondida abre o pane', () => {
    const focus = { hostId: 'host-a', paneId: 'p1', requestId: 'r1' }
    const snapshot = (approvals: NexusApproval[]): NexusOpsSnapshot => ({
      panes: PANES,
      missions: [],
      approvals
    })
    expect(resolveNexusNotificationFocus(focus, snapshot([approval('r1')]))).toEqual({
      kind: 'approval'
    })
    expect(resolveNexusNotificationFocus(focus, snapshot([]))).toEqual({
      kind: 'pane',
      pane: PANES[0]
    })
    expect(
      resolveNexusNotificationFocus({ ...focus, paneId: 'sumiu' }, snapshot([]))
    ).toEqual({ kind: 'host' })
  })
})

// ─── MOB-05 (F-1021): atividade dos panes ───

describe('notificação de atividade do pane (MOB-05)', () => {
  const activityOf = (
    t: ReturnType<typeof notifierWith>,
    transition: NexusPaneActivityTransition,
    attention: 'watching' | 'away' = 'away',
    hostId = 'host-a'
  ) =>
    t.notifier.onActivity({ hostId, hostName: 'Mac', transition, paneTitle: 'Claude', attention })
  const waiting = (at: number, paneId = 'p1'): NexusPaneActivityTransition => ({
    paneId,
    from: 'working',
    to: 'waiting',
    at
  })

  it('"esperando você" avisa uma vez por pane e transição — push repetido e releitura não repetem', async () => {
    const t = notifierWith()
    expect(await activityOf(t, waiting(100))).toBe(true)
    expect(await activityOf(t, waiting(100))).toBe(false)
    // Outra transição do mesmo pane (o desktop mudou de novo) avisa de novo, no mesmo lugar da bandeja.
    expect(await activityOf(t, waiting(200))).toBe(true)
    // Outro pane é outro aviso.
    expect(await activityOf(t, waiting(100, 'p2'))).toBe(true)
    expect(t.scheduled.map((request) => request.identifier)).toEqual([
      'nexus-activity:host-a:p1',
      'nexus-activity:host-a:p1',
      'nexus-activity:host-a:p2'
    ])
    expect(t.scheduled[0]).toMatchObject({
      title: 'Esperando você · Mac',
      body: 'Claude: o agente parou numa pergunta ou permissão.',
      data: { hostId: 'host-a', nexusHost: { paneId: 'p1' } }
    })
    expect(JSON.stringify(t.scheduled[0]!.data)).not.toContain('requestId')
  })

  it('dois avisos simultâneos e o reinício do app não duplicam', async () => {
    const kv = memoryKv()
    const t = notifierWith(kv)
    const results = await Promise.all([activityOf(t, waiting(100)), activityOf(t, waiting(100))])
    expect(results.filter(Boolean)).toHaveLength(1)
    const restarted = notifierWith(kv)
    expect(await activityOf(restarted, waiting(100))).toBe(false)
    expect(restarted.scheduled).toEqual([])
  })

  it('"terminou" só de trabalhando para parado; o resto não avisa', async () => {
    const t = notifierWith()
    const finished = (from: NexusPaneActivityTransition['from'], at: number) =>
      activityOf(t, { paneId: 'p1', from, to: 'idle', at })
    expect(await finished('working', 1)).toBe(true)
    expect(t.scheduled[0]).toMatchObject({
      title: 'Terminou · Mac',
      body: 'Claude: o agente terminou o turno.'
    })
    expect(await finished(null, 2)).toBe(false)
    expect(await finished('waiting', 3)).toBe(false)
    expect(await activityOf(t, { paneId: 'p1', from: 'idle', to: 'working', at: 4 })).toBe(false)
    expect(await activityOf(t, { paneId: 'p1', from: 'working', to: 'exited', at: 5 })).toBe(false)
    expect(t.scheduled).toHaveLength(1)
  })

  it('olhando o pane não avisa (e conta como visto); sem consentimento/permissão nada é agendado', async () => {
    const t = notifierWith()
    expect(await activityOf(t, waiting(100), 'watching')).toBe(false)
    expect(await activityOf(t, waiting(100))).toBe(false)
    expect(t.scheduled).toEqual([])
    const denied = notifierWith(memoryKv(), false)
    expect(await activityOf(denied, waiting(100))).toBe(false)
    expect(denied.scheduled).toEqual([])
  })

  it('o toque abre o pane do aviso (sem aprovação para focar)', () => {
    const data = { hostId: 'host-a', nexusHost: { paneId: 'p1' } }
    const focus = readNexusNotificationFocus(data)
    expect(focus).toEqual({ hostId: 'host-a', paneId: 'p1', requestId: null })
    expect(
      resolveNexusNotificationFocus(focus!, { panes: PANES, missions: [], approvals: [approval('r1')] })
    ).toEqual({ kind: 'pane', pane: PANES[0] })
    expect(getNotificationNavigationTarget(data, { knownHostIds: new Set(['host-a']) })).toEqual({
      hostId: 'host-a',
      sessionTarget: null
    })
    expect(
      readNexusNotificationFocus({ hostId: 'host-a', nexusHost: { paneId: 'p1', requestId: 7 } })
    ).toBeNull()
  })
})
