import { describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value)
    }
  }
}))

import {
  loadStoredHostProfiles,
  toStoredHostProfile,
  writeStoredHostProfiles
} from './host-metadata-store'

describe('host metadata kind (F-994)', () => {
  it('keeps a Nexus bridge host a Nexus host across restarts; Orca rows stay unmarked', async () => {
    const base = { name: 'h', deviceToken: 'secret', lastConnected: 1 }
    await writeStoredHostProfiles([
      toStoredHostProfile({
        ...base,
        id: 'nexus-1',
        endpoint: 'wss://mac.tail.ts.net',
        publicKeyB64: 'nexus-bridge:https://mac.tail.ts.net',
        kind: 'nexus-bridge'
      }),
      toStoredHostProfile({ ...base, id: 'orca-1', endpoint: 'ws://10.0.0.2:6768', publicKeyB64: 'pk' })
    ])
    const stored = await loadStoredHostProfiles()
    expect(stored?.map((host) => [host.id, host.kind])).toEqual([
      ['nexus-1', 'nexus-bridge'],
      ['orca-1', undefined]
    ])
    // O token continua fora do AsyncStorage (vai para o Keychain).
    expect([...storage.values()].join('')).not.toContain('secret')
  })
})
