// Cliente WSS da Remote Bridge do Nexus (F-994). Porte em TS puro do lado
// cliente do PWA "Nexus Remote" (src/main/remote/remote-client-page.ts: connect,
// send, pareamento e bootWithSavedToken) para o app Expo — sem React Native, para
// o teste de ponta a ponta do desktop importar este arquivo por caminho.
//
// Protocolo (src/main/remote/remote-bridge.ts): JSON `{id, type, ...campos}` →
// `{id, ok, result}` | `{id, ok:false, error}`; pushes sem id (`pane.stream.data`,
// `approvals.changed`). Pareamento: `pair` com o código + chave pública + prova
// `nexus-remote-pair-v1:<código>` assinada. Retomada: `auth.challenge` → `auth`
// com o desafio assinado. O token sozinho não autentica.
import type { NexusBridgeDeviceIdentity } from './nexus-bridge-device-key'

/** Mesmos nomes do ConnectionState do app, para o adaptador repassar sem tabela. */
export type NexusBridgeConnectionState =
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth-failed'

export type NexusBridgeSocketHandlers = {
  onOpen: () => void
  onMessage: (data: string) => void
  onClose: (code: number, reason: string) => void
  onError: (message: string) => void
}

export type NexusBridgeSocket = {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}

export type NexusBridgeSocketFactory = (
  url: string,
  handlers: NexusBridgeSocketHandlers
) => NexusBridgeSocket

export type NexusBridgePush = { readonly type: string; readonly [key: string]: unknown }

export type NexusBridgePairResult = {
  readonly token: string
  readonly expiresAt: number
  readonly deviceKeyFingerprint: string
}

export type NexusBridgeLog = (level: 'info' | 'warn' | 'error', message: string) => void

export type NexusBridgeClientOptions = {
  readonly url: string
  readonly identity: () => Promise<NexusBridgeDeviceIdentity>
  /** Token salvo de um pareamento anterior; sem ele o cliente só sabe parear. */
  readonly token?: string | null
  readonly createSocket: NexusBridgeSocketFactory
  readonly requestTimeoutMs?: number
  readonly reconnectBaseMs?: number
  readonly reconnectMaxMs?: number
  readonly random?: () => number
  readonly onLog?: NexusBridgeLog
}

export type NexusBridgeRequestOptions = {
  readonly timeoutMs?: number
  /** Recusa na hora em vez de esperar a reconexão. */
  readonly failWhenDisconnected?: boolean
}

/** Credencial recusada pelo desktop: só um novo pareamento resolve. */
export class NexusBridgeAuthError extends Error {}

/** O pedido saiu pelo socket e a resposta não chegou: o desktop pode tê-lo executado. */
export class NexusBridgeDeliveryUnknownError extends Error {}

/** O desktop respondeu `ok:false`. */
export class NexusBridgeRemoteError extends Error {}

type PendingFrame = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type ConnectWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Mesmo prazo do PWA (send(): 8 s).
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000
// O desktop fecha com estes motivos quando o token morre (closeAuthenticatedClient).
const AUTH_CLOSE_REASON = /token|revoked|revogad|expired|expirad/i
// Recusas da credencial no auth (remote-bridge.ts: `auth.challenge` → "invalid
// token or device"; `auth` → "invalid device authentication"). O resto
// ("rate limited", "bridge project scope is unavailable"…) é transitório.
const CREDENTIAL_REJECTED = /invalid token|invalid device|revoked|expired/i

export class NexusBridgeClient {
  private readonly options: NexusBridgeClientOptions
  private token: string | null
  private socket: NexusBridgeSocket | null = null
  private socketOpen = false
  private generation = 0
  private nextId = 1
  private state: NexusBridgeConnectionState = 'disconnected'
  private attempt = 0
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private openWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  private readonly pending = new Map<string, PendingFrame>()
  private readonly connectWaiters = new Set<ConnectWaiter>()
  private readonly stateListeners = new Set<(state: NexusBridgeConnectionState) => void>()
  private readonly pushListeners = new Set<(push: NexusBridgePush) => void>()
  private lastConnectedAt: number | null = null
  private lastInboundAt: number | null = null

