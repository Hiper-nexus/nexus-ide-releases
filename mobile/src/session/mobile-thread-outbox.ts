// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: junta thread-outbox-model, thread-outbox-manager e pending-thread-feed sem Effect/Atom (store com subscribe simples e zod), escopo host/worktree/aba no lugar de environment/thread, sem anexos nem criação de thread; drenagem sequencial por escopo com marca de tentativa durável antes do envio, guarda de eco no transcript e messageId como chave de idempotência.

import { z } from 'zod'

const THREAD_OUTBOX_SCHEMA_VERSION = 1
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000

/** A chat message the phone accepted while it could not reach the desktop. */
export type MobileQueuedThreadMessage = {
  /** Client-generated id; the desktop deduplicates a replayed send by it. */
  readonly messageId: string
  /** `host\0worktree\0tab` — the composer surface the message was written in. */
  readonly scopeKey: string
  readonly text: string
  readonly createdAt: string
  /** Transcript tail when queued: anchors the bubble and bounds the echo check. */
  readonly baselineTailMessageId: string | null
  /** Delivery attempts started. Persisted before each send, so a restart knows an
   *  earlier attempt may already have reached the desktop. */
  readonly attempts: number
}

const QueuedThreadMessageSchema = z.object({
  schemaVersion: z.literal(THREAD_OUTBOX_SCHEMA_VERSION),
  messageId: z.string().min(1).max(128),
  scopeKey: z.string().min(1),
  text: z.string(),
  createdAt: z.string().min(1),
  baselineTailMessageId: z.string().nullable(),
  attempts: z.number().int().nonnegative()
})

export function encodeQueuedThreadMessage(message: MobileQueuedThreadMessage): string {
  return JSON.stringify({ schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION, ...message })
}

export function decodeQueuedThreadMessage(value: unknown): MobileQueuedThreadMessage {
  const { schemaVersion: _, ...message } = QueuedThreadMessageSchema.parse(value)
  return message
}

export function groupQueuedThreadMessages(
  messages: readonly MobileQueuedThreadMessage[]
): Record<string, readonly MobileQueuedThreadMessage[]> {
  const deduplicated = new Map<string, MobileQueuedThreadMessage>()
  for (const message of messages) {
    deduplicated.set(message.messageId, message)
  }

  const grouped: Record<string, MobileQueuedThreadMessage[]> = {}
  for (const message of deduplicated.values()) {
    ;(grouped[message.scopeKey] ??= []).push(message)
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }
  return grouped
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS)
}

/** A queued message rendered as a pending user bubble. */
export type MobileQueuedFeedItem = {
  readonly id: string
  readonly text: string
  readonly baselineTailMessageId: string | null
  readonly queued: true
}

/** Append the outbox after all presented echoes, until the server echoes each message. */
export function appendPendingThreadMessages<T extends { readonly id: string }>(
  presentedFeed: readonly T[],
  feed: readonly { readonly id: string }[],
  queuedMessages: readonly MobileQueuedThreadMessage[]
): readonly (T | MobileQueuedFeedItem)[] {
  if (queuedMessages.length === 0) return presentedFeed
  const deliveredIds = new Set(feed.map((entry) => entry.id))
  return [
    ...presentedFeed,
    ...queuedMessages
      .filter((message) => !deliveredIds.has(message.messageId))
      .map((message): MobileQueuedFeedItem => ({
        id: message.messageId,
        text: message.text,
        baselineTailMessageId: message.baselineTailMessageId,
        queued: true
      }))
  ]
}

export type MobileThreadOutboxLoadResult = {
  readonly messages: readonly MobileQueuedThreadMessage[]
  readonly errors: readonly unknown[]
}

export type MobileThreadOutboxStorage = {
  readonly load: () => Promise<MobileThreadOutboxLoadResult>
  readonly write: (message: MobileQueuedThreadMessage) => Promise<void>
  readonly remove: (message: MobileQueuedThreadMessage) => Promise<void>
}

export class MobileThreadOutboxError extends Error {
  constructor(
    readonly operation: 'load' | 'enqueue' | 'update' | 'remove',
    readonly messageId: string | null,
    readonly reason: unknown
  ) {
    super(`Thread outbox operation ${operation} failed for message ${messageId ?? 'unknown'}.`)
    this.name = 'MobileThreadOutboxError'
  }
}

export type MobileThreadOutboxDeliveryOutcome = 'accepted' | 'rejected' | 'unknown'

export type MobileThreadOutboxDrainHandlers = {
  /** Sends one message. Must carry `messageId` so the desktop can drop a replay. */
  readonly deliver: (
    message: MobileQueuedThreadMessage
  ) => Promise<MobileThreadOutboxDeliveryOutcome>
  /** Whether an earlier attempt already reached the transcript (restart, lost ack). */
  readonly hasLanded?: (message: MobileQueuedThreadMessage) => boolean
  /** Messages open in the editor are never delivered with their stale text. */
  readonly isHeld?: (messageId: string) => boolean
  /** Runs before the message leaves the outbox, so its echo takes over the bubble. */
  readonly onDelivered?: (message: MobileQueuedThreadMessage) => void
}

