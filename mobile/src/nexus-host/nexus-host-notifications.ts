// Notificação local de aprovação no host Nexus (F-1015). Nada de push remoto: o
// app agenda a notificação quando o push `approvals.changed` da bridge (relido pelo
// ops.snapshot) traz um pedido novo e o operador NÃO está olhando a lista de
// aprovações daquele host (app em segundo plano ou um pane aberto).
//
// - Um pedido (requestId) notifica uma vez só — também depois de reconectar, de
//   reabrir a tela ou de reiniciar o app (o livro-razão fica no AsyncStorage).
// - Respeita o fluxo de permissão que já existe: só notifica com o consentimento
//   do app ligado (onboarding/Ajustes) e a permissão do sistema concedida; nunca
//   pede permissão daqui. Som segue a preferência de entrega.
// - O toque abre o host Nexus (rota /h/<host>, pelo roteamento de toque que já
//   existe) e foca a aprovação; se ela já foi respondida, abre o pane dela.
//
// MOB-05 (F-1021): a bridge agora empurra a atividade dos panes (`pane.activity`).
// "Esperando você" e "Terminou" (trabalhando → parado) também viram notificação
// local, com as mesmas regras: consentimento + permissão, um aviso por pane e
// transição (livro-razão próprio no AsyncStorage) e o toque abre o pane.
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Notifications from 'expo-notifications'
import { useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { AGENT_ALERT_CHANNEL_ID } from '../notifications/agent-notification-channels'
import { loadNotificationDeliveryPreferences } from '../notifications/notification-delivery-preferences'
import { getNotificationPermissionState } from '../notifications/notification-permissions'
import type {
  NexusApproval,
  NexusHostApi,
  NexusOpsSnapshot,
  NexusPane
} from '../transport/nexus-bridge-rpc-adapter'
import type { NexusPaneActivityTransition } from './nexus-pane-activity'

const LEDGER_KEY_PREFIX = 'nexus-host:notified-approvals:v1:'
const ACTIVITY_LEDGER_KEY_PREFIX = 'nexus-host:notified-activity:v1:' // MOB-05
const LEDGER_CAP = 200
const BODY_MAX = 160

export type NexusApprovalAttention = 'watching' | 'away'

export type NexusApprovalNotificationRequest = {
  readonly identifier: string
  readonly title: string
  readonly body: string
  readonly data: NexusApprovalNotificationData
  readonly sound: boolean
}

export type NexusApprovalNotificationData = {
  readonly hostId: string
  /** Sem `requestId`: aviso de atividade (MOB-05), o toque abre o pane. */
  readonly nexusHost: { readonly paneId: string; readonly requestId?: string }
}

type LedgerStorage = {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
}

export function nexusApprovalNotificationId(hostId: string, requestId: string): string {
  return `nexus-approval:${hostId}:${requestId}`
}

/** Dados do toque: `hostId` é o que o roteamento existente usa para abrir /h/<host>. */
export function nexusApprovalNotificationData(
  hostId: string,
  approval: Pick<NexusApproval, 'paneId' | 'requestId'>
): NexusApprovalNotificationData {
  return { hostId, nexusHost: { paneId: approval.paneId, requestId: approval.requestId } }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function buildNexusApprovalNotification(input: {
  hostId: string
  hostName: string
  approval: NexusApproval
  panes: readonly NexusPane[]
  sound: boolean
}): NexusApprovalNotificationRequest {
  const { approval } = input
  const pane = input.panes.find((item) => item.paneId === approval.paneId)
  return {
    identifier: nexusApprovalNotificationId(input.hostId, approval.requestId),
    title: `Aprovação pendente · ${input.hostName}`,
    body: truncate(`${pane?.title ?? approval.paneId}: ${approval.tool} — ${approval.summary}`, BODY_MAX),
    data: nexusApprovalNotificationData(input.hostId, approval),
    sound: input.sound
  }
}

// ─── MOB-05: atividade dos panes ───

/** Um aviso por pane na bandeja: a transição nova substitui a anterior. */
export function nexusActivityNotificationId(hostId: string, paneId: string): string {
  return `nexus-activity:${hostId}:${paneId}`
}

/** Só o que pede o operador: "esperando você" e "terminou" (trabalhando → parado). */
export function shouldNotifyNexusActivity(transition: NexusPaneActivityTransition): boolean {
  return transition.to === 'waiting' || (transition.to === 'idle' && transition.from === 'working')
}

export function buildNexusActivityNotification(input: {
  hostId: string
  hostName: string
  transition: NexusPaneActivityTransition
  paneTitle: string
  sound: boolean
}): NexusApprovalNotificationRequest {
  const { transition } = input
  const waiting = transition.to === 'waiting'
  return {
    identifier: nexusActivityNotificationId(input.hostId, transition.paneId),
    title: `${waiting ? 'Esperando você' : 'Terminou'} · ${input.hostName}`,
    body: truncate(
      `${input.paneTitle}: ${waiting ? 'o agente parou numa pergunta ou permissão.' : 'o agente terminou o turno.'}`,
      BODY_MAX
    ),
    data: { hostId: input.hostId, nexusHost: { paneId: transition.paneId } },
    sound: input.sound
  }
}

function nexusActivityLedgerKey(transition: NexusPaneActivityTransition): string {
  return `${transition.paneId}\u0000${transition.to}\u0000${transition.at}`
}

export type NexusApprovalNotifier = ReturnType<typeof createNexusApprovalNotifier>

export function createNexusApprovalNotifier(deps: {
  storage: LedgerStorage
  /** Consentimento do app + permissão do sistema; nunca pede permissão. */
  canNotify: () => Promise<boolean>
  sound: () => Promise<boolean>
  schedule: (request: NexusApprovalNotificationRequest) => Promise<void>
  /** Tira da bandeja o aviso de um pedido que já saiu da fila do desktop. */
  dismiss?: (identifier: string) => Promise<void>
}) {
  const ledgers = new Map<string, Promise<string[]>>()
  const presented = new Map<string, Set<string>>()
  const chains = new Map<string, Promise<unknown>>()

  const ledgerFor = (hostId: string, prefix = LEDGER_KEY_PREFIX): Promise<string[]> => {
    let ledger = ledgers.get(`${prefix}${hostId}`)
    if (!ledger) {
      ledger = deps.storage
        .getItem(`${prefix}${hostId}`)
        .then((raw) => {
          const parsed = raw ? (JSON.parse(raw) as unknown) : []
          return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
        })
        .catch(() => [])
      ledgers.set(`${prefix}${hostId}`, ledger)
    }
    return ledger
  }

  // Um snapshot por vez por host: dois pushes seguidos não notificam o mesmo pedido.
  const serialize = <T>(hostId: string, task: () => Promise<T>): Promise<T> => {
    const run = (chains.get(hostId) ?? Promise.resolve()).then(task, task)
    chains.set(
      hostId,
      run.catch(() => undefined)
    )
    return run
  }

  /** Devolve os requestIds notificados agora. */
  const onApprovals = (input: {
    hostId: string
    hostName: string
    approvals: readonly NexusApproval[]
    panes: readonly NexusPane[]
    attention: NexusApprovalAttention
  }): Promise<string[]> =>
    serialize(input.hostId, async () => {
      const ledger = await ledgerFor(input.hostId)
      const shown = presented.get(input.hostId) ?? new Set<string>()
      presented.set(input.hostId, shown)
      const pending = new Set(input.approvals.map((approval) => approval.requestId))
      for (const requestId of [...shown]) {
        if (!pending.has(requestId)) {
          shown.delete(requestId)
          await deps
            .dismiss?.(nexusApprovalNotificationId(input.hostId, requestId))
            .catch(() => undefined)
        }
      }
      const seen = new Set(ledger)
      const fresh = input.approvals.filter(
        (approval) => approval.responseCapability === 'live' && !seen.has(approval.requestId)
      )
      if (fresh.length === 0) {
        return []
      }
      // Visto na tela ou notificado: os dois contam como "já avisado".
      for (const approval of fresh) {
        ledger.push(approval.requestId)
      }
      ledger.splice(0, Math.max(0, ledger.length - LEDGER_CAP))
      await deps.storage
        .setItem(`${LEDGER_KEY_PREFIX}${input.hostId}`, JSON.stringify(ledger))
        .catch(() => undefined)
      if (input.attention === 'watching' || !(await deps.canNotify().catch(() => false))) {
        return []
      }
      const sound = await deps.sound().catch(() => true)
      const notified: string[] = []
      for (const approval of fresh) {
        try {
          await deps.schedule(
            buildNexusApprovalNotification({
              hostId: input.hostId,
              hostName: input.hostName,
              approval,
              panes: input.panes,
              sound
            })
          )
          notified.push(approval.requestId)
          shown.add(approval.requestId)
        } catch {
          // Falha do agendador não reabre o pedido: ele já está na tela do host.
        }
      }
      return notified
    })

  /**
   * MOB-05: uma transição de atividade. Avisa uma vez por pane+transição — o
   * mesmo push repetido, a releitura depois de reconectar e o reinício do app
   * não avisam de novo. Devolve true quando agendou.
   */
  const onActivity = (input: {
    hostId: string
    hostName: string
    transition: NexusPaneActivityTransition
    paneTitle: string
    attention: NexusApprovalAttention
  }): Promise<boolean> =>
    serialize(input.hostId, async () => {
      if (!shouldNotifyNexusActivity(input.transition)) {
        return false
      }
      const ledger = await ledgerFor(input.hostId, ACTIVITY_LEDGER_KEY_PREFIX)
      const key = nexusActivityLedgerKey(input.transition)
      if (ledger.includes(key)) {
        return false
      }
      ledger.push(key)
      ledger.splice(0, Math.max(0, ledger.length - LEDGER_CAP))
      await deps.storage
        .setItem(`${ACTIVITY_LEDGER_KEY_PREFIX}${input.hostId}`, JSON.stringify(ledger))
        .catch(() => undefined)
      if (input.attention === 'watching' || !(await deps.canNotify().catch(() => false))) {
        return false
      }
      try {
        await deps.schedule(
          buildNexusActivityNotification({
            hostId: input.hostId,
            hostName: input.hostName,
            transition: input.transition,
            paneTitle: input.paneTitle,
            sound: await deps.sound().catch(() => true)
          })
        )
        return true
      } catch {
        return false
      }
    })

  return { onApprovals, onActivity }
}

async function canPresentNexusNotification(): Promise<boolean> {
  if (!(await loadPushNotificationsEnabled())) {
    return false
  }
  return (await getNotificationPermissionState()).granted
}

export const nexusApprovalNotifier = createNexusApprovalNotifier({
  storage: AsyncStorage,
  canNotify: canPresentNexusNotification,
  sound: async () => (await loadNotificationDeliveryPreferences()).sound,
  schedule: async (request) => {
    await Notifications.scheduleNotificationAsync({
      identifier: request.identifier,
      content: {
        title: request.title,
        body: request.body,
        data: request.data,
        sound: request.sound ? 'default' : false
      },
      // Canal de alerta do app (Android); entrega imediata.
      trigger: { channelId: AGENT_ALERT_CHANNEL_ID }
    })
  },
  dismiss: (identifier) => Notifications.dismissNotificationAsync(identifier)
})

/**
 * Liga o notificador à tela do host: relê o snapshot a cada `approvals.changed`
 * (também em segundo plano, enquanto o sistema deixar o app vivo).
 */
export function useNexusApprovalNotifications(args: {
  hostId: string
  hostName: string
  nexus: NexusHostApi | null
  snapshot: NexusOpsSnapshot | null
  /** A lista de aprovações está na tela (nenhum pane aberto). */
  approvalsOnScreen: boolean
  notifier?: NexusApprovalNotifier
}): void {
  const { hostId, hostName, snapshot, approvalsOnScreen } = args
  const notifier = args.notifier ?? nexusApprovalNotifier
  const [appState, setAppState] = useState(AppState.currentState)
  useEffect(() => {
    const sub = AppState.addEventListener('change', setAppState)
    return () => sub.remove()
  }, [])
  useEffect(() => {
    if (!snapshot) {
      return
    }
    void notifier.onApprovals({
      hostId,
      hostName,
      approvals: snapshot.approvals,
      panes: snapshot.panes,
      attention: appState === 'active' && approvalsOnScreen ? 'watching' : 'away'
    })
  }, [appState, approvalsOnScreen, hostId, hostName, notifier, snapshot])
}

/**
 * MOB-05: devolve o `onTransition` para `useNexusPaneActivity`. O operador está
 * olhando (sem aviso) com o app em primeiro plano na lista do host ou no próprio
 * pane; em segundo plano ou em outro pane, avisa.
 */
export function useNexusActivityNotifications(args: {
  hostId: string
  hostName: string
  snapshot: NexusOpsSnapshot | null
  openPaneId: string | null
  notifier?: NexusApprovalNotifier
}): (transition: NexusPaneActivityTransition) => void {
  const latest = useRef(args)
  latest.current = args
  const appState = useRef(AppState.currentState)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      appState.current = next
    })
    return () => sub.remove()
  }, [])
  const [onTransition] = useState(() => (transition: NexusPaneActivityTransition) => {
    const { hostId, hostName, snapshot, openPaneId } = latest.current
    const notifier = latest.current.notifier ?? nexusApprovalNotifier
    const watching =
      appState.current === 'active' && (openPaneId === null || openPaneId === transition.paneId)
    void notifier.onActivity({
      hostId,
      hostName,
      transition,
      paneTitle:
        snapshot?.panes.find((pane) => pane.paneId === transition.paneId)?.title ?? transition.paneId,
      attention: watching ? 'watching' : 'away'
    })
  })
  return onTransition
}

