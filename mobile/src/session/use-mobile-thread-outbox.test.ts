import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'unused' }))

import {
  createMobileThreadOutboxManager,
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type MobileQueuedThreadMessage,
  type MobileThreadOutboxDeliveryOutcome,
  type MobileThreadOutboxStorage
} from './mobile-thread-outbox'
import { useMobileThreadOutbox, type MobileThreadOutbox } from './use-mobile-thread-outbox'

const SCOPE = 'host-1\0wt-1\0tab-1'

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

type HookArgs = Parameters<typeof useMobileThreadOutbox>[0]

describe('useMobileThreadOutbox', () => {
  let renderer: ReactTestRenderer | null = null
  let outbox: MobileThreadOutbox | null = null
  let ids = 0

  function Harness({ args }: { args: HookArgs }): null {
    outbox = useMobileThreadOutbox(args)
    return null
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    outbox = null
    vi.useRealTimers()
  })

  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 200; i++) await Promise.resolve()
    })
  }

  function setup(storage = memoryStorage()) {
    ids = 0
    const manager = createMobileThreadOutboxManager({ storage, warn: () => {} })
    const sent: MobileQueuedThreadMessage[] = []
    const outcomes: MobileThreadOutboxDeliveryOutcome[] = []
    const deliver = vi.fn(async (queued: MobileQueuedThreadMessage) => {
      sent.push(queued)
      return outcomes.shift() ?? 'accepted'
    })
    const args = (sendable: boolean): HookArgs => ({
      scopeKey: SCOPE,
      sendable,
      deliver,
      hasLanded: () => false,
      manager,
      newMessageId: () => `m-${++ids}`
    })
    const mount = async (sendable: boolean) => {
      await act(async () => {
        renderer = create(createElement(Harness, { args: args(sendable) }))
      })
      await settle()
    }
    const setSendable = async (sendable: boolean) => {
      await act(async () => {
        renderer!.update(createElement(Harness, { args: args(sendable) }))
      })
      await settle()
    }
    return { storage, manager, sent, outcomes, deliver, mount, setSendable }
  }

  it('drains what an earlier run left on disk as soon as it boots online', async () => {
    const storage = memoryStorage()
    await storage.write({
      messageId: 'm-left',
      scopeKey: SCOPE,
      text: 'deixada offline',
      createdAt: '2026-10-07T10:00:00.000Z',
      baselineTailMessageId: null,
      attempts: 0
    })
    const harness = setup(storage)

    await harness.mount(true)

    expect(harness.sent.map((sent) => sent.text)).toEqual(['deixada offline'])
    expect(outbox!.queued).toEqual([])
    expect(storage.disk.size).toBe(0)
  })

  it('holds offline sends and delivers them in order on reconnect', async () => {
    const harness = setup()
    await harness.mount(false)

    await act(async () => {
      await outbox!.enqueue('primeira', 'row-1')
      await outbox!.enqueue('segunda', 'row-1')
    })
    expect(outbox!.queued.map((queued) => queued.text)).toEqual(['primeira', 'segunda'])
    expect(harness.deliver).not.toHaveBeenCalled()

    await harness.setSendable(true)

    expect(harness.sent.map((sent) => [sent.messageId, sent.text])).toEqual([
      ['m-1', 'primeira'],
      ['m-2', 'segunda']
    ])
    expect(outbox!.queued).toEqual([])
  })

  it('keeps an edited message out of the drain until the edit is saved', async () => {
    const harness = setup()
    await harness.mount(false)
    await act(async () => {
      await outbox!.enqueue('tetso', null)
    })
    const messageId = outbox!.queued[0]!.messageId

    let text: string | null = null
    act(() => {
      text = outbox!.beginEdit(messageId)
    })
    expect(text).toBe('tetso')
    expect(outbox!.editingMessageId).toBe(messageId)

    await harness.setSendable(true)
    expect(harness.deliver).not.toHaveBeenCalled()

    await act(async () => {
      expect(await outbox!.saveEdit('texto  ')).toBe(true)
    })
    await settle()

    expect(outbox!.editingMessageId).toBeNull()
    expect(harness.sent.map((sent) => sent.text)).toEqual(['texto'])
  })

  it('cancels a queued message so it is never sent', async () => {
    const harness = setup()
    await harness.mount(false)
    await act(async () => {
      await outbox!.enqueue('desisti', null)
    })
    await act(async () => {
      await outbox!.cancel(outbox!.queued[0]!.messageId)
    })

    await harness.setSendable(true)
    expect(harness.deliver).not.toHaveBeenCalled()
    expect(harness.storage.disk.size).toBe(0)
  })

  it('retries a rejected delivery after the backoff instead of dropping it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = setup()
    harness.outcomes.push('rejected')
    await harness.mount(false)
    await act(async () => {
      await outbox!.enqueue('tenta de novo', null)
    })

    await harness.setSendable(true)
    expect(harness.deliver).toHaveBeenCalledTimes(1)
    expect(outbox!.queued).toHaveLength(1)

    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    await settle()

    expect(harness.deliver).toHaveBeenCalledTimes(2)
    expect(harness.sent.map((sent) => sent.messageId)).toEqual(['m-1', 'm-1'])
    expect(outbox!.queued).toEqual([])
  })
})
