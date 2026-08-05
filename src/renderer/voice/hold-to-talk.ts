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
 * Auto-repeat: uma tecla segurada além do delay de repetição do SO é
 * digitação-com-tecla-baixa, não necessariamente um hold de fala. Se um repeat
 * chega ANTES do limiar, o estado vira `typing`: a tecla é liberada, o espaço
 * retido é devolvido e o ditado não arma mais naquele ciclo. O limiar é
 * deliberadamente menor que o menor delay de repetição usual do SO (~250ms),
 * então em push-to-talk normal o ditado arma antes de qualquer repeat.
 */

/** Limiar de hold. Abaixo disso é toque (espaço); acima é fala. */
export const HOLD_TO_TALK_THRESHOLD_MS = 250;

export type HoldToTalkState = 'idle' | 'pending' | 'talking' | 'typing';

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
      if (this.#state === 'talking') {
        // Já estamos falando: repeat não vira caractere.
        return outcome({ suppressKey: true });
      }
      if (this.#state === 'pending') {
        // Repeat antes do limiar = digitação. Devolve o espaço retido e passa
        // a deixar a tecla fluir para o terminal.
        this.#state = 'typing';
        return outcome({ emitSpaces: 1 });
      }
      // Em 'typing' (ou 'idle' órfão) o navegador entrega o caractere sozinho.
      return INERT;
    }
    if (this.#state !== 'idle') {
      // Sem duplicar retenção nem re-armar o timer.
      return outcome({ suppressKey: this.#state !== 'typing' });
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
    // 'typing' ou 'idle': a tecla pertence ao terminal.
    return INERT;
  }

  /** Perda de foco / desmonte: nunca deixa o ditado ligado. */
  cancel(): HoldToTalkOutcome {
    const previous = this.#state;
    this.#state = 'idle';
    return previous === 'talking' ? outcome({ stopDictation: true }) : INERT;
  }
}
