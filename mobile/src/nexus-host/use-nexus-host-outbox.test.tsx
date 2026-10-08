import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'unused' }))

import {
  createMobileThreadOutboxManager,
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type MobileThreadOutboxManager,
  type MobileThreadOutboxStorage
} from '../session/mobile-thread-outbox'
import {
  NexusBridgeDeliveryUnknownError,
  NexusBridgeRemoteError
} from '../transport/nexus-bridge-client'
import { NEXUS_RAW_KEYS_MESSAGE, type NexusHostApi } from '../transport/nexus-bridge-rpc-adapter'
import type { ConnectionState } from '../transport/types'
import {
  NEXUS_OUTBOX_AUTO_FLUSH_MAX_AGE_MS,
  createNexusOutboxHoldStore,
  nexusOutboxScopeKey,
  parseNexusOutboxScopeKey,
  useNexusHostOutboxFlush,
  useNexusPaneOutbox,
  type NexusOutboxHoldStore,
  type NexusPaneOutbox
} from './use-nexus-host-outbox'

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

function memoryKv() {
  const kv = new Map<string, string>()
  return {
    kv,
    getItem: async (key: string) => kv.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      kv.set(key, value)
    },
    removeItem: async (key: string) => {
      kv.delete(key)
    }
  }
}

/**
 * Desktop falso com o mesmo contrato do pane.input real: um messageId já entregue
 * devolve ok sem escrever de novo no PTY (remote-input-dedup.ts).
 */
function fakeDesktop() {
  const pty: string[] = []
  const calls: { paneId: string; text: string; messageId?: string }[] = []
  const delivered = new Set<string>()
  let plan: ('ok' | 'lost-ack' | 'refuse')[] = []
  const nexus = {
    sendLine: vi.fn(async (paneId: string, text: string, messageId?: string) => {
      calls.push({ paneId, text, messageId })
      const step = plan.shift() ?? 'ok'
      if (step === 'refuse') {
        throw new NexusBridgeRemoteError('not authorized: desktop confirmation required or denied')
      }
      const key = `${paneId}\0${messageId ?? Math.random()}`
      if (!delivered.has(key)) {
        delivered.add(key)
        pty.push(`${paneId}:${text}`)
      }
      if (step === 'lost-ack') {
        throw new NexusBridgeDeliveryUnknownError('o desktop não respondeu a tempo')
      }
    })
  } as unknown as NexusHostApi
  return {
    nexus,
    pty,
    calls,
    setPlan: (next: typeof plan) => {
      plan = [...next]
    }
  }
}

type PaneArgs = Parameters<typeof useNexusPaneOutbox>[0]

let renderer: ReactTestRenderer | null = null
let outbox: NexusPaneOutbox | null = null

function PaneHarness({ args }: { args: PaneArgs }): null {
  outbox = useNexusPaneOutbox(args)
  return null
}

function HostHarness({ args }: { args: Parameters<typeof useNexusHostOutboxFlush>[0] }): null {
  useNexusHostOutboxFlush(args)
  return null
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 300; i++) await Promise.resolve()
  })
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  outbox = null
})

function setup(options: {
  storage?: ReturnType<typeof memoryStorage>
  kv?: ReturnType<typeof memoryKv>
  paneId?: string
} = {}) {
  const storage = options.storage ?? memoryStorage()
  const kv = options.kv ?? memoryKv()
  const manager: MobileThreadOutboxManager = createMobileThreadOutboxManager({
    storage,
    warn: () => {}
  })
  const holds: NexusOutboxHoldStore = createNexusOutboxHoldStore(kv)
  // Relógio do teste: parte do agora real (o createdAt da fila usa Date.now()).
  const clock = { now: Date.now() }
  const confirmations = new Map<string, number>()
  const desktop = fakeDesktop()
  let ids = 0
  const args = (state: ConnectionState): PaneArgs => ({
    hostId: 'host-a',
    paneId: options.paneId ?? 'p1',
    nexus: desktop.nexus,
    state,
    manager,
    holds,
    confirmations,
    now: () => clock.now,
    newMessageId: () => (options.paneId && options.paneId !== 'p1' ? `${options.paneId}-cmd-${++ids}` : `cmd-${++ids}`)
  })
  const mount = async (state: ConnectionState) => {
    await act(async () => {
      renderer = create(createElement(PaneHarness, { args: args(state) }))
    })
    await settle()
  }
  const setState = async (state: ConnectionState) => {
    await act(async () => {
      renderer!.update(createElement(PaneHarness, { args: args(state) }))
    })
    await settle()
  }
  const submit = async (text: string) => {
    let refusal: string | null = null
    await act(async () => {
      refusal = await outbox!.submit(text)
    })
    await settle()
    return refusal
  }
  const advance = (ms: number) => {
    clock.now += ms
  }
  return { storage, kv, manager, holds, desktop, mount, setState, submit, advance, clock }
}

