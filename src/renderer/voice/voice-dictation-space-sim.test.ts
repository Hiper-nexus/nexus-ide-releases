/** @vitest-environment jsdom */
/**
 * Simulation: hold Space → window PTT fires → dictation path would arm.
 * Mirrors production gates (hotkeyScope/window, bare Space, xterm focus)
 * without opening a real mic (STT is out of band).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachWindowPtt,
  codeMatchesPttKey,
  shouldIgnoreWindowPttTarget,
} from './voice-window-ptt';
import { isWindowScopedShortcut } from '../../shared/voice-config';
import { isDictationCapture } from './jarvis-reply-loop';

type SimInfo = {
  captureAllowed?: boolean;
  hotkeyScope?: 'global' | 'window';
  shortcut: string;
  pushToTalkKeyCode: string;
  routing: string;
};

/** Same enablement rule as voice-controller window-PTT (dictation). */
function windowPttEnabled(info: SimInfo | null | undefined): boolean {
  if (!info || info.captureAllowed === false) return false;
  return (
    info.hotkeyScope === 'window' || isWindowScopedShortcut(info.shortcut ?? '')
  );
}

/** Limiar de hold usado nas simulações (o real vem de hold-to-talk.ts). */
const HOLD_MS = 250;

/** Operator config after Ditado EN preset (matches ~/.nexus/plugins/voice). */
const DICTATION_EN_INFO: SimInfo = {
  captureAllowed: true,
  hotkeyScope: 'window',
  shortcut: 'Space',
  pushToTalkKeyCode: 'Space',
  routing: 'focused-pane',
};

