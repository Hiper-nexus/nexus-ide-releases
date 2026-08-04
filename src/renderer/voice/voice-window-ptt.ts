/**
 * Window-scoped dictation push-to-talk (ADE NexusVoice parity).
 *
 * Bare `Space` must never be registered with Electron `globalShortcut` — that
 * would steal typing from every OS app. Instead the focused renderer listens
 * for keydown/keyup while Nexus is frontmost, holds to talk, and on release
 * the dictation pipeline transcribes (Groq PT→EN) into the focused pane.
 *
 * Space is ALWAYS dictation — never a Jarvis turn. Jarvis stays on her own
 * triggers: global ⌘⇧Space, wake word and click. While this listener is
 * enabled, Space is reserved for dictation (same as typical ADE NexusVoice).
 * Forms/settings keep normal Space; switch the shortcut to a modified combo
 * (e.g. ⌘⇧Space, hotkeyScope global) to type spaces freely in the terminal.
 */

export interface WindowPttCallbacks {
  onStart: () => void;
  onStop: () => void;
}

export interface WindowPttOptions {
  /** Current bare key code from voice config (e.g. "Space"). */
  getKeyCode: () => string;
  /** False when capture is disabled or hotkeyScope is global. */
  isEnabled: () => boolean;
}

/** Elements where Space must keep its normal meaning (forms, settings). */
export function shouldIgnoreWindowPttTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // xterm owns the terminal; NexusVoice intercepts Space there on purpose.
  if (target.closest('.xterm')) return false;
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
 * keydown starts capture; keyup (or blur) stops — mirrors ADE hold hold mode.
 */
export function attachWindowPtt(
  callbacks: WindowPttCallbacks,
  options: WindowPttOptions,
): () => void {
  let capturing = false;

  const onKeyDown = (e: KeyboardEvent) => {
    if (!options.isEnabled()) return;
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!codeMatchesPttKey(e.code, options.getKeyCode())) return;
    if (shouldIgnoreWindowPttTarget(e.target)) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || capturing) return;
    capturing = true;
    callbacks.onStart();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (!codeMatchesPttKey(e.code, options.getKeyCode())) return;
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    capturing = false;
    callbacks.onStop();
  };

  const onBlur = () => {
    if (!capturing) return;
    capturing = false;
    callbacks.onStop();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    if (capturing) {
      capturing = false;
      callbacks.onStop();
    }
  };
}
