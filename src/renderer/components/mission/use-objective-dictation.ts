import { useEffect, useRef, useState } from 'react';
import { claimDictationTarget } from '../../voice/dictation-target';
import {
  requestDictationStart,
  requestDictationStop,
} from '../../voice/manual-dictation';
import { useVoiceStore } from '../../voice/voice-store';

export type ObjectiveDictationState = 'idle' | 'listening' | 'busy';

/**
 * Ditado do objetivo no wizard de missão ("às vezes áudio ajuda demais").
 *
 * Enquanto o wizard está montado, o claim redireciona QUALQUER ditado (botão
 * de microfone OU Space hold-to-talk fora de campos de texto) para o
 * callback — nunca para um pane oculto. O botão dispara o mesmo caminho de
 * captura do Space; o estado espelha o voice-store, então auto-stop (60s),
 * erro e transcrição em curso nunca deixam o rótulo mentindo.
 */
export function useObjectiveDictation(input: {
  enabled: boolean;
  onTranscript: (text: string) => void;
}): {
  available: boolean;
  state: ObjectiveDictationState;
  toggle: () => void;
} {
  const info = useVoiceStore((s) => s.info);
  const status = useVoiceStore((s) => s.status);
  const [armed, setArmed] = useState(false);
  const onTranscriptRef = useRef(input.onTranscript);
  onTranscriptRef.current = input.onTranscript;

  useEffect(() => {
    if (!input.enabled) return undefined;
    return claimDictationTarget('mission-objective', (text) =>
      onTranscriptRef.current(text),
    );
  }, [input.enabled]);

  // Desarme HONESTO: no clique o status ainda é 'idle' — desarmar ali matava
  // o ciclo antes de nascer (voo dev 19/08: botão voltava a "Ditar" em 1
  // render). Só desarma depois que o ciclo realmente saiu de idle (fim
  // natural/auto-stop/erro), ou em 3s se a captura nunca partiu.
  const sawActiveRef = useRef(false);
  useEffect(() => {
    if (!armed) {
      sawActiveRef.current = false;
      return undefined;
    }
    if (
      status === 'listening' ||
      status === 'transcribing' ||
      status === 'routing'
    ) {
      sawActiveRef.current = true;
      return undefined;
    }
    if (status === 'error' || sawActiveRef.current) {
      setArmed(false);
      return undefined;
    }
    const deadStart = setTimeout(() => setArmed(false), 3_000);
    return () => clearTimeout(deadStart);
  }, [armed, status]);

  const available = Boolean(info) && info?.captureAllowed !== false;
  const state: ObjectiveDictationState = !armed
    ? 'idle'
    : status === 'listening'
      ? 'listening'
      : 'busy';

  const toggle = (): void => {
    if (!available || !input.enabled) return;
    if (state === 'listening') {
      requestDictationStop();
      return;
    }
    if (state === 'busy') return;
    setArmed(true);
    requestDictationStart();
  };

  return { available, state, toggle };
}
