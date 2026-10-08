// Fila offline do host Nexus (F-1015). Reusa o outbox durável do chat nativo
// (mobile-thread-outbox + useMobileThreadOutbox): um escopo por host+pane, drenagem
// sequencial do mais antigo, tentativa gravada antes do envio e o MESMO messageId
// em todo reenvio — o dedup por messageId do desktop (remote-input-dedup.ts) impede
// que um ack perdido vire o comando digitado duas vezes no PTY.
//
// O que é só daqui:
// - revogação (`auth-failed`) RETÉM a fila: nada sai, nem depois de parear de novo,
//   até o operador tocar em "Retomar" ou "Descartar" (a retenção fica no aparelho);
// - recusa do desktop (não autorizado, pane fechado, entrada inválida) tira o comando
//   da fila, mostra a falha e PARA o resto da fila daquele pane — o próximo comando
//   pode depender do que falhou;
// - tecla crua / caractere de controle nunca entra na fila (F-1000).
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  threadOutboxRetryDelayMs,
  type MobileQueuedThreadMessage,
  type MobileThreadOutboxDeliveryOutcome,
  type MobileThreadOutboxManager
} from '../session/mobile-thread-outbox'
import { mobileThreadOutbox, useMobileThreadOutbox } from '../session/use-mobile-thread-outbox'
import { NexusBridgeRemoteError } from '../transport/nexus-bridge-client'
import {
  NEXUS_RAW_KEYS_MESSAGE,
  isNexusRawKeyInput,
  type NexusHostApi
} from '../transport/nexus-bridge-rpc-adapter'
import type { ConnectionState } from '../transport/types'

const SCOPE_PREFIX = 'nexus-host\0'
const NO_MESSAGES: readonly MobileQueuedThreadMessage[] = []
// Igual a use-mobile-thread-outbox.ts: o reenvio de uma entrega ambígua espera.
const UNKNOWN_DELIVERY_MIN_RETRY_MS = 20_000

/** Um escopo por host+pane; 4 partes, nunca colide com `host\0worktree\0aba` do Orca. */
export function nexusOutboxScopeKey(hostId: string, paneId: string): string {
  return `${SCOPE_PREFIX}${hostId}\0pane\0${paneId}`
}

export function parseNexusOutboxScopeKey(
  scopeKey: string
): { hostId: string; paneId: string } | null {
  if (!scopeKey.startsWith(SCOPE_PREFIX)) {
    return null
  }
  const [hostId, marker, paneId, ...rest] = scopeKey.slice(SCOPE_PREFIX.length).split('\0')
  return hostId && marker === 'pane' && paneId && rest.length === 0 ? { hostId, paneId } : null
}

/** Escopos com fila deste host, em qualquer pane. */
export function nexusHostQueuedScopes(
  snapshot: Record<string, readonly MobileQueuedThreadMessage[]>,
  hostId: string
): string[] {
  return Object.keys(snapshot).filter(
    (scopeKey) =>
      (snapshot[scopeKey]?.length ?? 0) > 0 && parseNexusOutboxScopeKey(scopeKey)?.hostId === hostId
  )
}

/**
 * `rejected` = o desktop respondeu ok:false (não autorizado, pane sumiu, entrada
 * inválida): reenviar não muda a resposta. Todo o resto — ack perdido, sem conexão,
 * credencial recusada — é `unknown`: tenta de novo com o MESMO messageId.
 */
export function nexusDeliveryOutcome(error: unknown): Exclude<MobileThreadOutboxDeliveryOutcome, 'accepted'> {
  return error instanceof NexusBridgeRemoteError ? 'rejected' : 'unknown'
}

// ─── Retenção (revogação / recusa), persistida por host e por pane ───

export type NexusOutboxHold = {
  readonly reason: 'revoked' | 'rejected'
  readonly detail: string
  /** O comando recusado (só em `rejected`). */
  readonly text?: string
  readonly at: number
}

type HoldStorage = {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
}

const HOLD_KEY_PREFIX = 'nexus-host:outbox-hold:v1:'

export function nexusHostHoldKey(hostId: string): string {
  return `host:${hostId}`
}

export function nexusScopeHoldKey(scopeKey: string): string {
  return `scope:${encodeURIComponent(scopeKey)}`
}