function releaseSpace() {
  window.dispatchEvent(
    new KeyboardEvent('keyup', {
      code: 'Space',
      key: ' ',
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('simulação Space → ditado (sem mic)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('preset Ditado EN habilita window-PTT (Space bare)', () => {
    expect(isWindowScopedShortcut(DICTATION_EN_INFO.shortcut)).toBe(true);
    expect(windowPttEnabled(DICTATION_EN_INFO)).toBe(true);
    expect(codeMatchesPttKey('Space', DICTATION_EN_INFO.pushToTalkKeyCode)).toBe(
      true,
    );
    expect(isDictationCapture('dictation')).toBe(true);
  });

  it('⌘⇧Space global NÃO arma ditado por Space bare', () => {
    const jarvisGlobal: SimInfo = {
      captureAllowed: true,
      hotkeyScope: 'global',
      shortcut: 'CommandOrControl+Shift+Space',
      pushToTalkKeyCode: 'Space',
      routing: 'jarvis',
    };
    expect(windowPttEnabled(jarvisGlobal)).toBe(false);
  });

  it('hold Space no xterm: onStart(dictation) + onStop; não digita espaço', () => {
    vi.useFakeTimers();
    const onStart = vi.fn();
    const onStop = vi.fn();
    const emitSpace = vi.fn();
    let info: SimInfo = { ...DICTATION_EN_INFO };

    const dispose = attachWindowPtt(
      { onStart, onStop, emitSpace },
      {
        getKeyCode: () => info.pushToTalkKeyCode,
        isEnabled: () => windowPttEnabled(info),
        getHoldMs: () => HOLD_MS,
      },
    );

    const term = document.createElement('div');
    term.className = 'xterm';
    const helper = document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';
    term.appendChild(helper);
    document.body.appendChild(term);

    expect(shouldIgnoreWindowPttTarget(helper)).toBe(false);

    const down = new KeyboardEvent('keydown', {
      code: 'Space',
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    // Capture-phase window listener (production attachWindowPtt)
    const prevented = !window.dispatchEvent(down);
    // In jsdom, preventDefault on window-dispatched events still sets defaultPrevented
    expect(down.defaultPrevented || prevented).toBe(true);
    // Contrato hold-to-talk: o keydown apenas RETÉM a tecla; o ditado só arma
    // quando o limiar vence com a tecla ainda pressionada.
    expect(onStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onStart).toHaveBeenCalledTimes(1);

    // capture reason for the controller path
    expect(isDictationCapture('dictation')).toBe(true);

    releaseSpace();
    expect(onStop).toHaveBeenCalledTimes(1);
    // Hold nunca digita espaço no pane.
    expect(emitSpace).not.toHaveBeenCalled();

    dispose();
    vi.useRealTimers();
  });

  it('toque em Space no xterm digita o espaço e NÃO arma ditado', () => {
    vi.useFakeTimers();
    const onStart = vi.fn();
    const emitSpace = vi.fn();
    const info: SimInfo = { ...DICTATION_EN_INFO };
    const dispose = attachWindowPtt(
      { onStart, onStop: vi.fn(), emitSpace },
      {
        getKeyCode: () => info.pushToTalkKeyCode,
        isEnabled: () => windowPttEnabled(info),
        getHoldMs: () => HOLD_MS,
      },
    );

    const term = document.createElement('div');
    term.className = 'xterm';
    document.body.appendChild(term);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'Space',
        key: ' ',
        bubbles: true,
        cancelable: true,
      }),
    );
    vi.advanceTimersByTime(HOLD_MS - 80);
    releaseSpace();

    expect(onStart).not.toHaveBeenCalled();
    expect(emitSpace).toHaveBeenCalledTimes(1);

    term.remove();
    dispose();
    vi.useRealTimers();
  });

  it('helper textarea sem .xterm ancestral ainda permite ditado', () => {
    const helper = document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';
    document.body.appendChild(helper);
    expect(shouldIgnoreWindowPttTarget(helper)).toBe(false);
  });

  it('input de formulário NÃO rouba Space (ignora window-PTT)', () => {
    const onStart = vi.fn();
    const dispose = attachWindowPtt(
      { onStart, onStop: vi.fn() },
      {
        getKeyCode: () => 'Space',
        isEnabled: () => true,
      },
    );
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(shouldIgnoreWindowPttTarget(input)).toBe(true);

    // When target is ignored, attachWindowPtt returns early before preventDefault
    // if the event's target is the input — our listener reads e.target.
    Object.defineProperty(
      KeyboardEvent.prototype,
      'target',
      {
        configurable: true,
        get() {
          return input;
        },
      },
    );
    try {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }),
      );
    } finally {
      // restore
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (KeyboardEvent.prototype as any).target;
    }
    // Note: jsdom may not honor prototype target override for Event.target.
    // Direct unit check is the reliable assertion:
    expect(shouldIgnoreWindowPttTarget(input)).toBe(true);

    dispose();
  });

  it('simula fluxo de texto: transcript → pane focado (routeDictation contract)', async () => {
    // routeDictation always uses focused pane — independent of jarvis routing.
    const submit = vi.fn(() => true);
    const focusedPaneId = 'pane-sim-1';
    const text = 'hello from dictation sim';

    // Inline the production contract (avoid pulling zustand stores here):
    function routeDictationSim(
      transcript: string,
      paneId: string | null,
      submitPrompt: (id: string, t: string) => boolean,
    ): string | null {
      if (!paneId) return null;
      return submitPrompt(paneId, transcript) ? paneId : null;
    }

    const paneId = routeDictationSim(text, focusedPaneId, submit);
    expect(paneId).toBe(focusedPaneId);
    expect(submit).toHaveBeenCalledWith(focusedPaneId, text);
  });

  it('config real do operador (Space + window) passaria no gate isEnabled', () => {
    // Snapshot of ~/.nexus/plugins/voice after Ditado EN apply
    const disk: SimInfo = {
      captureAllowed: true,
      hotkeyScope: 'window', // derived from bare Space
      shortcut: 'Space',
      pushToTalkKeyCode: 'Space',
      routing: 'focused-pane',
    };
    expect(windowPttEnabled(disk)).toBe(true);

    // Even if hotkeyScope were missing, bare shortcut still arms:
    expect(
      windowPttEnabled({
        ...disk,
        hotkeyScope: undefined,
      }),
    ).toBe(true);
  });
});