export type MobileThreadOutboxDrainResult =
  | { readonly status: 'idle' }
  | { readonly status: 'busy' }
  | { readonly status: 'held'; readonly messageId: string }
  | {
      readonly status: 'blocked'
      readonly message: MobileQueuedThreadMessage
      readonly outcome: 'rejected' | 'unknown'
    }
  | { readonly status: 'failed'; readonly error: unknown }

export type MobileThreadOutboxManager = ReturnType<typeof createMobileThreadOutboxManager>

const NO_MESSAGES: readonly MobileQueuedThreadMessage[] = []

export function createMobileThreadOutboxManager(options: {
  readonly storage: MobileThreadOutboxStorage
  readonly warn?: (message: string, error: unknown) => void
}) {
  let queuedByScope: Record<string, readonly MobileQueuedThreadMessage[]> = {}
  const listeners = new Set<() => void>()
  const warn =
    options.warn ??
    ((message: string, error: unknown) => {
      console.warn(message, error)
    })
  let loadPromise: Promise<boolean> | null = null
  let mutationQueue: Promise<void> = Promise.resolve()
  // Monotonic per-message write counter. Every accepted write (enqueue publish
  // or update) bumps it, so a writer that captured a revision before slow work
  // is rejected before its stale payload reaches disk.
  const revisions = new Map<string, number>()
  const bumpRevision = (messageId: string): void => {
    revisions.set(messageId, (revisions.get(messageId) ?? 0) + 1)
  }
  const drainingScopes = new Set<string>()
  const dispatching = new Set<string>()
  // Accepted by the desktop in this run. A failed removal must never turn into
  // a second send; the next drain only retries the removal.
  const delivered = new Set<string>()

  const serialize = <A>(mutation: () => Promise<A>): Promise<A> => {
    const result = mutationQueue.then(mutation, mutation)
    mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const currentMessages = (): readonly MobileQueuedThreadMessage[] =>
    Object.values(queuedByScope).flat()

  const setMessages = (messages: readonly MobileQueuedThreadMessage[]): void => {
    queuedByScope = groupQueuedThreadMessages(messages)
    for (const listener of listeners) listener()
  }

  // Readable messages can be used after a partial load. Only a complete load
  // returns true. A later call retries failed reads without replacing live
  // message objects.
  const load = (): Promise<boolean> => {
    if (loadPromise !== null) {
      return loadPromise
    }
    loadPromise = serialize(async () => {
      const result = await options.storage.load()
      const current = currentMessages()
      const currentIds = new Set(current.map((message) => message.messageId))
      const recovered = result.messages.filter(
        (message) => !currentIds.has(message.messageId) && !revisions.has(message.messageId)
      )
      // Accepted edits and removals win over a later disk read.
      if (recovered.length > 0) setMessages([...recovered, ...current])
      if (result.errors.length > 0) {
        throw new AggregateError(result.errors, 'Some queued messages could not be read.')
      }
      return true
    }).catch((cause) => {
      loadPromise = null
      warn(
        '[thread-outbox] failed to load persisted messages',
        new MobileThreadOutboxError('load', null, cause)
      )
      return false
    })
    return loadPromise
  }

  // The queue drives the composer's immediate "queued" feedback, so it is
  // published synchronously; the durable write happens behind it and rolls the
  // message back out if it fails.
  const enqueue = (message: MobileQueuedThreadMessage): Promise<void> => {
    bumpRevision(message.messageId)
    setMessages([
      ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      message
    ])
    return serialize(async () => {
      try {
        await options.storage.write(message)
      } catch (cause) {
        // Roll back by reference, not messageId: a retry enqueue with the same
        // id may have optimistically replaced this attempt while the write was
        // in flight, and its entry must survive this attempt's failure.
        setMessages(currentMessages().filter((candidate) => candidate !== message))
        if (!currentMessages().some((candidate) => candidate.messageId === message.messageId)) {
          try {
            await options.storage.remove(message)
          } catch {
            // Best effort: the next load reconciles the queue against storage.
          }
        }
        throw new MobileThreadOutboxError('enqueue', message.messageId, cause)
      }
    })
  }

  // Resolves once all pending mutations (including any in-flight enqueue
  // write) have settled, reporting whether the message is still queued. The
  // drain awaits this so a message whose durable write later fails can never
  // have been delivered first.
  const confirmQueued = (message: MobileQueuedThreadMessage): Promise<boolean> =>
    serialize(async () => currentMessages().some((candidate) => candidate === message))

  // Rewrites an already-queued message; a no-op when it was removed in the
  // meantime, so a trailing editor flush can never resurrect it.
  // `expectedRevision` makes the update a compare-and-set.
  const update = (
    message: MobileQueuedThreadMessage,
    expectedRevision?: number
  ): Promise<boolean> =>
    serialize(async () => {
      const staleOrMissing = (): boolean =>
        !currentMessages().some((candidate) => candidate.messageId === message.messageId) ||
        (expectedRevision !== undefined &&
          (revisions.get(message.messageId) ?? 0) !== expectedRevision)
      if (staleOrMissing()) {
        return false
      }
      try {
        await options.storage.write(message)
      } catch (cause) {
        throw new MobileThreadOutboxError('update', message.messageId, cause)
      }
      if (staleOrMissing()) {
        const winner = currentMessages().find(
          (candidate) => candidate.messageId === message.messageId
        )
        if (winner !== undefined) {
          try {
            await options.storage.write(winner)
          } catch {
            // The winner's own serialized write owns its failure handling.
          }
        }
        return false
      }
      bumpRevision(message.messageId)
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
        message
      ])
      return true
    })

  // `expectedRevision` makes the removal a compare-and-set too: an edit
  // accepted after the caller decided to remove keeps the newer message queued.
  const remove = (
    message: MobileQueuedThreadMessage,
    expectedRevision?: number
  ): Promise<MobileQueuedThreadMessage | null> =>
    serialize(async () => {
      const removalCanceled = (): boolean =>
        expectedRevision !== undefined &&
        (revisions.get(message.messageId) ?? 0) !== expectedRevision
      if (removalCanceled()) {
        return null
      }
      const removed =
        currentMessages().find((candidate) => candidate.messageId === message.messageId) ?? message
      try {
        await options.storage.remove(message)
      } catch (cause) {
        throw new MobileThreadOutboxError('remove', message.messageId, cause)
      }
      if (removalCanceled()) {
        const winner = currentMessages().find(
          (candidate) => candidate.messageId === message.messageId
        )
        if (winner !== undefined) {
          try {
            await options.storage.write(winner)
          } catch (cause) {
            throw new MobileThreadOutboxError('remove', message.messageId, cause)
          }
        }
        return null
      }
      setMessages(
        currentMessages().filter((candidate) => candidate.messageId !== message.messageId)
      )
      // Tombstone, not delete: a same-id retry restarting at revision 1 would
      // otherwise match a stale writer's expectedRevision from before (ABA).
      bumpRevision(message.messageId)
      return removed
    })

  const revisionOf = (messageId: string): number => revisions.get(messageId) ?? 0

  // Sequential per scope, oldest first: a later message never overtakes the
  // head, and only one drain owns a scope at a time (boot and reconnect can
  // both fire; the second one sees `busy` instead of sending twice).
  const drain = async (
    scopeKey: string,
    handlers: MobileThreadOutboxDrainHandlers
  ): Promise<MobileThreadOutboxDrainResult> => {
    if (drainingScopes.has(scopeKey)) {
      return { status: 'busy' }
    }
    drainingScopes.add(scopeKey)
    try {
      for (;;) {
        const head = queuedByScope[scopeKey]?.[0]
        if (!head) {
          return { status: 'idle' }
        }
        if (handlers.isHeld?.(head.messageId)) {
          return { status: 'held', messageId: head.messageId }
        }
        // From here on the editor refuses this message (see isDispatching).
        dispatching.add(head.messageId)
        try {
          if (!(await confirmQueued(head))) {
            continue
          }
          if (
            delivered.has(head.messageId) ||
            (head.attempts > 0 && handlers.hasLanded?.(head) === true)
          ) {
            // Already with the agent: retire it, never send it again.
            await remove(head)
            continue
          }
          const attempt: MobileQueuedThreadMessage = { ...head, attempts: head.attempts + 1 }
          // Persist the attempt BEFORE sending: after a crash mid-send the
          // restart must know the desktop may already hold this messageId.
          if (!(await update(attempt, revisionOf(head.messageId)))) {
            continue
          }
          const outcome = await handlers.deliver(attempt)
          if (outcome !== 'accepted') {
            return { status: 'blocked', message: attempt, outcome }
          }
          delivered.add(attempt.messageId)
          handlers.onDelivered?.(attempt)
          await remove(attempt)
        } finally {
          dispatching.delete(head.messageId)
        }
      }
    } catch (error) {
      warn('[thread-outbox] drain stopped', error)
      return { status: 'failed', error }
    } finally {
      drainingScopes.delete(scopeKey)
    }
  }

  return {
    load,
    enqueue,
    confirmQueued,
    update,
    remove,
    revisionOf,
    drain,
    /** True while a send for this message is in flight; edits are refused then. */
    isDispatching: (messageId: string): boolean => dispatching.has(messageId),
    queued: (scopeKey: string): readonly MobileQueuedThreadMessage[] =>
      queuedByScope[scopeKey] ?? NO_MESSAGES,
    getSnapshot: (): Record<string, readonly MobileQueuedThreadMessage[]> => queuedByScope,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