// ─── Toque na notificação → foco no host ───

export type NexusNotificationFocus = {
  readonly hostId: string
  readonly paneId: string
  /** null = aviso de atividade (MOB-05): abre o pane. */
  readonly requestId: string | null
}

export function readNexusNotificationFocus(data: unknown): NexusNotificationFocus | null {
  if (!data || typeof data !== 'object') {
    return null
  }
  const record = data as Record<string, unknown>
  const nexus = record.nexusHost
  if (typeof record.hostId !== 'string' || !record.hostId || !nexus || typeof nexus !== 'object') {
    return null
  }
  const { paneId, requestId } = nexus as Record<string, unknown>
  if (typeof paneId !== 'string' || !paneId) {
    return null
  }
  if (requestId === undefined) {
    return { hostId: record.hostId, paneId, requestId: null }
  }
  return typeof requestId === 'string' && requestId
    ? { hostId: record.hostId, paneId, requestId }
    : null
}

let pendingFocus: NexusNotificationFocus | null = null
const focusListeners = new Set<() => void>()

/**
 * Chamado pelo roteamento de toque (app/_layout.tsx) antes de abrir /h/<host>.
 * Só notificação agendada por este app: push remoto não escolhe foco.
 */
export function noteNexusHostNotificationTap(data: unknown, options: { remote: boolean }): void {
  const focus = options.remote ? null : readNexusNotificationFocus(data)
  if (!focus) {
    return
  }
  pendingFocus = focus
  for (const listener of [...focusListeners]) {
    listener()
  }
}

