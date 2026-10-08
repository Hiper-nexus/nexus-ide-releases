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
// Lacuna conhecida: a bridge não empurra "pane terminou / precisa de atenção"
// (só `approvals.changed` e `pane.stream.data`), então só aprovação notifica.
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

const LEDGER_KEY_PREFIX = 'nexus-host:notified-approvals:v1:'
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
  readonly nexusHost: { readonly paneId: string; readonly requestId: string }
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

  const ledgerFor = (hostId: string): Promise<string[]> => {
    let ledger = ledgers.get(hostId)
    if (!ledger) {
      ledger = deps.storage
        .getItem(`${LEDGER_KEY_PREFIX}${hostId}`)
        .then((raw) => {
          const parsed = raw ? (JSON.parse(raw) as unknown) : []
          return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
        })
        .catch(() => [])
      ledgers.set(hostId, ledger)
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

  return { onApprovals }
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

// ─── Toque na notificação → foco no host ───

export type NexusNotificationFocus = {
  readonly hostId: string
  readonly paneId: string
  readonly requestId: string
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
  return typeof paneId === 'string' && paneId && typeof requestId === 'string' && requestId
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
  if (snapshot.approvals.some((approval) => approval.requestId === focus.requestId)) {
    return { kind: 'approval' }
  }
  const pane = snapshot.panes.find((item) => item.paneId === focus.paneId)
  return pane ? { kind: 'pane', pane } : { kind: 'host' }
}
