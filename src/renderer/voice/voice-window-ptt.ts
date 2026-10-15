/**
 * Window-scoped dictation push-to-talk (ADE NexusVoice parity).
 *
 * Bare `Space` must never be registered with Electron `globalShortcut` — that
 * would steal typing from every OS app. Instead the focused renderer listens
 * for keydown/keyup while Nexus is frontmost, holds to talk, and on release
 * the dictation pipeline transcribes (Groq PT→EN) into the focused pane.
 *
 * Space é ditado APENAS EM HOLD. Um toque é um espaço normal e chega ao pane:
 * o keydown é retido até o limiar (`HoldToTalkDiscriminator`) e, se a tecla
 * subir antes dele, o caractere é entregue e nenhum ditado é armado — sem
 * start/stop e portanto sem o HUD piscando. Jarvis segue nos gatilhos dela:
 * ⌘⇧Space global, wake word e clique. Forms/settings nunca são interceptados.
 */

import {
  HOLD_TO_TALK_THRESHOLD_MS,
  HoldToTalkDiscriminator,
} from './hold-to-talk';

/** keyCode que o Chromium reporta para teclas processadas por um IME. */
const IME_KEY_CODE = 229;

export interface WindowPttCallbacks {
  onStart: () => void;
  onStop: () => void;
  /**
   * Entrega os espaços retidos ao destino que tinha foco quando a tecla desceu
   * (toque rápido: soltou antes do limiar).
   */
  emitSpace?: (target: EventTarget | null, count: number) => void;
}

export interface WindowPttOptions {
  /** Current bare key code from voice config (e.g. "Space"). */
  getKeyCode: () => string;
  /** False when capture is disabled or hotkeyScope is global. */
  isEnabled: () => boolean;
  /** Limiar de hold em ms; default `HOLD_TO_TALK_THRESHOLD_MS`. */
  getHoldMs?: () => number;
  /**
   * Space pressionado com o ditado desarmado. UMA chamada por
   * pressionamento (sem repeat) para o chamador explicar o porquê.
   */
  onDisabledKeyDown?: () => void;
}

/** Elements where Space must keep its normal meaning (forms, settings). */
export function shouldIgnoreWindowPttTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // xterm owns the terminal; NexusVoice intercepts Space there on purpose.
  // Helper textarea is the focused node — match it even if the .xterm wrapper
  // is missing from the ancestry in some host trees.
  if (
    target.closest('.xterm') ||
    target.classList.contains('xterm-helper-textarea') ||
    target.closest('textarea.xterm-helper-textarea')
  ) {
    return false;
  }
  if (target.closest('[data-voice-window-ptt="allow"]')) return false;
  if (
    target.closest(
      'input, textarea, select, [contenteditable="true"], .voice-settings, [data-voice-settings]',
    )
  ) {
    return true;
  }
  return false;
}

export function codeMatchesPttKey(eventCode: string, keyCode: string): boolean {
  const wanted = keyCode.trim().toLowerCase();
  if (!wanted) return false;
  if (wanted === 'space' || wanted === 'spacebar') {
    return eventCode === 'Space';
  }
  if (/^f\d{1,2}$/i.test(wanted)) {
    return eventCode.toLowerCase() === wanted.toLowerCase();
  }
  if (/^[a-z0-9]$/i.test(wanted)) {
    const letter = /^Key([A-Z])$/.exec(eventCode);
    if (letter) return letter[1].toLowerCase() === wanted.toLowerCase();
    const digit = /^Digit(\d)$/.exec(eventCode);
    if (digit) return digit[1] === wanted;
  }
  return eventCode === keyCode;
}

/**
 * Attach document-level hold-to-talk. Returns a disposer.
 *
 * O keydown NÃO arma nada: ele retém a tecla e agenda o limiar. Só quando o
 * limiar vence com a tecla ainda pressionada o ditado começa. Toque rápido
 * devolve o espaço ao destino original via `emitSpace`.
 */
export function attachWindowPtt(
  callbacks: WindowPttCallbacks,
  options: WindowPttOptions,
): () => void {
  const discriminator = new HoldToTalkDiscriminator();
  let thresholdTimer: ReturnType<typeof setTimeout> | null = null;
  let heldTarget: EventTarget | null = null;

  const clearThreshold = (): void => {
    if (thresholdTimer !== null) clearTimeout(thresholdTimer);
    thresholdTimer = null;
  };

  const apply = (
    result: ReturnType<HoldToTalkDiscriminator['keyDown']>,
    e: KeyboardEvent | null,
  ): void => {
    if (e && result.suppressKey) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (result.emitSpaces > 0) {
      callbacks.emitSpace?.(heldTarget, result.emitSpaces);
    }
    if (result.startDictation) callbacks.onStart();
    if (result.stopDictation) callbacks.onStop();
    if (result.armThreshold) {
      clearThreshold();
      thresholdTimer = setTimeout(() => {
        thresholdTimer = null;
        apply(discriminator.thresholdElapsed(), null);
      }, options.getHoldMs?.() ?? HOLD_TO_TALK_THRESHOLD_MS);
    }
    // Fora de 'pending' nenhum limiar pode mais armar ditado.
    if (discriminator.state !== 'pending') clearThreshold();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!options.isEnabled()) {
      // Antes o Space morria aqui em silêncio (atalho global ou captura
      // bloqueada) e o operador achava que o ditado estava quebrado.
      if (
        !e.repeat &&
        !e.defaultPrevented &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        codeMatchesPttKey(e.code, options.getKeyCode()) &&
        !shouldIgnoreWindowPttTarget(e.target)
      ) {
        options.onDisabledKeyDown?.();
      }
      return;
    }
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Space dentro de composição de IME confirma o texto: nunca reter.
    if (e.isComposing || e.keyCode === IME_KEY_CODE) return;
    if (!codeMatchesPttKey(e.code, options.getKeyCode())) return;
    if (shouldIgnoreWindowPttTarget(e.target)) return;
    if (!e.repeat) heldTarget = e.target;
    apply(discriminator.keyDown({ repeat: e.repeat }), e);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (!codeMatchesPttKey(e.code, options.getKeyCode())) return;
    apply(discriminator.keyUp(), e);
    heldTarget = null;
  };

  const onBlur = () => {
    apply(discriminator.cancel(), null);
    heldTarget = null;
  };

  // Janela minimizada / troca de Space do macOS pode esconder a página sem
  // blur, perdendo o keyup: nunca deixa o hold preso.
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') onBlur();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    clearThreshold();
    apply(discriminator.cancel(), null);
  };
}