function readHold(raw: string | null): NexusOutboxHold | null {
  if (!raw) {
    return null
  }
  try {
    const value = JSON.parse(raw) as Partial<NexusOutboxHold>
    if ((value.reason === 'revoked' || value.reason === 'rejected') && typeof value.detail === 'string') {
      return {
        reason: value.reason,
        detail: value.detail,
        ...(typeof value.text === 'string' ? { text: value.text } : {}),
        at: typeof value.at === 'number' ? value.at : 0
      }
    }
  } catch {
    // Retenção ilegível conta como ausente; o operador ainda vê a fila.
  }
  return null
}

export type NexusOutboxHoldStore = ReturnType<typeof createNexusOutboxHoldStore>

export function createNexusOutboxHoldStore(storage: HoldStorage) {
  const holds = new Map<string, NexusOutboxHold>()
  const loads = new Map<string, Promise<void>>()
  const loadedKeys = new Set<string>()
  // Chave mexida depois do início da leitura: o disco antigo não ressuscita nada.
  const touched = new Set<string>()
  const listeners = new Set<() => void>()
  let version = 0
  const emit = () => {
    version += 1
    for (const listener of [...listeners]) {
      listener()
    }
  }

  return {
    get: (key: string): NexusOutboxHold | null => holds.get(key) ?? null,
    isLoaded: (key: string): boolean => loadedKeys.has(key),
    load(key: string): Promise<void> {
      const existing = loads.get(key)
      if (existing) {
        return existing
      }
      const promise = storage
        .getItem(`${HOLD_KEY_PREFIX}${key}`)
        .then(readHold, () => null)
        .then((hold) => {
          if (hold && !touched.has(key)) {
            holds.set(key, hold)
          }
          loadedKeys.add(key)
          emit()
        })
      loads.set(key, promise)
      return promise
    },
    async set(key: string, hold: NexusOutboxHold): Promise<void> {
      touched.add(key)
      holds.set(key, hold)
      emit()
      await storage.setItem(`${HOLD_KEY_PREFIX}${key}`, JSON.stringify(hold)).catch(() => undefined)
    },
    async clear(key: string): Promise<void> {
      touched.add(key)
      if (holds.delete(key)) {
        emit()
      }
      await storage.removeItem(`${HOLD_KEY_PREFIX}${key}`).catch(() => undefined)
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: (): number => version
  }
}

export const nexusOutboxHolds = createNexusOutboxHoldStore(AsyncStorage)

// ─── Entrega ───

type DeliverArgs = {
  readonly nexus: NexusHostApi
  readonly manager: MobileThreadOutboxManager
  readonly holds: NexusOutboxHoldStore
  readonly message: MobileQueuedThreadMessage
}

/** Uma tentativa de um comando da fila: sempre com o messageId da própria fila. */
export async function deliverNexusQueuedCommand({
  nexus,
  manager,
  holds,
  message
}: DeliverArgs): Promise<MobileThreadOutboxDeliveryOutcome> {
  const target = parseNexusOutboxScopeKey(message.scopeKey)
  if (!target) {
    return 'rejected'
  }
  try {
    await nexus.sendLine(target.paneId, message.text, message.messageId)
    return 'accepted'
  } catch (error) {
    const outcome = nexusDeliveryOutcome(error)
    if (outcome === 'rejected') {
      // Para o resto da fila do pane e tira o recusado dela: o operador decide.
      await holds.set(nexusScopeHoldKey(message.scopeKey), {
        reason: 'rejected',
        detail: error instanceof Error ? error.message : String(error),
        text: message.text,
        at: Date.now()
      })
      void manager.remove(message).catch(() => undefined)
    }
    return outcome
  }
}

/** Revogação com fila pendente: retém a fila do host inteiro, visivelmente. */
function useHoldQueueOnRevocation(
  hostId: string,
  state: ConnectionState,
  queuedCount: number,
  holds: NexusOutboxHoldStore
): void {
  useEffect(() => {
    if (state !== 'auth-failed' || queuedCount === 0) {
      return
    }
    const key = nexusHostHoldKey(hostId)
    if (holds.get(key)?.reason === 'revoked') {
      return
    }
    void holds.set(key, {
      reason: 'revoked',
      detail: 'o desktop revogou a credencial deste aparelho',
      at: Date.now()
    })
  }, [hostId, state, queuedCount, holds])
}

function useHoldsVersion(holds: NexusOutboxHoldStore): number {
  return useSyncExternalStore(holds.subscribe, holds.getVersion)
}

function useManagerSnapshot(manager: MobileThreadOutboxManager) {
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot)
}

