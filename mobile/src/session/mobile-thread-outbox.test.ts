import { describe, expect, it, vi } from 'vitest'
import {
  appendPendingThreadMessages,
  createMobileThreadOutboxManager,
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  groupQueuedThreadMessages,
  threadOutboxRetryDelayMs,
  type MobileQueuedThreadMessage,
  type MobileThreadOutboxDeliveryOutcome,
  type MobileThreadOutboxStorage
} from './mobile-thread-outbox'

const SCOPE = 'host-1\0wt-1\0tab-1'

function message(id: string, text: string, createdAt: string): MobileQueuedThreadMessage {
  return {
    messageId: id,
    scopeKey: SCOPE,
    text,
    createdAt,
    baselineTailMessageId: 'row-0',
    attempts: 0
  }
}

/** A disk that survives "restarts": every manager built on it shares the map. */
function memoryStorage(): MobileThreadOutboxStorage & { disk: Map<string, string> } {
  const disk = new Map<string, string>()
  return {
    disk,
    load: async () => ({
      messages: [...disk.values()].map((raw) => decodeQueuedThreadMessage(JSON.parse(raw))),
      errors: []
    }),
    write: async (queued) => {
      disk.set(queued.messageId, encodeQueuedThreadMessage(queued))
    },
    remove: async (queued) => {
      disk.delete(queued.messageId)
    }
  }
}

/** Desktop stand-in: records every delivered messageId. */
function fakeDesktop(outcome: MobileThreadOutboxDeliveryOutcome = 'accepted') {
  const received: MobileQueuedThreadMessage[] = []
  return {
    received,
    deliver: vi.fn(async (queued: MobileQueuedThreadMessage) => {
      received.push(queued)
      return outcome
    })
  }
}

const quiet = { warn: () => {} }

describe('appendPendingThreadMessages', () => {
  it('keeps only the queued message the server has not echoed yet', () => {
    const queued = [
      message('m-1', 'primeira', '2026-10-07T10:00:00.000Z'),
      message('m-2', 'segunda', '2026-10-07T10:00:01.000Z')
    ]
    const presented = [{ id: 'pending-9', text: 'eco anterior' }]
    // m-1 already echoed (its pending echo carries the messageId), m-2 did not.
    const feed = [{ id: 'row-0' }, { id: 'm-1' }]

    const result = appendPendingThreadMessages(presented, feed, queued)

    expect(result).toEqual([
      { id: 'pending-9', text: 'eco anterior' },
      { id: 'm-2', text: 'segunda', baselineTailMessageId: 'row-0', queued: true }
    ])
  })

  it('returns the presented feed untouched when nothing is queued', () => {
    const presented = [{ id: 'pending-1' }]
    expect(appendPendingThreadMessages(presented, [], [])).toBe(presented)
  })
})

describe('outbox model', () => {
  it('round-trips through storage encoding and groups by scope, oldest first', () => {
    const late = message('m-2', 'b', '2026-10-07T10:00:02.000Z')
    const early = message('m-1', 'a', '2026-10-07T10:00:01.000Z')
    expect(decodeQueuedThreadMessage(JSON.parse(encodeQueuedThreadMessage(late)))).toEqual(late)
    expect(groupQueuedThreadMessages([late, early, { ...early, text: 'a2' }])[SCOPE]).toEqual([
      { ...early, text: 'a2' },
      late
    ])
  })

  it('rejects a stored record with a foreign shape', () => {
    expect(() => decodeQueuedThreadMessage({ schemaVersion: 1, messageId: '' })).toThrow()
  })

  it('backs off exponentially up to the cap', () => {
    expect([1, 2, 3, 5, 9].map(threadOutboxRetryDelayMs)).toEqual([1000, 2000, 4000, 16000, 16000])
  })
})

