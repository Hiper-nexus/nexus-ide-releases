// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: use-thread-outbox + use-thread-outbox-drain reduzidos a um hook React (sem Effect/Atom): carrega o outbox no boot, drena o escopo ativo quando a entrega fica possível (reconexão) com backoff, e segura a mensagem em edição (hold/release) como editingQueuedMessageIdsAtom.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { randomUUID } from 'expo-crypto'
import {
  createMobileThreadOutboxManager,
  threadOutboxRetryDelayMs,
  type MobileQueuedThreadMessage,
  type MobileThreadOutboxDeliveryOutcome,
  type MobileThreadOutboxManager
} from './mobile-thread-outbox'
import { asyncStorageThreadOutboxStorage } from './mobile-thread-outbox-storage'

/** One outbox for the app: like the queue on disk, it outlives any screen. */
export const mobileThreadOutbox = createMobileThreadOutboxManager({
  storage: asyncStorageThreadOutboxStorage
})

const NO_MESSAGES: readonly MobileQueuedThreadMessage[] = []
// An ambiguous send gets the transcript time to echo before any resend, so a
// host that cannot deduplicate is not handed the same prompt twice.
const UNKNOWN_DELIVERY_MIN_RETRY_MS = 20_000

let lastCreatedAtMs = 0
// Strictly increasing, so two sends in the same millisecond keep their order
// after a reload sorts by createdAt.
function nextCreatedAt(): string {
  lastCreatedAtMs = Math.max(Date.now(), lastCreatedAtMs + 1)
  return new Date(lastCreatedAtMs).toISOString()
}

export type MobileThreadOutbox = {
  /** Queued messages of the active scope, oldest first. */
  queued: readonly MobileQueuedThreadMessage[]
  editingMessageId: string | null
  /** Durably queue a chat message; false when the write failed (nothing queued). */
  enqueue: (text: string, baselineTailMessageId: string | null) => Promise<boolean>
  /** Hold a queued message for editing and return its text, or null when it is
   *  already being sent (or gone). */
  beginEdit: (messageId: string) => string | null
  /** Replace the held message's text (empty text cancels it) and release it. */
  saveEdit: (text: string) => Promise<boolean>
  cancelEdit: () => void
  cancel: (messageId: string) => Promise<void>
}

export function useMobileThreadOutbox(args: {
  scopeKey: string | null
  /** Delivery is possible now (connected, input lease held, transcript settled).
   *  Its false→true edge is the reconnect drain. */
  sendable: boolean
  deliver: (message: MobileQueuedThreadMessage) => Promise<MobileThreadOutboxDeliveryOutcome>
  /** Whether an earlier attempt of this message already reached the transcript. */
  hasLanded: (message: MobileQueuedThreadMessage) => boolean
  onDelivered?: (message: MobileQueuedThreadMessage) => void
  manager?: MobileThreadOutboxManager
  newMessageId?: () => string
}): MobileThreadOutbox {
  const { scopeKey, sendable } = args
  const manager = args.manager ?? mobileThreadOutbox
  const newMessageId = args.newMessageId ?? randomUUID
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  const queued = scopeKey ? (snapshot[scopeKey] ?? NO_MESSAGES) : NO_MESSAGES
  const [editing, setEditing] = useState<{ messageId: string; revision: number } | null>(null)
  // Read by the drain synchronously: a hold must win even against a drain that
  // starts in the same tick as the tap.
  const editingRef = useRef(editing)
  const handlersRef = useRef(args)
  handlersRef.current = args
  const [loaded, setLoaded] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const setHeld = useCallback((next: { messageId: string; revision: number } | null) => {
    editingRef.current = next
    setEditing(next)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    // Boot: pick up whatever an earlier run left on disk. A partial load still
    // publishes the readable messages, so drain either way.
    void manager.load().then(() => {
      if (mountedRef.current) setLoaded(true)
    })
    return () => {
      mountedRef.current = false
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }
  }, [manager])

  // Which messages wait, not their attempt counters: the drain's own attempt
  // write must not re-trigger it and skip the backoff after a failed send.
  const queuedIdsKey = queued.map((message) => message.messageId).join('\n')
  useEffect(() => {
    if (!loaded || !sendable || !scopeKey || queuedIdsKey === '') {
      return
    }
    void manager
      .drain(scopeKey, {
        deliver: (message) => handlersRef.current.deliver(message),
        hasLanded: (message) => handlersRef.current.hasLanded(message),
        isHeld: (messageId) => editingRef.current?.messageId === messageId,
        onDelivered: (message) => handlersRef.current.onDelivered?.(message)
      })
      .then((result) => {
        if (
          !mountedRef.current ||
          retryTimerRef.current !== null ||
          (result.status !== 'blocked' && result.status !== 'failed')
        ) {
          return
        }
        const backoff = threadOutboxRetryDelayMs(
          result.status === 'blocked' ? result.message.attempts : 1
        )
        const delay =
          result.status === 'blocked' && result.outcome === 'unknown'
            ? Math.max(backoff, UNKNOWN_DELIVERY_MIN_RETRY_MS)
            : backoff
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null
          setRetryTick((tick) => tick + 1)
        }, delay)
      })
  }, [loaded, sendable, scopeKey, queuedIdsKey, editing, retryTick, manager])

  const enqueue = useCallback(
    async (text: string, baselineTailMessageId: string | null): Promise<boolean> => {
      if (!scopeKey) {
        return false
      }
      try {
        await manager.enqueue({
          messageId: newMessageId(),
          scopeKey,
          text,
          createdAt: nextCreatedAt(),
          baselineTailMessageId,
          attempts: 0
        })
        return true
      } catch {
        return false
      }
    },
    [manager, newMessageId, scopeKey]
  )

  const findQueued = useCallback(
    (messageId: string) =>
      scopeKey
        ? manager.queued(scopeKey).find((message) => message.messageId === messageId)
        : undefined,
    [manager, scopeKey]
  )

  const beginEdit = useCallback(
    (messageId: string): string | null => {
      const message = findQueued(messageId)
      if (!message || manager.isDispatching(messageId)) {
        return null
      }
      setHeld({ messageId, revision: manager.revisionOf(messageId) })
      return message.text
    },
    [findQueued, manager, setHeld]
  )

  const saveEdit = useCallback(
    async (text: string): Promise<boolean> => {
      const held = editingRef.current
      if (!held) {
        return false
      }
      const message = findQueued(held.messageId)
      try {
        if (!message) {
          return false
        }
        const nextText = text.trimEnd()
        if (nextText.trim() === '') {
          return (await manager.remove(message, held.revision)) !== null
        }
        return await manager.update({ ...message, text: nextText }, held.revision)
      } catch {
        return false
      } finally {
        // Released only after the write: a drain woken by the release must see
        // the edited payload, never the stale one.
        setHeld(null)
      }
    },
    [findQueued, manager, setHeld]
  )

  const cancelEdit = useCallback(() => setHeld(null), [setHeld])

  const cancel = useCallback(
    async (messageId: string): Promise<void> => {
      const message = findQueued(messageId)
      if (!message || manager.isDispatching(messageId)) {
        return
      }
      if (editingRef.current?.messageId === messageId) {
        setHeld(null)
      }
      try {
        await manager.remove(message, manager.revisionOf(messageId))
      } catch {
        // The message stays queued and visible; the user can cancel again.
      }
    },
    [findQueued, manager, setHeld]
  )

  return {
    queued,
    editingMessageId: editing?.messageId ?? null,
    enqueue,
    beginEdit,
    saveEdit,
    cancelEdit,
    cancel
  }
}