export type NexusQueuedCommandStatus = 'pending' | 'sending' | 'held'

export type NexusQueuedCommand = {
  readonly messageId: string
  readonly text: string
  readonly status: NexusQueuedCommandStatus
  readonly attempts: number
}

export type NexusPaneOutbox = {
  readonly queued: readonly NexusQueuedCommand[]
  readonly hold: NexusOutboxHold | null
  /** Último comando que o desktop confirmou (some no próximo envio). */
  readonly lastSent: { readonly messageId: string; readonly text: string } | null
  /** Coloca o comando na fila; sai na hora se houver conexão. Erro legível ou null. */
  readonly submit: (text: string) => Promise<string | null>
  readonly cancel: (messageId: string) => Promise<void>
  /** Libera a retenção (revogação do host ou recusa deste pane). */
  readonly resume: () => Promise<void>
  /** Descarta a fila deste pane (e, na revogação, a do host inteiro). */
  readonly discardAll: () => Promise<void>
}

export function useNexusPaneOutbox(args: {
  hostId: string
  paneId: string
  nexus: NexusHostApi
  state: ConnectionState
  manager?: MobileThreadOutboxManager
  holds?: NexusOutboxHoldStore
  newMessageId?: () => string
}): NexusPaneOutbox {
  const { hostId, paneId, nexus, state } = args
  const manager = args.manager ?? mobileThreadOutbox
  const holds = args.holds ?? nexusOutboxHolds
  const scopeKey = nexusOutboxScopeKey(hostId, paneId)
  const hostHoldKey = nexusHostHoldKey(hostId)
  const scopeHoldKey = nexusScopeHoldKey(scopeKey)
  useHoldsVersion(holds)
  const snapshot = useManagerSnapshot(manager)
  const [lastSent, setLastSent] = useState<NexusPaneOutbox['lastSent']>(null)

  useEffect(() => {
    void holds.load(hostHoldKey)
    void holds.load(scopeHoldKey)
  }, [holds, hostHoldKey, scopeHoldKey])

  const hold = holds.get(hostHoldKey) ?? holds.get(scopeHoldKey)
  const holdsLoaded = holds.isLoaded(hostHoldKey) && holds.isLoaded(scopeHoldKey)
  // Sem retenção carregada não há envio: uma revogação gravada antes do reinício vale.
  const sendable = state === 'connected' && holdsLoaded && hold === null
  const hostQueuedCount = nexusHostQueuedScopes(snapshot, hostId).length
  useHoldQueueOnRevocation(hostId, state, hostQueuedCount, holds)

  const nexusRef = useRef(nexus)
  nexusRef.current = nexus
  const deliver = useCallback(
    (message: MobileQueuedThreadMessage) =>
      deliverNexusQueuedCommand({ nexus: nexusRef.current, manager, holds, message }),
    [holds, manager]
  )

  const outbox = useMobileThreadOutbox({
    scopeKey,
    sendable,
    deliver,
    // Sem transcript para conferir eco: o dedup por messageId do desktop cobre o reenvio.
    hasLanded: () => false,
    onDelivered: (message) => setLastSent({ messageId: message.messageId, text: message.text }),
    manager,
    ...(args.newMessageId ? { newMessageId: args.newMessageId } : {})
  })

  const queued = useMemo(
    () =>
      (outbox.queued.length > 0 ? outbox.queued : NO_MESSAGES).map(
        (message): NexusQueuedCommand => ({
          messageId: message.messageId,
          text: message.text,
          attempts: message.attempts,
          status: hold ? 'held' : sendable && message.attempts > 0 ? 'sending' : 'pending'
        })
      ),
    [hold, outbox.queued, sendable]
  )

  const submit = useCallback(
    async (text: string): Promise<string | null> => {
      if (!text.trim()) {
        return null
      }
      if (isNexusRawKeyInput(text)) {
        return NEXUS_RAW_KEYS_MESSAGE
      }
      if (state === 'auth-failed') {
        return 'Sessão revogada: pareie de novo antes de enviar comandos.'
      }
      setLastSent(null)
      return (await outbox.enqueue(text, null))
        ? null
        : 'Não foi possível guardar o comando no aparelho; tente de novo.'
    },
    [outbox, state]
  )

  const resume = useCallback(async () => {
    await Promise.all([holds.clear(hostHoldKey), holds.clear(scopeHoldKey)])
  }, [holds, hostHoldKey, scopeHoldKey])

  const discardAll = useCallback(async () => {
    const hostWide = holds.get(hostHoldKey)?.reason === 'revoked'
    const scopes = hostWide ? nexusHostQueuedScopes(manager.getSnapshot(), hostId) : [scopeKey]
    for (const scope of scopes) {
      for (const message of manager.queued(scope)) {
        if (!manager.isDispatching(message.messageId)) {
          await manager.remove(message, manager.revisionOf(message.messageId)).catch(() => null)
        }
      }
    }
    await resume()
  }, [holds, hostHoldKey, hostId, manager, resume, scopeKey])

  return { queued, hold, lastSent, submit, cancel: outbox.cancel, resume, discardAll }
}

