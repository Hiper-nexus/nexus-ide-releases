/**
 * Discriminador hold-to-talk do Space (push-to-talk de verdade).
 *
 * Contrato do operador: **um toque em Space é um espaço**; ditado só arma em
 * HOLD. O comportamento anterior armava no próprio keydown, sem limiar nenhum
 * (`voice-window-ptt.ts`, `e.preventDefault()` + `onStart()` no keydown), então
 * cada espaço de digitação normal era roubado e o ditado armava-e-abortava —
 * o "Jarvis pisca" relatado no v0.26.0.
 *
 * Como o espaço só pode ser entregue DEPOIS de sabermos que não era hold, o
 * keydown é retido (suppressKey) e o caractere é reemitido no keyup rápido.
 * Máquina de estados pura — sem DOM, sem timers — para ser testável de ponta a
 * ponta; a camada DOM (`voice-window-ptt.ts`) só traduz eventos e agenda o
 * timer do limiar.
 *
 * Auto-repeat: enquanto o keydown está retido (`pending`), repeats do SO são
 * SUPRIMIDOS e a decisão é só por tempo: segurou além do limiar → fala; soltou
 * antes → exatamente 1 espaço. Isso permite um limiar maior que o delay de
 * repetição do SO (~225–375 ms no macOS), que é o que protege quem digita
 * espaços devagar. Troca assumida: segurar Space para repetir espaços deixa de
 * funcionar enquanto o ditado por Space está habilitado.
 */

import {
  HOLD_TO_TALK_DEFAULT_MS,
  HOLD_TO_TALK_MAX_MS,
  HOLD_TO_TALK_MIN_MS,
  clampHoldToTalkMs,
} from '../../shared/voice-config';

export { HOLD_TO_TALK_MAX_MS, HOLD_TO_TALK_MIN_MS, clampHoldToTalkMs };

/** Limiar de hold. Abaixo disso é toque (espaço); acima é fala. */
export const HOLD_TO_TALK_THRESHOLD_MS = HOLD_TO_TALK_DEFAULT_MS;

/**
 * Válvula de segurança do hold-to-talk (tecla presa / keyup perdido).
 *
 * O keyup é o ÚNICO fim legítimo da fala com a tecla baixa. Este teto não é
 * limite de ditado: um texto longo falado com o Space/PTT ainda pressionado
 * NUNCA pode ser enviado antes da tecla subir (bug do envio prematuro, em que
 * `maxMs: 60_000` cortava a captura no meio da fala e o `finishAndProcess`
 * injetava o trecho no pane). 5 min só interrompe um hold esquecido.
 */
export const HOLD_TO_TALK_SAFETY_MAX_MS = 5 * 60_000;

/**
 * Hold-to-talk nunca encerra por silêncio: o operador pode pausar para pensar
 * com a tecla ainda baixa. `Infinity` desarma o ramo de silêncio nos dois
 * detectores (`trackSilence` / `shouldEndpointUtterance`) sem flag nova —
 * `quietFor >= Infinity` e `silentMs < Infinity` nunca endpointam.
 */
export const HOLD_TO_TALK_SILENCE_MS = Number.POSITIVE_INFINITY;

export type HoldToTalkState = 'idle' | 'pending' | 'talking';

export interface HoldToTalkOutcome {
  /** O caller deve chamar preventDefault/stopPropagation neste evento. */
  readonly suppressKey: boolean;
  readonly startDictation: boolean;
  readonly stopDictation: boolean;
  /** Quantos espaços o caller deve entregar ao destino que tinha foco. */
  readonly emitSpaces: number;
  /** O caller deve agendar o timer do limiar. */
  readonly armThreshold: boolean;
}

const INERT: HoldToTalkOutcome = Object.freeze({
  suppressKey: false,
  startDictation: false,
  stopDictation: false,
  emitSpaces: 0,
  armThreshold: false,
});

function outcome(patch: Partial<HoldToTalkOutcome>): HoldToTalkOutcome {
  return Object.freeze({ ...INERT, ...patch });
}

export class HoldToTalkDiscriminator {
  #state: HoldToTalkState = 'idle';

  get state(): HoldToTalkState {
    return this.#state;
  }

  /** keydown físico da tecla de PTT. */
  keyDown(event: { readonly repeat: boolean }): HoldToTalkOutcome {
    if (event.repeat) {
      // Repeat nunca vira caractere nem muda de estado: em 'talking' seria
      // espaço no meio da fala; em 'pending' a decisão é só por tempo. Sem
      // keydown retido ('idle' órfão) o navegador entrega a tecla sozinho.
      return this.#state === 'idle' ? INERT : outcome({ suppressKey: true });
    }
    if (this.#state !== 'idle') {
      // Sem duplicar retenção nem re-armar o timer.
      return outcome({ suppressKey: true });
    }
    this.#state = 'pending';
    return outcome({ suppressKey: true, armThreshold: true });
  }

  /** O timer do limiar disparou com a tecla ainda pressionada. */
  thresholdElapsed(): HoldToTalkOutcome {
    if (this.#state !== 'pending') return INERT;
    this.#state = 'talking';
    return outcome({ startDictation: true });
  }

  keyUp(): HoldToTalkOutcome {
    const previous = this.#state;
    this.#state = 'idle';
    if (previous === 'pending') {
      // Toque: o espaço retido é entregue agora. Nenhum start/stop foi
      // emitido, então não há HUD para piscar.
      return outcome({ suppressKey: true, emitSpaces: 1 });
    }
    if (previous === 'talking') {
      return outcome({ suppressKey: true, stopDictation: true });
    }
    // 'idle': a tecla pertence ao terminal.
    return INERT;
  }

  /** Perda de foco / desmonte: nunca deixa o ditado ligado. */
  cancel(): HoldToTalkOutcome {
    const previous = this.#state;
    this.#state = 'idle';
    return previous === 'talking' ? outcome({ stopDictation: true }) : INERT;
  }
}

/**
 * Guarda de "soltou durante a partida" (F-1541).
 *
 * Iniciar a captura é assíncrono (`getUserMedia` no Windows leva centenas de
 * ms). Se a tecla sobe nessa janela, o stop vê "não está gravando" e é
 * ignorado; a captura então termina de abrir sozinha e grava, sem ninguém para
 * parar, até a válvula de 5 min — o "espaço preso" que o operador via enquanto
 * digitava. Cada pressionamento ganha um token; quem inicia confere, DEPOIS de
 * a captura abrir, se aquele mesmo pressionamento ainda está pressionado.
 */
export class HoldPressGuard {
  #generation = 0;
  #held = false;

  /**
   * Registra um pressionamento e devolve o token dele. Repetição com a tecla
   * já baixa (WM_HOTKEY auto-repeat no Windows) mantém o MESMO token: senão a
   * repetição invalidaria a captura legítima que ainda está abrindo.
   */
  press(): number {
    if (!this.#held) this.#generation += 1;
    this.#held = true;
    return this.#generation;
  }

  /** A tecla subiu (ou o hold foi cancelado). */
  release(): void {
    this.#held = false;
  }

  /** O pressionamento `token` ainda está de pé? Um press novo invalida o velho. */
  isHeld(token: number): boolean {
    return this.#held && this.#generation === token;
  }
}