export function takeNexusHostNotificationFocus(hostId: string): NexusNotificationFocus | null {
  if (pendingFocus?.hostId !== hostId) {
    return null
  }
  const focus = pendingFocus
  pendingFocus = null
  return focus
}

export function subscribeNexusHostNotificationFocus(listener: () => void): () => void {
  focusListeners.add(listener)
  return () => {
    focusListeners.delete(listener)
  }
}

/**
 * Aplica o foco do toque quando o snapshot chega: aprovação ainda pendente → lista
 * com ela destacada; já respondida → abre o pane dela. Devolve o requestId destacado.
 */
export function useNexusHostNotificationFocus(args: {
  hostId: string
  snapshot: NexusOpsSnapshot | null
  showApprovals: () => void
  openPane: (pane: NexusPane) => void
}): string | null {
  const { hostId, snapshot } = args
  const [focus, setFocus] = useState<NexusNotificationFocus | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const actionsRef = useRef(args)
  actionsRef.current = args
  useEffect(() => {
    const take = () => {
      const next = takeNexusHostNotificationFocus(hostId)
      if (next) {
        setFocus(next)
      }
    }
    take()
    return subscribeNexusHostNotificationFocus(take)
  }, [hostId])
  useEffect(() => {
    if (!focus || !snapshot) {
      return
    }
    setFocus(null)
    const decision = resolveNexusNotificationFocus(focus, snapshot)
    if (decision.kind === 'approval') {
      setHighlight(focus.requestId)
      actionsRef.current.showApprovals()
    } else if (decision.kind === 'pane') {
      setHighlight(null)
      actionsRef.current.openPane(decision.pane)
    }
  }, [focus, snapshot])
  return highlight
}

export function resolveNexusNotificationFocus(
  focus: NexusNotificationFocus,
  snapshot: NexusOpsSnapshot
): { kind: 'approval' } | { kind: 'pane'; pane: NexusPane } | { kind: 'host' } {
  if (focus.requestId && snapshot.approvals.some((approval) => approval.requestId === focus.requestId)) {
    return { kind: 'approval' }
  }
  const pane = snapshot.panes.find((item) => item.paneId === focus.paneId)
  return pane ? { kind: 'pane', pane } : { kind: 'host' }
}