describe('createMobileThreadOutboxManager drain', () => {
  it('drains a restart without duplicating: each message reaches the desktop once', async () => {
    const storage = memoryStorage()
    const beforeRestart = createMobileThreadOutboxManager({ storage, ...quiet })
    await beforeRestart.enqueue(message('m-1', 'primeira', '2026-10-07T10:00:00.000Z'))
    await beforeRestart.enqueue(message('m-2', 'segunda', '2026-10-07T10:00:01.000Z'))

    // App killed offline; the next launch loads the disk and drains it.
    const desktop = fakeDesktop()
    const afterRestart = createMobileThreadOutboxManager({ storage, ...quiet })
    await afterRestart.load()
    // Boot and reconnect both fire: the second drain must not send again.
    const [boot, reconnect] = await Promise.all([
      afterRestart.drain(SCOPE, { deliver: desktop.deliver }),
      afterRestart.drain(SCOPE, { deliver: desktop.deliver })
    ])

    expect([boot.status, reconnect.status].sort()).toEqual(['busy', 'idle'])
    expect(desktop.received.map((sent) => [sent.messageId, sent.text])).toEqual([
      ['m-1', 'primeira'],
      ['m-2', 'segunda']
    ])
    expect(storage.disk.size).toBe(0)

    const thirdLaunch = createMobileThreadOutboxManager({ storage, ...quiet })
    await thirdLaunch.load()
    await thirdLaunch.drain(SCOPE, { deliver: desktop.deliver })
    expect(desktop.deliver).toHaveBeenCalledTimes(2)
  })

  it('a crash after the desktop got the message retires it on restart instead of resending', async () => {
    const storage = memoryStorage()
    const crashed = createMobileThreadOutboxManager({ storage, ...quiet })
    await crashed.enqueue(message('m-1', 'primeira', '2026-10-07T10:00:00.000Z'))
    await crashed.enqueue(message('m-2', 'segunda', '2026-10-07T10:00:01.000Z'))
    const desktopGot = new Set<string>()
    // The first send reaches the desktop, then the app dies before the ack.
    void crashed.drain(SCOPE, {
      deliver: (sent) => {
        desktopGot.add(sent.messageId)
        return new Promise<never>(() => {})
      }
    })
    await vi.waitFor(() => expect(desktopGot.has('m-1')).toBe(true))

    const restarted = createMobileThreadOutboxManager({ storage, ...quiet })
    await restarted.load()
    // The attempt was persisted before the send, so the restart knows m-1 may
    // already be with the agent; m-2 never left the phone.
    expect(restarted.queued(SCOPE).map((queued) => queued.attempts)).toEqual([1, 0])

    const desktop = fakeDesktop()
    await restarted.drain(SCOPE, {
      deliver: desktop.deliver,
      // The transcript shows m-1's echo.
      hasLanded: (queued) => desktopGot.has(queued.messageId)
    })

    expect(desktop.received.map((sent) => sent.messageId)).toEqual(['m-2'])
    expect(restarted.queued(SCOPE)).toEqual([])
  })

  it('resends an unconfirmed message with the SAME messageId so the desktop can drop it', async () => {
    const storage = memoryStorage()
    const manager = createMobileThreadOutboxManager({ storage, ...quiet })
    await manager.enqueue(message('m-1', 'primeira', '2026-10-07T10:00:00.000Z'))
    await manager.enqueue(message('m-2', 'segunda', '2026-10-07T10:00:01.000Z'))

    const lostAck = fakeDesktop('unknown')
    const first = await manager.drain(SCOPE, { deliver: lostAck.deliver })
    // Order is the contract: m-2 never overtakes the unconfirmed head.
    expect(first).toMatchObject({ status: 'blocked', outcome: 'unknown' })
    expect(lostAck.received.map((sent) => sent.messageId)).toEqual(['m-1'])

    const desktop = fakeDesktop()
    await manager.drain(SCOPE, { deliver: desktop.deliver, hasLanded: () => false })
    expect(desktop.received.map((sent) => [sent.messageId, sent.attempts])).toEqual([
      ['m-1', 2],
      ['m-2', 1]
    ])
  })

  it('never sends twice in one run when removing the delivered message fails', async () => {
    const storage = memoryStorage()
    const remove = vi.fn(storage.remove)
    remove.mockRejectedValueOnce(new Error('disk full'))
    const manager = createMobileThreadOutboxManager({ storage: { ...storage, remove }, ...quiet })
    await manager.enqueue(message('m-1', 'primeira', '2026-10-07T10:00:00.000Z'))

    const desktop = fakeDesktop()
    expect(await manager.drain(SCOPE, { deliver: desktop.deliver })).toMatchObject({
      status: 'failed'
    })
    expect(await manager.drain(SCOPE, { deliver: desktop.deliver })).toEqual({ status: 'idle' })
    expect(desktop.deliver).toHaveBeenCalledTimes(1)
    expect(storage.disk.size).toBe(0)
  })

  it('delivers the edited text when the message is edited before sending', async () => {
    const storage = memoryStorage()
    const manager = createMobileThreadOutboxManager({ storage, ...quiet })
    const original = message('m-1', 'tetso com erro', '2026-10-07T10:00:00.000Z')
    await manager.enqueue(original)
    const revision = manager.revisionOf('m-1')

    // While the editor holds it, a reconnect drain must not send the stale text.
    const desktop = fakeDesktop()
    expect(await manager.drain(SCOPE, { deliver: desktop.deliver, isHeld: () => true })).toEqual({
      status: 'held',
      messageId: 'm-1'
    })
    expect(await manager.update({ ...original, text: 'texto corrigido' }, revision)).toBe(true)
    // A writer that read the revision before the edit loses the compare-and-set.
    expect(await manager.update({ ...original, text: 'velho' }, revision)).toBe(false)

    await manager.drain(SCOPE, { deliver: desktop.deliver })
    expect(desktop.received.map((sent) => sent.text)).toEqual(['texto corrigido'])
  })

  it('cancels a queued message before it is sent, on disk too', async () => {
    const storage = memoryStorage()
    const manager = createMobileThreadOutboxManager({ storage, ...quiet })
    const queued = message('m-1', 'desisti', '2026-10-07T10:00:00.000Z')
    await manager.enqueue(queued)

    expect(await manager.remove(queued, manager.revisionOf('m-1'))).toEqual(queued)

    const desktop = fakeDesktop()
    await manager.drain(SCOPE, { deliver: desktop.deliver })
    expect(desktop.deliver).not.toHaveBeenCalled()
    expect(storage.disk.size).toBe(0)
  })

  it('refuses edits while the message is being sent', async () => {
    const storage = memoryStorage()
    const manager = createMobileThreadOutboxManager({ storage, ...quiet })
    await manager.enqueue(message('m-1', 'primeira', '2026-10-07T10:00:00.000Z'))
    let release!: (outcome: MobileThreadOutboxDeliveryOutcome) => void
    const draining = manager.drain(SCOPE, {
      deliver: () =>
        new Promise((resolve) => {
          release = resolve
        })
    })
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(manager.isDispatching('m-1')).toBe(true)
    release('accepted')
    await draining
    expect(manager.isDispatching('m-1')).toBe(false)
  })

  it('rolls an enqueue back out when its durable write fails', async () => {
    const storage = memoryStorage()
    const manager = createMobileThreadOutboxManager({
      storage: { ...storage, write: vi.fn().mockRejectedValue(new Error('quota')) },
      ...quiet
    })
    await expect(
      manager.enqueue(message('m-1', 'primeira', '2026-10-07T10:00:00.000Z'))
    ).rejects.toThrow('enqueue')
    expect(manager.queued(SCOPE)).toEqual([])
  })
})
