import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'unused' }))
vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator'
}))
vi.mock('lucide-react-native', () => ({
  AlertTriangle: 'AlertTriangle',
  Check: 'Check',
  Clock: 'Clock',
  Mic: 'Mic',
  MicOff: 'MicOff',
  Square: 'Square',
  X: 'X'
}))

type DictationOptions = {
  enabled: boolean
  onTranscript: (text: string) => void
}
const dictation = vi.hoisted(() => ({
  options: null as DictationOptions | null,
  status: 'idle' as string,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  cancel: vi.fn(async () => {})
}))
vi.mock('../hooks/use-mobile-dictation', () => ({
  useMobileDictation: (options: DictationOptions) => {
    dictation.options = options
    return {
      status: dictation.status,
      isStarting: dictation.status === 'starting',
      isRecording: dictation.status === 'recording',
      isProcessing: dictation.status === 'processing',
      error: null,
      start: dictation.start,
      stop: dictation.stop,
      cancel: dictation.cancel
    }
  }
}))

const outbox = vi.hoisted(() => ({
  submit: vi.fn(async (_text: string) => null as string | null)
}))
vi.mock('./use-nexus-host-outbox', () => ({
  useNexusPaneOutbox: () => ({
    queued: [],
    hold: null,
    lastSent: null,
    submit: outbox.submit,
    cancel: vi.fn(),
    resume: vi.fn(),
    discardAll: vi.fn()
  })
}))

import type { NexusHostApi } from '../transport/nexus-bridge-rpc-adapter'
import type { RpcClient } from '../transport/rpc-client'
import { NexusCommandInput } from './NexusCommandInput'
import { NEXUS_DICTATION_UNAVAILABLE_HINT, appendDictationTranscript } from './nexus-command-dictation'

const nexus = { sendLine: vi.fn() } as unknown as NexusHostApi
const pane = { paneId: 'p1', title: 'Claude', state: 'idle', kind: 'cli-agent' }
const focus = vi.fn()
let renderer: ReactTestRenderer

function render(dictationAvailable: boolean | undefined) {
  act(() => {
    renderer = create(
      createElement(NexusCommandInput, {
        hostId: 'host-a',
        pane,
        nexus,
        client: {} as RpcClient,
        state: 'connected',
        dictationAvailable
      }),
      { createNodeMock: () => ({ focus }) }
    )
  })
}

const input = () => renderer.root.findByType('TextInput' as never)
const button = (label: string) =>
  renderer.root.find(
    (node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label
  )

beforeEach(() => {
  dictation.status = 'idle'
  dictation.options = null
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => renderer.unmount())
})

describe('ditado no campo de comando do host Nexus', () => {
  it('o texto ditado preenche o campo e NUNCA envia sozinho', async () => {
    render(true)
    expect(dictation.options?.enabled).toBe(true)
    act(() => input().props.onChangeText('git'))
    act(() => dictation.options!.onTranscript('status --short'))
    expect(input().props.value).toBe('git status --short')
    expect(outbox.submit).not.toHaveBeenCalled()
    expect(nexus.sendLine).not.toHaveBeenCalled()

    // Só o toque do operador envia, com o texto revisado.
    await act(async () => {
      button('Enviar comando').props.onPress()
    })
    expect(outbox.submit).toHaveBeenCalledWith('git status --short')
  })

  it('toque no microfone começa a ouvir; ouvindo, o toque para e transcreve', async () => {
    render(true)
    await act(async () => {
      button('Ditar comando').props.onPress()
    })
    expect(dictation.start).toHaveBeenCalledTimes(1)
    dictation.status = 'recording'
    act(() => renderer.unmount())
    render(true)
    await act(async () => {
      button('Ouvindo — toque para parar e transcrever').props.onPress()
    })
    expect(dictation.stop).toHaveBeenCalledTimes(1)
    expect(outbox.submit).not.toHaveBeenCalled()
  })

  it('microfone negado vira estado próprio, com a saída explicada', async () => {
    dictation.start.mockRejectedValueOnce(new Error('Microphone permission denied'))
    render(true)
    await act(async () => {
      button('Ditar comando').props.onPress()
    })
    expect(button('Microfone negado')).toBeTruthy()
    expect(JSON.stringify(renderer.toJSON())).toContain('Microfone negado. Libere o acesso')
  })

  it('host sem ditado: o microfone explica e abre o teclado, sem tocar o hook', async () => {
    render(undefined)
    expect(dictation.options?.enabled).toBe(false)
    await act(async () => {
      button('Ditado indisponível neste desktop — abrir o teclado').props.onPress()
    })
    expect(dictation.start).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain(NEXUS_DICTATION_UNAVAILABLE_HINT)
  })
})

describe('appendDictationTranscript', () => {
  it('junta com espaço, limpa controle e ignora transcrição vazia', () => {
    expect(appendDictationTranscript('', ' git status ')).toBe('git status')
    expect(appendDictationTranscript('git ', 'status')).toBe('git status')
    expect(appendDictationTranscript('git', 'status\u0003\u001b[Z')).toBe('git status [Z')
    expect(appendDictationTranscript('git', '   ')).toBe('git')
  })
})
