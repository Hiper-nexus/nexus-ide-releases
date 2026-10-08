// Host "nexus-bridge" (F-994): o RpcClient do app falando com a Remote Bridge do
// desktop Nexus. Os métodos do app (protocolo Orca) que têm equivalente viram
// comandos da bridge; o resto responde `nexus_host_unsupported` com a frase
// "… não disponível em host Nexus" — nunca uma falha muda. TS puro: o teste de
// ponta a ponta do desktop sobe a bridge real e usa este módulo por caminho.
//
//   status.get                      → status
//   terminal.list                   → ops.snapshot (panes)
//   terminal.subscribe/unsubscribe  → pane.stream.open/close + pane.read inicial
//   terminal.send (linha completa)  → pane.input
//   terminal.updateViewport         → pane.resize
//   terminal.close                  → pane.close
//   mission.list                    → mission.list
//   agentSession.respondToApproval  → agentSession.respondToApproval
//   aprovações pendentes            → ops.snapshot.approvals + push approvals.changed
import { parseApprovalPrompt, type PendingApprovalEnvelope } from '../../../src/shared/approval-decision'
import {
  NexusBridgeClient,
  NexusBridgeDeliveryUnknownError,
  NexusBridgeRemoteError,
  type NexusBridgeClientOptions,
  type NexusBridgeConnectionState,
  type NexusBridgePush,
  type NexusBridgeRequestOptions
} from './nexus-bridge-client'
import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from './terminal-stream-protocol'

export const NEXUS_HOST_UNSUPPORTED = 'nexus_host_unsupported'
export const NEXUS_BRIDGE_REFUSED = 'nexus_bridge_refused'

export const NEXUS_RAW_KEYS_MESSAGE =
  'Teclas cruas (Ctrl-C, Esc, "1"…) não disponíveis em host Nexus: a bridge só aceita um ' +
  'comando completo por vez, enviado com Enter. Responda aprovações pelo card.'

const UNSUPPORTED_AREAS: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['files.', 'Arquivos'],
  ['git.', 'Git'],
  ['worktree.', 'Worktrees'],
  ['repo.', 'Repositórios'],
  ['session.tabs.', 'Abas de sessão'],
  ['accounts.', 'Contas'],
  ['speech.', 'Voz e ditado'],
  ['browser.', 'Navegador e screencast'],
  ['linear.', 'Linear'],
  ['github.', 'GitHub'],
  ['gitlab.', 'GitLab'],
  ['notifications.', 'Notificações push'],
  ['nativeChat.', 'Chat nativo'],
  ['agentSession.', 'Sessão de agente estruturada']
]

export function nexusUnsupportedMessage(method: string): string {
  const area = UNSUPPORTED_AREAS.find(([prefix]) => method.startsWith(prefix))?.[1]
  return `${area ? `${area} (${method})` : method} não disponível em host Nexus`
}

export type NexusRpcResponse =
  | { id: string; ok: true; result: unknown; _meta: { runtimeId: string } }
  | {
      id: string
      ok: false
      error: { code: string; message: string }
      _meta: { runtimeId: string }
    }

export type NexusPane = {
  readonly paneId: string
  readonly title: string
  readonly state: string
  readonly kind: string
  readonly paneNumber?: number
}

export type NexusMission = { readonly id: string; readonly title: string; readonly status: string }

export type NexusApproval = PendingApprovalEnvelope & {
  readonly paneId: string
  readonly expiresAt: number
}

export type NexusOpsSnapshot = {
  readonly panes: readonly NexusPane[]
  readonly missions: readonly NexusMission[]
  readonly approvals: readonly NexusApproval[]
}

/** `reset` = texto completo (pane.read); sem reset = trecho novo do push. */
export type NexusPaneOutput = { readonly type: 'nexus.output'; readonly text: string; readonly reset: boolean }

export type NexusHostApi = {
  snapshot: () => Promise<NexusOpsSnapshot>
  sendLine: (paneId: string, text: string, messageId?: string) => Promise<void>
  closePane: (paneId: string) => Promise<void>
  subscribePane: (paneId: string, listener: (output: NexusPaneOutput) => void) => () => void
  onApprovalsChanged: (listener: () => void) => () => void
}

type ForegroundNudge = 'focus' | 'app-resume' | 'network-change'