  constructor(options: NexusBridgeClientOptions) {
    this.options = options
    this.token = options.token ?? null
  }

  getState(): NexusBridgeConnectionState {
    return this.state
  }

  getReconnectAttempt(): number {
    return this.attempt
  }

  getLastConnectedAt(): number | null {
    return this.lastConnectedAt
  }

  getLastInboundAt(): number | null {
    return this.lastInboundAt
  }

  getToken(): string | null {
    return this.token
  }

  onStateChange(listener: (state: NexusBridgeConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onPush(listener: (push: NexusBridgePush) => void): () => void {
    this.pushListeners.add(listener)
    return () => this.pushListeners.delete(listener)
  }

  /**
   * Conecta e autentica com o token salvo. Idempotente. Durante o backoff não
   * abre socket: quem chama espera o timer (só reconnectNow pula a espera).
   */
  start(): void {
    if (
      this.closed ||
      !this.token ||
      this.socket ||
      this.reconnectTimer ||
      this.state === 'auth-failed'
    ) {
      return
    }
    this.openSocket()
  }

  /** App voltou ao primeiro plano / rede mudou: não espere o backoff. */
  reconnectNow(): void {
    if (this.closed || !this.token || this.state === 'connected' || this.state === 'auth-failed') {
      return
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (!this.socket) {
      this.openSocket()
    }
  }

  /** Pareia este aparelho com o código mostrado no desktop; o socket já sai autenticado. */
  async pair(rawCode: string): Promise<NexusBridgePairResult> {
    const code = rawCode.trim().toUpperCase()
    if (!code) {
      throw new Error('informe o código de pareamento')
    }
    const identity = await this.options.identity()
    const deviceProof = identity.sign(`nexus-remote-pair-v1:${code}`)
    await this.ensureSocketOpen()
    this.setState('handshaking')
    const result = (await this.sendFrame('pair', {
      code,
      deviceId: identity.deviceId,
      devicePublicKey: identity.publicKey,
      deviceProof
    })) as Partial<NexusBridgePairResult> | null
    if (!result || typeof result.token !== 'string' || !result.token) {
      throw new Error('o desktop não emitiu token')
    }
    this.token = result.token
    this.markConnected()
    return {
      token: result.token,
      expiresAt: typeof result.expiresAt === 'number' ? result.expiresAt : 0,
      deviceKeyFingerprint:
        typeof result.deviceKeyFingerprint === 'string' ? result.deviceKeyFingerprint : ''
    }
  }

  /** Comando autenticado. Espera a (re)conexão dentro do mesmo prazo. */
  async request(
    type: string,
    fields: Record<string, unknown> = {},
    options: NexusBridgeRequestOptions = {}
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const startedAt = Date.now()
    if (this.state !== 'connected') {
      if (this.state === 'auth-failed') {
        throw new NexusBridgeAuthError('sessão encerrada no desktop — pareie de novo')
      }
      if (options.failWhenDisconnected || this.closed) {
        throw new Error('sem conexão com o desktop')
      }
      this.start()
      await this.waitForConnected(timeoutMs)
    }
    return this.sendFrame(type, fields, Math.max(1, timeoutMs - (Date.now() - startedAt)))
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.socket
    this.dropSocket(new Error('cliente fechado'))
    socket?.close(1000, 'client closed')
    this.rejectConnectWaiters(new Error('cliente fechado'))
    this.setState('disconnected')
  }

  private openSocket(): void {
    const generation = ++this.generation
    this.setState(this.attempt > 0 ? 'reconnecting' : 'connecting')
    const isCurrent = () => generation === this.generation && !this.closed
    this.socketOpen = false
    try {
      this.socket = this.options.createSocket(this.options.url, {
        onOpen: () => {
          if (!isCurrent()) {
            return
          }
          this.socketOpen = true
          for (const waiter of this.openWaiters.splice(0)) {
            waiter.resolve()
          }
          if (this.token) {
            void this.authenticate(generation)
          }
        },
        onMessage: (data) => {
          if (isCurrent()) {
            this.handleMessage(data)
          }
        },
        onClose: (code, reason) => {
          if (isCurrent()) {
            this.handleClose(code, reason)
          }
        },
        onError: (message) => {
          if (isCurrent()) {
            this.log('warn', `falha no socket seguro: ${message || 'erro de rede/TLS'}`)
          }
        }
      })
    } catch (error) {
      this.socket = null
      this.log('error', `não foi possível abrir ${this.options.url}: ${errorMessage(error)}`)
      this.handleClose(0, '')
    }
  }

  private ensureSocketOpen(): Promise<void> {
    if (this.socket && this.socketOpen) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.openWaiters.push({ resolve, reject })
      if (!this.socket) {
        this.openSocket()
      }
    })
  }

  private async authenticate(generation: number): Promise<void> {
    const token = this.token
    if (!token) {
      return
    }
    this.setState('handshaking')
    try {
      const identity = await this.options.identity()
      const challenge = (await this.sendFrame('auth.challenge', {
        token,
        deviceId: identity.deviceId
      })) as { challenge?: unknown; challengeId?: unknown } | null
      if (typeof challenge?.challenge !== 'string' || typeof challenge.challengeId !== 'string') {
        throw new NexusBridgeRemoteError('desafio de autenticação inválido')
      }
      await this.sendFrame('auth', {
        token,
        deviceId: identity.deviceId,
        challengeId: challenge.challengeId,
        signature: identity.sign(challenge.challenge)
      })
      if (generation === this.generation && !this.closed) {
        this.markConnected()
      }
    } catch (error) {
      if (generation !== this.generation || this.closed) {
        return
      }
      // Só a recusa da CREDENCIAL é final (token revogado/expirado, chave
      // trocada): repetir não adianta e só um novo pareamento resolve. Rate
      // limit, bridge parando ou resposta estranha passam: nova tentativa com
      // backoff, sem jogar fora um token válido.
      if (error instanceof NexusBridgeRemoteError && CREDENTIAL_REJECTED.test(error.message)) {
        this.failAuth(`autenticação recusada pelo desktop (${error.message})`)
        return
      }
      if (error instanceof NexusBridgeRemoteError) {
        this.retryAuthLater(`autenticação adiada pelo desktop (${error.message})`)
        return
      }
      this.log('warn', `autenticação interrompida: ${errorMessage(error)}`)
    }
  }

  private retryAuthLater(message: string): void {
    this.log('warn', message)
    const socket = this.socket
    this.dropSocket(new NexusBridgeDeliveryUnknownError(message))
    socket?.close(1000, 'auth retry')
    this.scheduleReconnect()
  }

  private markConnected(): void {
    this.attempt = 0
    this.lastConnectedAt = Date.now()
    this.setState('connected')
    for (const waiter of [...this.connectWaiters]) {
      clearTimeout(waiter.timer)
      this.connectWaiters.delete(waiter)
      waiter.resolve()
    }
  }

  private failAuth(message: string): void {
    this.log('error', message)
    const socket = this.socket
    this.dropSocket(new NexusBridgeAuthError(message))
    socket?.close(1000, 'auth failed')
    this.rejectConnectWaiters(new NexusBridgeAuthError(message))
    this.setState('auth-failed')
  }

  private handleClose(code: number, reason: string): void {
    const wasOpen = this.socketOpen
    this.dropSocket(
      new NexusBridgeDeliveryUnknownError('conexão com o desktop caiu antes da resposta')
    )
    for (const waiter of this.openWaiters.splice(0)) {
      waiter.reject(new Error('falha de conexão segura com o desktop'))
    }
    if (this.closed) {
      return
    }
    if (AUTH_CLOSE_REASON.test(reason)) {
      this.failAuth(`sessão encerrada no desktop (${reason})`)
      return
    }
    if (!this.token) {
      // Ainda pareando: quem chamou pair() já recebeu o erro; não há o que retomar.
      this.setState('disconnected')
      return
    }
    this.log(
      wasOpen ? 'warn' : 'error',
      wasOpen
        ? `conexão encerrada (${code}${reason ? ` ${reason}` : ''})`
        : 'não conectou: rede, porta ou certificado HTTPS não confiável'
    )
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    this.attempt += 1
    const base = this.options.reconnectBaseMs ?? 1_000
    const max = this.options.reconnectMaxMs ?? 30_000
    const random = this.options.random ?? Math.random
    // Exponencial com teto e ±20% de jitter: vários aparelhos atrás do mesmo
    // Tailscale Serve dividem o rate limit da bridge (60 msgs/min por IP).
    const exponential = Math.min(max, base * 2 ** (this.attempt - 1))
    const delay = Math.round(exponential * (0.8 + 0.4 * random()))
    this.setState('reconnecting')
    // Um único timer: um segundo agendamento substitui o anterior em vez de
    // deixar dois sockets nascerem no fim do backoff.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closed && !this.socket) {
        this.openSocket()
      }
    }, delay)
  }

  private dropSocket(error: Error): void {
    this.socket = null
    this.socketOpen = false
    this.generation += 1
    for (const [id, frame] of this.pending) {
      clearTimeout(frame.timer)
      this.pending.delete(id)
      frame.reject(error)
    }
  }

  private rejectConnectWaiters(error: Error): void {
    for (const waiter of [...this.connectWaiters]) {
      clearTimeout(waiter.timer)
      this.connectWaiters.delete(waiter)
      waiter.reject(error)
    }
    for (const waiter of this.openWaiters.splice(0)) {
      waiter.reject(error)
    }
  }

  private waitForConnected(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: ConnectWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.connectWaiters.delete(waiter)
          reject(new Error('sem conexão com o desktop (tempo esgotado)'))
        }, timeoutMs)
      }
      this.connectWaiters.add(waiter)
    })
  }

  private sendFrame(
    type: string,
    fields: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const socket = this.socket
    if (!socket || !this.socketOpen) {
      return Promise.reject(new Error('sem conexão com o desktop'))
    }
    const id = `m${this.nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new NexusBridgeDeliveryUnknownError('o desktop não respondeu a tempo'))
        }
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ ...fields, id, type }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`falha ao enviar: ${errorMessage(error)}`))
      }
    })
  }

  private handleMessage(data: string): void {
    this.lastInboundAt = Date.now()
    let message: Record<string, unknown>
    try {
      const parsed = JSON.parse(data) as unknown
      if (!parsed || typeof parsed !== 'object') {
        return
      }
      message = parsed as Record<string, unknown>
    } catch {
      return
    }
    const id = typeof message.id === 'string' ? message.id : null
    const frame = id ? this.pending.get(id) : undefined
    if (id && frame) {
      this.pending.delete(id)
      clearTimeout(frame.timer)
      if (message.ok === true) {
        frame.resolve(message.result)
      } else {
        frame.reject(
          new NexusBridgeRemoteError(
            typeof message.error === 'string' ? message.error : 'erro desconhecido do desktop'
          )
        )
      }
      return
    }
    if (typeof message.type === 'string') {
      const push = message as NexusBridgePush
      for (const listener of [...this.pushListeners]) {
        listener(push)
      }
    }
  }

  private setState(next: NexusBridgeConnectionState): void {
    if (this.state === next) {
      return
    }
    this.state = next
    for (const listener of [...this.stateListeners]) {
      listener(next)
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.options.onLog?.(level, message)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Fábrica com o WebSocket global (React Native): confiança TLS do sistema, sem exceção. */
export const globalWebSocketFactory: NexusBridgeSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url)
  socket.onopen = () => handlers.onOpen()
  socket.onmessage = (event) => handlers.onMessage(typeof event.data === 'string' ? event.data : '')
  socket.onclose = (event) => handlers.onClose(event.code, event.reason)
  socket.onerror = (event) =>
    handlers.onError(String((event as { message?: unknown }).message ?? ''))
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason)
  }
}
