// Ditado no campo de comando do host Nexus (F-1015). Reusa useMobileDictation: o
// texto ditado PREENCHE o campo para o operador revisar — nunca envia sozinho.
//
// Por que o microfone nasce "indisponível" em host Nexus: o hook do app não
// reconhece fala no aparelho; ele manda o áudio ao desktop (`speech.dictation.start`
// / `.audio` / `.finish` / `.cancel`) e o desktop transcreve. A Remote Bridge do
// Nexus (`src/main/remote/remote-bridge.ts`) ainda não tem esses comandos e o app
// não tem reconhecedor local instalado. Até a bridge ganhar o ditado, o botão
// explica isso e abre o teclado, cujo microfone (ditado do sistema, no aparelho)
// funciona em qualquer campo. Quando a bridge expuser `speech.dictation.*`, basta o
// adaptador rotear esses métodos e ligar NEXUS_BRIDGE_DICTATION_AVAILABLE.
import { useCallback, useState } from 'react'
import { useMobileDictation } from '../hooks/use-mobile-dictation'
import type { RpcClient } from '../transport/rpc-client'

export const NEXUS_BRIDGE_DICTATION_AVAILABLE = false

export const NEXUS_DICTATION_UNAVAILABLE_HINT =
  'Ditado pelo app ainda não chega ao desktop Nexus. Use o microfone do teclado ' +
  '(ditado do sistema, no próprio celular) e revise antes de enviar.'
export const NEXUS_DICTATION_DENIED_HINT =
  'Microfone negado. Libere o acesso nos Ajustes do sistema para ditar.'

export type NexusMicState =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'listening'
  | 'processing'
  | 'denied'
  | 'error'

// oxlint-disable-next-line no-control-regex -- transcrição nunca leva caractere de controle ao campo
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

/** Junta o texto ditado ao que já está no campo, sem controle e sem enviar. */
export function appendDictationTranscript(current: string, transcript: string): string {
  const text = transcript.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (!text) {
    return current
  }
  if (!current.trim()) {
    return text
  }
  return /\s$/.test(current) ? `${current}${text}` : `${current} ${text}`
}

export function isMicrophoneDeniedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /permission denied/i.test(message)
}

export type NexusCommandDictation = {
  readonly micState: NexusMicState
  readonly errorText: string | null
  /** Toque no microfone: começa, para (e transcreve) ou explica por que não dá. */
  readonly toggle: () => Promise<void>
  readonly cancel: () => Promise<void>
}

export function useNexusCommandDictation(args: {
  client: RpcClient | null
  connected: boolean
  available?: boolean
  setInput: (update: (previous: string) => string) => void
  /** Sem ditado no host: o botão abre o teclado (microfone do sistema). */
  onUnavailable?: () => void
}): NexusCommandDictation {
  const available = args.available ?? NEXUS_BRIDGE_DICTATION_AVAILABLE
  const { setInput, onUnavailable } = args
  const [denied, setDenied] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const onTranscript = useCallback(
    (text: string) => setInput((previous) => appendDictationTranscript(previous, text)),
    [setInput]
  )
  const onError = useCallback((error: Error) => setFailure(error.message), [])
  const dictation = useMobileDictation({
    client: args.client,
    enabled: available && args.connected,
    onTranscript,
    onError
  })

  const micState: NexusMicState = !available
    ? 'unavailable'
    : denied
      ? 'denied'
      : dictation.status === 'starting'
        ? 'starting'
        : dictation.status === 'recording'
          ? 'listening'
          : dictation.status === 'processing'
            ? 'processing'
            : dictation.status === 'error' || failure
              ? 'error'
              : 'idle'

  const toggle = useCallback(async () => {
    if (!available || !args.connected) {
      onUnavailable?.()
      return
    }
    if (dictation.isRecording) {
      await dictation.stop()
      return
    }
    if (dictation.isStarting || dictation.isProcessing) {
      return
    }
    setFailure(null)
    setDenied(false)
    try {
      await dictation.start()
    } catch (error) {
      if (isMicrophoneDeniedError(error)) {
        setDenied(true)
      } else {
        setFailure(error instanceof Error ? error.message : String(error))
      }
    }
  }, [args.connected, available, dictation, onUnavailable])

  const errorText =
    micState === 'unavailable'
      ? null
      : micState === 'denied'
        ? NEXUS_DICTATION_DENIED_HINT
        : micState === 'error'
          ? `Ditado falhou: ${failure ?? dictation.error ?? 'erro desconhecido'}`
          : null

  return { micState, errorText, toggle, cancel: dictation.cancel }
}