/** Mesmo formato do RpcClient do app (conferido por tipo em host-logical-client.ts). */
export type NexusBridgeRpcClient = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; failWhenDisconnected?: boolean; budgetSpansConnect?: boolean }
  ) => Promise<NexusRpcResponse>
  subscribe: (method: string, params: unknown, onData: (result: unknown) => void) => () => void
  updateTerminalSubscriptionViewport: (
    terminal: string,
    viewport: { cols: number; rows: number }
  ) => void
  getState: () => NexusBridgeConnectionState
  getReconnectAttempt: () => number
  getLastConnectedAt: () => number | null
  getLastInboundAt: () => number | null
  onStateChange: (listener: (state: NexusBridgeConnectionState) => void) => () => void
  notifyForeground: (reason?: ForegroundNudge) => void
  close: () => void
  readonly nexus: NexusHostApi
}

class NexusUnsupportedError extends Error {}

/** A fachada Nexus do cliente do host, ou null para host Orca. */
export function nexusHostApiOf(client: unknown): NexusHostApi | null {
  const nexus = isRecord(client) ? client.nexus : null
  return isRecord(nexus) && typeof nexus.snapshot === 'function' ? (nexus as NexusHostApi) : null
}

type PaneSubscription = {
  readonly paneId: string
  readonly listener: (output: NexusPaneOutput) => void
  streamId: number | null
  lastSeq: number
  resyncing: boolean
  closed: boolean
}

const RUNTIME_META = { runtimeId: 'nexus-bridge' }
// CSI, OSC, escapes de 2 bytes e CR: a tela mostra texto, não emula terminal.
// oxlint-disable-next-line no-control-regex -- removendo sequências de controle de propósito
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\r/g
// Mesma classe que o desktop recusa (authorizeRemotePaneInput, F-1000). Aqui é só
// UX — avisar sem ir à bridge; a autoridade é o Main.
// oxlint-disable-next-line no-control-regex -- detectando tecla crua de propósito
const RAW_KEY_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

// F-1015: a fila offline do host Nexus recusa tecla crua antes de guardar o comando.
export function isNexusRawKeyInput(text: string): boolean {
  return RAW_KEY_PATTERN.test(text)
}