describe('fila offline do host Nexus', () => {
  it('guarda os comandos enquanto reconecta e entrega em ordem depois da reautenticação', async () => {
    const t = setup()
    await t.mount('reconnecting')
    await t.submit('git status')
    await t.submit('npm test')
    await t.submit('git log -1')

    expect(t.desktop.calls).toEqual([])
    expect(outbox!.queued.map((item) => [item.text, item.status])).toEqual([
      ['git status', 'pending'],
      ['npm test', 'pending'],
      ['git log -1', 'pending']
    ])

    await t.setState('connected')

    expect(t.desktop.calls).toEqual([
      { paneId: 'p1', text: 'git status', messageId: 'cmd-1' },
      { paneId: 'p1', text: 'npm test', messageId: 'cmd-2' },
      { paneId: 'p1', text: 'git log -1', messageId: 'cmd-3' }
    ])
    expect(t.desktop.pty).toEqual(['p1:git status', 'p1:npm test', 'p1:git log -1'])
    expect(outbox!.queued).toEqual([])
    expect(outbox!.lastSent?.text).toBe('git log -1')
    expect(t.storage.disk.size).toBe(0)
  })

  it('reenvio depois de ack perdido leva o MESMO messageId e o desktop não digita duas vezes', async () => {
    const t = setup()
    await t.mount('connected')
    t.desktop.setPlan(['lost-ack', 'ok'])
    await t.submit('git status')

    // A primeira tentativa chegou ao PTY, mas o ack se perdeu: continua na fila.
    expect(t.desktop.calls).toHaveLength(1)
    expect(outbox!.queued.map((item) => item.attempts)).toEqual([1])

    await t.setState('reconnecting')
    await t.setState('connected')

    expect(t.desktop.calls.map((call) => call.messageId)).toEqual(['cmd-1', 'cmd-1'])
    expect(t.desktop.pty).toEqual(['p1:git status'])
    expect(outbox!.queued).toEqual([])
  })

  it('revogação não esvazia a fila: retém visivelmente, nem depois de parear de novo', async () => {
    const t = setup()
    await t.mount('reconnecting')
    await t.submit('git status')
    await t.submit('npm test')

    await t.setState('auth-failed')
    expect(outbox!.hold?.reason).toBe('revoked')
    expect(outbox!.queued.map((item) => item.status)).toEqual(['held', 'held'])

    // Pareou de novo: conectado, mas a fila retida não sai sozinha.
    await t.setState('connected')
    expect(t.desktop.calls).toEqual([])
    expect(t.desktop.pty).toEqual([])
    expect(outbox!.queued).toHaveLength(2)

    // Novo comando também espera atrás da retenção.
    await t.submit('git log -1')
    expect(t.desktop.calls).toEqual([])

    await act(async () => {
      await outbox!.resume()
    })
    await settle()
    expect(t.desktop.pty).toEqual(['p1:git status', 'p1:npm test', 'p1:git log -1'])
  })

  it('a retenção por revogação sobrevive a reiniciar o app', async () => {
    const storage = memoryStorage()
    const kv = memoryKv()
    const first = setup({ storage, kv })
    await first.mount('reconnecting')
    await first.submit('git status')
    await first.setState('auth-failed')
    act(() => renderer?.unmount())
    renderer = null

    // Processo novo: outbox e retenção relidos do disco; já começa conectado.
    const second = setup({ storage, kv })
    await second.mount('connected')
    expect(second.desktop.calls).toEqual([])
    expect(outbox!.hold?.reason).toBe('revoked')
    expect(outbox!.queued.map((item) => item.text)).toEqual(['git status'])

    await act(async () => {
      await outbox!.discardAll()
    })
    await settle()
    expect(outbox!.queued).toEqual([])
    expect(outbox!.hold).toBeNull()
    expect(storage.disk.size).toBe(0)
    expect(second.desktop.calls).toEqual([])
  })

  it('recusa do desktop tira o comando da fila, mostra a falha e para os seguintes', async () => {
    const t = setup()
    await t.mount('reconnecting')
    await t.submit('rm -rf build')
    await t.submit('npm test')
    t.desktop.setPlan(['refuse'])

    await t.setState('connected')

    expect(t.desktop.calls.map((call) => call.text)).toEqual(['rm -rf build'])
    expect(outbox!.hold).toMatchObject({ reason: 'rejected', text: 'rm -rf build' })
    expect(outbox!.queued.map((item) => [item.text, item.status])).toEqual([['npm test', 'held']])

    await act(async () => {
      await outbox!.resume()
    })
    await settle()
    expect(t.desktop.pty).toEqual(['p1:npm test'])
  })

  it('tecla crua nunca entra na fila (F-1000)', async () => {
    const t = setup()
    await t.mount('reconnecting')
    expect(await t.submit('git status\u0003')).toBe(NEXUS_RAW_KEYS_MESSAGE)
    expect(await t.submit('\u001b[Z')).toBe(NEXUS_RAW_KEYS_MESSAGE)
    expect(outbox!.queued).toEqual([])
    expect(t.storage.disk.size).toBe(0)
  })

  it('persiste por host+pane: cada pane drena só a própria fila', async () => {
    const storage = memoryStorage()
    const kv = memoryKv()
    const p1 = setup({ storage, kv, paneId: 'p1' })
    await p1.mount('disconnected')
    await p1.submit('git status')
    act(() => renderer?.unmount())
    const p2 = setup({ storage, kv, paneId: 'p2' })
    await p2.mount('disconnected')
    await p2.submit('npm test')
    act(() => renderer?.unmount())
    renderer = null

    const scopes = [...storage.disk.values()].map(
      (raw) => decodeQueuedThreadMessage(JSON.parse(raw)).scopeKey
    )
    expect(scopes.map(parseNexusOutboxScopeKey)).toEqual([
      { hostId: 'host-a', paneId: 'p1' },
      { hostId: 'host-a', paneId: 'p2' }
    ])
    expect(nexusOutboxScopeKey('host-a', 'p1')).not.toBe(nexusOutboxScopeKey('host-b', 'p1'))

    // Reinício abrindo só o pane p1.
    const reopened = setup({ storage, kv, paneId: 'p1' })
    await reopened.mount('connected')
    expect(reopened.desktop.pty).toEqual(['p1:git status'])
    expect(storage.disk.size).toBe(1)
  })

  it('a drenagem do host entrega a fila dos panes fechados depois de reconectar', async () => {
    const storage = memoryStorage()
    const kv = memoryKv()
    const p2 = setup({ storage, kv, paneId: 'p2' })
    await p2.mount('disconnected')
    await p2.submit('npm test')
    await p2.submit('git status')
    act(() => renderer?.unmount())

    const desktop = fakeDesktop()
    const manager = createMobileThreadOutboxManager({ storage, warn: () => {} })
    const holds = createNexusOutboxHoldStore(kv)
    const hostArgs = (state: ConnectionState) => ({
      hostId: 'host-a',
      nexus: desktop.nexus,
      state,
      activePaneId: null,
      manager,
      holds
    })
    await act(async () => {
      renderer = create(createElement(HostHarness, { args: hostArgs('reconnecting') }))
    })
    await settle()
    expect(desktop.calls).toEqual([])
    await act(async () => {
      renderer!.update(createElement(HostHarness, { args: hostArgs('connected') }))
    })
    await settle()
    expect(desktop.pty).toEqual(['p2:npm test', 'p2:git status'])
  })

  describe('comando antigo não sai sozinho (janela do dedup do desktop)', () => {
    it('item tentado e antigo fica retido na reconexão e segura os de trás', async () => {
      const t = setup()
      await t.mount('connected')
      t.desktop.setPlan(['lost-ack'])
      await t.submit('git status')
      expect(t.desktop.calls).toHaveLength(1)
      await t.setState('reconnecting')
      await t.submit('npm test')

      t.advance(NEXUS_OUTBOX_AUTO_FLUSH_MAX_AGE_MS + 60_000)
      await t.setState('connected')

      expect(t.desktop.calls).toHaveLength(1)
      expect(outbox!.queued.map((item) => [item.text, item.status])).toEqual([
        ['git status', 'stale'],
        ['npm test', 'waiting']
      ])
    })

    it('tocar em Enviar entrega o antigo com o MESMO messageId', async () => {
      const t = setup()
      await t.mount('connected')
      t.desktop.setPlan(['lost-ack'])
      await t.submit('git status')
      await t.setState('reconnecting')
      t.advance(NEXUS_OUTBOX_AUTO_FLUSH_MAX_AGE_MS + 60_000)
      await t.setState('connected')
      expect(t.desktop.calls).toHaveLength(1)

      await act(async () => {
        outbox!.sendNow('cmd-1')
      })
      await settle()

      expect(t.desktop.calls.map((call) => call.messageId)).toEqual(['cmd-1', 'cmd-1'])
      expect(t.desktop.pty).toEqual(['p1:git status'])
      expect(outbox!.queued).toEqual([])
    })

    it('itens recentes continuam saindo sozinhos, em ordem', async () => {
      const t = setup()
      await t.mount('reconnecting')
      await t.submit('git status')
      await t.submit('npm test')
      t.advance(NEXUS_OUTBOX_AUTO_FLUSH_MAX_AGE_MS - 60_000)
      await t.setState('connected')
      expect(t.desktop.pty).toEqual(['p1:git status', 'p1:npm test'])
    })

    it('a drenagem do host também não manda comando antigo de pane fechado', async () => {
      const storage = memoryStorage()
      const kv = memoryKv()
      const p2 = setup({ storage, kv, paneId: 'p2' })
      await p2.mount('disconnected')
      await p2.submit('npm test')
      act(() => renderer?.unmount())

      const desktop = fakeDesktop()
      await act(async () => {
        renderer = create(
          createElement(HostHarness, {
            args: {
              hostId: 'host-a',
              nexus: desktop.nexus,
              state: 'connected',
              activePaneId: null,
              manager: createMobileThreadOutboxManager({ storage, warn: () => {} }),
              holds: createNexusOutboxHoldStore(kv),
              confirmations: new Map(),
              now: () => Date.now() + NEXUS_OUTBOX_AUTO_FLUSH_MAX_AGE_MS + 60_000
            }
          })
        )
      })
      await settle()
      expect(desktop.calls).toEqual([])
      expect(storage.disk.size).toBe(1)
    })
  })
})
