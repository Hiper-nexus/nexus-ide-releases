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
  /**
   * Qual superfície está pedindo o microfone. O claim é um só e o último
   * vence (`dictation-target`), então cada campo que dita precisa do PRÓPRIO
   * id — dois campos com o mesmo id ficariam indistinguíveis no log de voz.
   * Omitido, segue o objetivo da missão, que foi o primeiro a ditar.
   */
  claimId?: string;
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

  const claimId = input.claimId ?? 'mission-objective';
  /**
   * O claim SOBREVIVE ao turno em voo, mesmo que a superfície desabilite.
   *
   * `routeDictation` consulta o claim DEPOIS que a STT devolve o texto. Soltar
   * no meio da transcrição (trocar de aba, fechar o Estúdio) não perdia a fala
   * — fazia pior: ela caía no roteamento de panes e era DIGITADA no pane
   * focado, um terminal de agente. Por isso quem segura é `enabled || armed`:
   * o que já foi falado ainda chega ao campo onde a fala começou.
   */
  const holdClaim = input.enabled || armed;
  useEffect(() => {
    if (!holdClaim) return undefined;
    return claimDictationTarget(claimId, (text) =>
      onTranscriptRef.current(text),
    );
  }, [holdClaim, claimId]);

  // A superfície saiu de cena com o microfone aberto: pare de ouvir agora. O
  // claim acima continua até o turno resolver, então a janela entre a fala e
  // a entrega é só a latência da STT — e ela aponta para o campo certo.
  useEffect(() => {
    if (input.enabled || !armed) return;
    if (status === 'listening') requestDictationStop();
  }, [input.enabled, armed, status]);

  // Desmontou no meio da captura (o brief fechado no botão Cancelar): não dá
  // para entregar a um campo que não existe mais, mas dá para parar de ouvir
  // em vez de seguir gravando para lugar nenhum.
  const armedRef = useRef(armed);
  armedRef.current = armed;
  useEffect(
    () => () => {
      if (armedRef.current) requestDictationStop();
    },
    [],
  );

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