export function stripTerminalControl(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export function createNexusBridgeRpcClient(
  options: NexusBridgeClientOptions
): NexusBridgeRpcClient {
  const client = new NexusBridgeClient(options)
  const approvalListeners = new Set<() => void>()
  const loggedUnsupported = new Set<string>()
  let active: PaneSubscription | null = null
  let everConnected = false
  let requestSeq = 0

  const request = (
    type: string,
    fields: Record<string, unknown> = {},
    requestOptions?: NexusBridgeRequestOptions
  ) => client.request(type, fields, requestOptions)

  const unsupported = (method: string): NexusUnsupportedError => {
    const message = nexusUnsupportedMessage(method)
    if (!loggedUnsupported.has(method)) {
      loggedUnsupported.add(method)
      options.onLog?.('warn', message)
    }
    return new NexusUnsupportedError(message)
  }

  const snapshot = async (): Promise<NexusOpsSnapshot> => readSnapshot(await request('ops.snapshot'))

  const sendLine = async (paneId: string, text: string, messageId?: string): Promise<void> => {
    if (RAW_KEY_PATTERN.test(text)) {
      throw new NexusUnsupportedError(NEXUS_RAW_KEYS_MESSAGE)
    }
    if (!text.trim()) {
      throw new NexusBridgeRemoteError('linha vazia')
    }
    const result = await request('pane.input', {
      paneId,
      data: text,
      ...(messageId ? { messageId } : {})
    })
    if (!isRecord(result) || result.ok !== true) {
      throw new NexusBridgeRemoteError('o desktop não entregou a linha ao terminal')
    }
  }

  const closePane = async (paneId: string): Promise<void> => {
    const result = await request('pane.close', { paneId })
    if (!isRecord(result) || result.ok !== true) {
      throw new NexusBridgeRemoteError('o desktop não fechou o pane')
    }
  }

  const resync = async (sub: PaneSubscription): Promise<void> => {
    if (sub.resyncing) {
      return
    }
    sub.resyncing = true
    try {
      const read = await request('pane.read', { paneId: sub.paneId, lines: 200 })
      if (sub.closed || !isRecord(read)) {
        return
      }
      const stream = isRecord(read.stream) ? read.stream : null
      // O cursor de push vem do mesmo instante do texto lido: pushes até ele já estão aqui.
      if (typeof stream?.pushSeq === 'number') {
        sub.lastSeq = stream.pushSeq
      }
      sub.listener({
        type: 'nexus.output',
        text: stripTerminalControl(typeof read.output === 'string' ? read.output : ''),
        reset: true
      })
    } finally {
      sub.resyncing = false
    }
  }

  const openPaneStream = async (sub: PaneSubscription): Promise<void> => {
    sub.streamId = null
    try {
      // Abre o push ANTES de ler: o que sair entre os dois chega pelo push e o
      // pushSeq do pane.read descarta o que a leitura já cobriu.
      const opened = await request('pane.stream.open', { paneId: sub.paneId })
      if (sub.closed) {
        return
      }
      if (isRecord(opened) && opened.pushAvailable === true && typeof opened.streamId === 'number') {
        sub.streamId = opened.streamId
        sub.lastSeq = typeof opened.pushSeq === 'number' ? opened.pushSeq : 0
      } else {
        // ponytail: bridge sem push mostra só a leitura inicial; o PWA ainda faz poll de 2,5 s.
        options.onLog?.('warn', 'a bridge não empurra saída: mostrando só a leitura inicial')
      }
      await resync(sub)
    } catch (error) {
      if (!sub.closed) {
        options.onLog?.('error', `não abriu o pane ${sub.paneId}: ${errorMessage(error)}`)
        sub.listener({
          type: 'nexus.output',
          text: `[não foi possível abrir o terminal: ${errorMessage(error)}]\n`,
          reset: true
        })
      }
    }
  }

  const handlePanePush = (push: NexusBridgePush): void => {
    const sub = active
    if (!sub || sub.closed || sub.streamId === null || push.streamId !== sub.streamId) {
      return
    }
    if (sub.resyncing || typeof push.seq !== 'number' || push.seq <= sub.lastSeq) {
      return
    }
    if (sub.lastSeq && push.seq !== sub.lastSeq + 1) {
      // Gap (backpressure no desktop ou reconexão): um pane.read reconcilia tudo.
      void resync(sub).catch(() => undefined)
      return
    }
    const frame = decodeTerminalStreamFrame(base64ToBytes(push.frameBase64))
    if (!frame || frame.opcode !== TerminalStreamOpcode.Output) {
      return
    }
    sub.lastSeq = push.seq
    sub.listener({
      type: 'nexus.output',
      text: stripTerminalControl(decodeTerminalStreamText(frame.payload)),
      reset: false
    })
  }

  const subscribePane = (
    paneId: string,
    listener: (output: NexusPaneOutput) => void
  ): (() => void) => {
    // ponytail: a bridge mantém UMA inscrição de push por socket (subscribePaneStream);
    // abrir outro pane substitui a anterior aqui também.
    if (active) {
      active.closed = true
    }
    const sub: PaneSubscription = {
      paneId,
      listener,
      streamId: null,
      lastSeq: 0,
      resyncing: false,
      closed: false
    }
    active = sub
    void openPaneStream(sub)
    return () => {
      sub.closed = true
      if (active !== sub) {
        return
      }
      active = null
      void request('pane.stream.close', { paneId }, { failWhenDisconnected: true }).catch(
        () => undefined
      )
    }
  }

  client.onPush((push) => {
    if (push.type === 'approvals.changed') {
      for (const listener of [...approvalListeners]) {
        listener()
      }
      return
    }
    if (push.type === 'pane.stream.data') {
      handlePanePush(push)
    }
  })

  client.onStateChange((state) => {
    if (state !== 'connected') {
      return
    }
    if (everConnected && active && !active.closed) {
      // Socket novo: a inscrição de push morreu com o antigo.
      void openPaneStream(active)
    }
    everConnected = true
  })

  const route = async (
    method: string,
    params: unknown,
    requestOptions: NexusBridgeRequestOptions
  ): Promise<unknown> => {
    const p = isRecord(params) ? params : {}
    switch (method) {
      case 'status.get': {
        const status = await request('status', {}, requestOptions)
        return { ...(isRecord(status) ? status : {}), nexusBridge: true }
      }
      case 'terminal.list': {
        const { panes } = await snapshot()
        return {
          terminals: panes.map((pane) => ({
            handle: pane.paneId,
            title: pane.title,
            state: pane.state,
            kind: pane.kind
          }))
        }
      }
      case 'terminal.send': {
        const paneId = requireString(p.terminal, 'terminal')
        const text = typeof p.text === 'string' ? p.text : ''
        if (p.enter === false) {
          throw new NexusUnsupportedError(NEXUS_RAW_KEYS_MESSAGE)
        }
        await sendLine(
          paneId,
          text,
          typeof p.clientMessageId === 'string' ? p.clientMessageId : undefined
        )
        return { ok: true }
      }
      case 'terminal.close':
        await closePane(requireString(p.terminal, 'terminal'))
        return { ok: true }
      case 'terminal.updateViewport': {
        const viewport = isRecord(p.viewport) ? p.viewport : {}
        return request(
          'pane.resize',
          { paneId: requireString(p.terminal, 'terminal'), cols: viewport.cols, rows: viewport.rows },
          requestOptions
        )
      }
      case 'terminal.unsubscribe': {
        const paneId = typeof p.terminal === 'string' ? p.terminal : undefined
        if (active && (!paneId || active.paneId === paneId)) {
          active.closed = true
          active = null
        }
        return request('pane.stream.close', paneId ? { paneId } : {}, requestOptions)
      }
      case 'mission.list':
        return request('mission.list', {}, requestOptions)
      case 'agentSession.respondToApproval':
        return request(
          'agentSession.respondToApproval',
          { itemId: p.itemId, expectedRevision: p.expectedRevision, optionId: p.optionId },
          requestOptions
        )
      default:
        throw unsupported(method)
    }
  }

  const nexus: NexusHostApi = {
    snapshot,
    sendLine,
    closePane,
    subscribePane,
    onApprovalsChanged: (listener) => {
      approvalListeners.add(listener)
      return () => approvalListeners.delete(listener)
    }
  }

  client.start()

  return {
    async sendRequest(method, params, sendOptions = {}) {
      const id = `nexus-${++requestSeq}`
      try {
        const result = await route(method, params, {
          timeoutMs: sendOptions.timeoutMs,
          failWhenDisconnected: sendOptions.failWhenDisconnected
        })
        return { id, ok: true, result, _meta: RUNTIME_META }
      } catch (error) {
        if (error instanceof NexusUnsupportedError) {
          return failure(id, NEXUS_HOST_UNSUPPORTED, error.message)
        }
        if (error instanceof NexusBridgeRemoteError) {
          return failure(id, NEXUS_BRIDGE_REFUSED, error.message)
        }
        if (error instanceof NexusBridgeDeliveryUnknownError) {
          throw markRpcDeliveryUnknown(error)
        }
        throw error
      }
    },
    subscribe(method, params, onData) {
      if (method === 'terminal.subscribe' && isRecord(params) && typeof params.terminal === 'string') {
        return subscribePane(params.terminal, onData)
      }
      unsupported(method)
      return () => undefined
    },
    updateTerminalSubscriptionViewport(terminal, viewport) {
      void request('pane.resize', { paneId: terminal, cols: viewport.cols, rows: viewport.rows }).catch(
        (error: unknown) => options.onLog?.('warn', `pane.resize recusado: ${errorMessage(error)}`)
      )
    },
    getState: () => client.getState(),
    getReconnectAttempt: () => client.getReconnectAttempt(),
    getLastConnectedAt: () => client.getLastConnectedAt(),
    getLastInboundAt: () => client.getLastInboundAt(),
    onStateChange: (listener) => client.onStateChange(listener),
    notifyForeground: () => client.reconnectNow(),
    close() {
      if (active) {
        active.closed = true
        active = null
      }
      approvalListeners.clear()
      client.close()
    },
    nexus
  }
}

function failure(id: string, code: string, message: string): NexusRpcResponse {
  return { id, ok: false, error: { code, message }, _meta: RUNTIME_META }
}

function readSnapshot(raw: unknown): NexusOpsSnapshot {
  const record = isRecord(raw) ? raw : {}
  const panes = arrayOf(record.panes).flatMap((pane): NexusPane[] =>
    typeof pane.paneId === 'string' && pane.paneId
      ? [
          {
            paneId: pane.paneId,
            title: typeof pane.title === 'string' && pane.title ? pane.title : pane.paneId,
            state: typeof pane.state === 'string' ? pane.state : 'unknown',
            kind: typeof pane.kind === 'string' ? pane.kind : 'shell',
            ...(typeof pane.paneNumber === 'number' ? { paneNumber: pane.paneNumber } : {})
          }
        ]
      : []
  )
  const missions = arrayOf(record.missions).flatMap((mission): NexusMission[] =>
    typeof mission.id === 'string'
      ? [
          {
            id: mission.id,
            title: typeof mission.title === 'string' && mission.title ? mission.title : mission.id,
            status: typeof mission.status === 'string' ? mission.status : ''
          }
        ]
      : []
  )
  const approvals = arrayOf(record.approvals).flatMap((approval): NexusApproval[] => {
    // Mesma validação do envelope que o card estruturado do app já usa.
    const parsed = parseApprovalPrompt(JSON.stringify({ approval }))?.structured
    if (!parsed || typeof approval.paneId !== 'string') {
      return []
    }
    return [
      {
        ...parsed,
        paneId: approval.paneId,
        expiresAt: typeof approval.expiresAt === 'number' ? approval.expiresAt : 0
      }
    ]
  })
  return { panes, missions, approvals }
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new NexusBridgeRemoteError(`parâmetro ${name} ausente`)
  }
  return value
}

function base64ToBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string') {
    return new Uint8Array(0)
  }
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return new Uint8Array(0)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