/**
 * Drena, depois da reautenticação, a fila dos panes que NÃO estão abertos (o pane
 * aberto drena pelo próprio useNexusPaneOutbox). Cada pane continua em ordem e um
 * pane retido não segura os outros.
 */
export function useNexusHostOutboxFlush(args: {
  hostId: string
  nexus: NexusHostApi | null
  state: ConnectionState
  activePaneId: string | null
  manager?: MobileThreadOutboxManager
  holds?: NexusOutboxHoldStore
}): number {
  const { hostId, nexus, state, activePaneId } = args
  const manager = args.manager ?? mobileThreadOutbox
  const holds = args.holds ?? nexusOutboxHolds
  const holdsVersion = useHoldsVersion(holds)
  const snapshot = useManagerSnapshot(manager)
  const [retryTick, setRetryTick] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const hostHoldKey = nexusHostHoldKey(hostId)
  const scopes = nexusHostQueuedScopes(snapshot, hostId)
  const scopesKey = scopes.join('\n')

  useEffect(() => {
    let alive = true
    void Promise.all([manager.load(), holds.load(hostHoldKey)]).then(() => {
      if (alive) {
        setLoaded(true)
      }
    })
    return () => {
      alive = false
    }
  }, [holds, hostHoldKey, manager])

  useEffect(() => {
    if (!loaded || !nexus || state !== 'connected' || holds.get(hostHoldKey)) {
      return
    }
    const activeScope = activePaneId ? nexusOutboxScopeKey(hostId, activePaneId) : null
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    void (async () => {
      let retryInMs: number | null = null
      for (const scopeKey of scopesKey ? scopesKey.split('\n') : []) {
        const scopeHold = nexusScopeHoldKey(scopeKey)
        await holds.load(scopeHold)
        if (!alive || scopeKey === activeScope || holds.get(scopeHold) || holds.get(hostHoldKey)) {
          continue
        }
        const result = await manager.drain(scopeKey, {
          deliver: (message) => deliverNexusQueuedCommand({ nexus, manager, holds, message }),
          hasLanded: () => false
        })
        if (result.status === 'blocked' || result.status === 'failed') {
          const backoff = threadOutboxRetryDelayMs(
            result.status === 'blocked' ? result.message.attempts : 1
          )
          // Mesmo piso do hook do outbox: entrega ambígua espera antes do reenvio.
          const delay =
            result.status === 'blocked' && result.outcome === 'unknown'
              ? Math.max(backoff, UNKNOWN_DELIVERY_MIN_RETRY_MS)
              : backoff
          retryInMs = retryInMs === null ? delay : Math.min(retryInMs, delay)
        }
      }
      if (alive && retryInMs !== null) {
        timer = setTimeout(() => setRetryTick((tick) => tick + 1), retryInMs)
      }
    })()
    return () => {
      alive = false
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [activePaneId, holds, holdsVersion, hostHoldKey, hostId, loaded, manager, nexus, retryTick, scopesKey, state])

  return scopes.length
}
