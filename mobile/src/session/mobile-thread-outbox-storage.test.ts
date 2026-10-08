import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => new Map<string, string>())

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: vi.fn(async () => [...disk.keys()]),
    multiGet: vi.fn(async (keys: readonly string[]) =>
      keys.map((key) => [key, disk.get(key) ?? null] as const)
    ),
    setItem: vi.fn(async (key: string, value: string) => {
      disk.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      disk.delete(key)
    })
  }
}))

import { createMobileThreadOutboxManager } from './mobile-thread-outbox'
import { asyncStorageThreadOutboxStorage } from './mobile-thread-outbox-storage'

const queued = {
  messageId: 'b7c1e0de-0000-4000-8000-000000000001',
  scopeKey: 'host-1\0wt-1\0tab-1',
  text: 'rode os testes',
  createdAt: '2026-10-07T10:00:00.000Z',
  baselineTailMessageId: null,
  attempts: 0
}

describe('asyncStorageThreadOutboxStorage', () => {
  beforeEach(() => {
    disk.clear()
    disk.set('orca:pins:host-1', '[]')
  })

  it('persists one key per message and survives a fresh manager (restart)', async () => {
    const before = createMobileThreadOutboxManager({ storage: asyncStorageThreadOutboxStorage })
    // enqueue resolves only after the durable write landed.
    await before.enqueue(queued)
    expect([...disk.keys()]).toContain(`nexus:thread-outbox:v1:${queued.messageId}`)

    const after = createMobileThreadOutboxManager({ storage: asyncStorageThreadOutboxStorage })
    expect(await after.load()).toBe(true)
    expect(after.queued(queued.scopeKey)).toEqual([queued])

    await after.remove(queued)
    expect([...disk.keys()]).toEqual(['orca:pins:host-1'])
  })

  it('loads the readable messages and reports a corrupted one instead of dropping all', async () => {
    await asyncStorageThreadOutboxStorage.write(queued)
    disk.set('nexus:thread-outbox:v1:broken', '{not json')

    const result = await asyncStorageThreadOutboxStorage.load()

    expect(result.messages).toEqual([queued])
    expect(result.errors).toHaveLength(1)
    expect(String(result.errors[0])).toContain('read-message')
  })
})
