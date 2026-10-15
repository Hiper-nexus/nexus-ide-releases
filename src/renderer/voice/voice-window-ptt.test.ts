/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachWindowPtt,
  codeMatchesPttKey,
  shouldIgnoreWindowPttTarget,
} from './voice-window-ptt';

describe('codeMatchesPttKey', () => {
  it('matches Space aliases', () => {
    expect(codeMatchesPttKey('Space', 'Space')).toBe(true);
    expect(codeMatchesPttKey('Space', 'spacebar')).toBe(true);
    expect(codeMatchesPttKey('KeyA', 'Space')).toBe(false);
  });

  it('matches letter and F-keys', () => {
    expect(codeMatchesPttKey('KeyJ', 'J')).toBe(true);
    expect(codeMatchesPttKey('F8', 'F8')).toBe(true);
  });
});

describe('shouldIgnoreWindowPttTarget', () => {
  it('allows xterm and ignores form fields', () => {
    const term = document.createElement('div');
    term.className = 'xterm';
    const inner = document.createElement('textarea');
    term.appendChild(inner);
    document.body.appendChild(term);

    const input = document.createElement('input');
    document.body.appendChild(input);

    expect(shouldIgnoreWindowPttTarget(inner)).toBe(false);
    expect(shouldIgnoreWindowPttTarget(input)).toBe(true);

    term.remove();
    input.remove();
  });

  it('allows xterm helper textarea even without a .xterm ancestor', () => {
    const helper = document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';
    document.body.appendChild(helper);
    expect(shouldIgnoreWindowPttTarget(helper)).toBe(false);
    helper.remove();
  });
});

describe('attachWindowPtt', () => {
  const HOLD_MS = 250;

  function attach(
    overrides: {
      onStart?: () => void;
      onStop?: () => void;
      emitSpace?: (target: EventTarget | null, count: number) => void;
      isEnabled?: () => boolean;
      onDisabledKeyDown?: () => void;
    } = {},
  ) {
    const onStart = vi.fn(overrides.onStart);
    const onStop = vi.fn(overrides.onStop);
    const emitSpace = vi.fn(overrides.emitSpace);
    const onDisabledKeyDown = vi.fn(overrides.onDisabledKeyDown);
    const dispose = attachWindowPtt(
      { onStart, onStop, emitSpace },
      {
        getKeyCode: () => 'Space',
        isEnabled: overrides.isEnabled ?? (() => true),
        getHoldMs: () => HOLD_MS,
        onDisabledKeyDown,
      },
    );
    return { onStart, onStop, emitSpace, onDisabledKeyDown, dispose };
  }

  function keydown(repeat = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      code: 'Space',
      bubbles: true,
      cancelable: true,
      repeat,
    });
    window.dispatchEvent(event);
    return event;
  }

  function keyup(): KeyboardEvent {
    const event = new KeyboardEvent('keyup', {
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('um toque em Space NÃO arma ditado e entrega o espaço ao pane', () => {
    const { onStart, onStop, emitSpace, dispose } = attach();

    keydown();
    vi.advanceTimersByTime(HOLD_MS - 50);
    keyup();

    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(emitSpace).toHaveBeenCalledTimes(1);
    expect(emitSpace.mock.calls[0]![1]).toBe(1);

    // O limiar antigo não pode armar nada depois do toque.
    vi.advanceTimersByTime(HOLD_MS * 4);
    expect(onStart).not.toHaveBeenCalled();
    dispose();
  });

  it('digitar uma frase com espaços normais nunca arma ditado', () => {
    const { onStart, onStop, emitSpace, dispose } = attach();

    for (let i = 0; i < 5; i += 1) {
      keydown();
      vi.advanceTimersByTime(60);
      keyup();
      vi.advanceTimersByTime(120);
    }

    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(emitSpace).toHaveBeenCalledTimes(5);
    dispose();
  });

  it('segurar Space além do limiar arma o ditado e soltar encerra', () => {
    const { onStart, onStop, emitSpace, dispose } = attach();

    keydown();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onStart).toHaveBeenCalledTimes(1);

    keyup();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(emitSpace).not.toHaveBeenCalled();
    dispose();
  });

  it('auto-repeat antes do limiar é suprimido e a decisão segue só o tempo', () => {
    const { onStart, emitSpace, dispose } = attach();

    keydown();
    vi.advanceTimersByTime(HOLD_MS - 100);
    const repeat = keydown(true);

    expect(repeat.defaultPrevented).toBe(true);
    expect(emitSpace).not.toHaveBeenCalled();

    // O limiar original ainda vence: segurou, então fala.
    vi.advanceTimersByTime(100);
    expect(onStart).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('soltar antes do limiar com repeats no meio entrega exatamente 1 espaço', () => {
    const { onStart, emitSpace, dispose } = attach();
    keydown();
    vi.advanceTimersByTime(HOLD_MS - 100);
    keydown(true);
    keydown(true);
    keyup();
    expect(emitSpace).toHaveBeenCalledTimes(1);
    expect(emitSpace.mock.calls[0]![1]).toBe(1);
    vi.advanceTimersByTime(HOLD_MS * 4);
    expect(onStart).not.toHaveBeenCalled();
    dispose();
  });

  it('keydown em composição de IME não é retido nem arma ditado', () => {
    const { onStart, emitSpace, dispose } = attach();
    const event = new KeyboardEvent('keydown', {
      code: 'Space',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    window.dispatchEvent(event);
    vi.advanceTimersByTime(HOLD_MS * 2);
    keyup();
    expect(event.defaultPrevented).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    expect(emitSpace).not.toHaveBeenCalled();
    dispose();
  });

  it('janela escondida com a tecla baixa (keyup perdido) cancela o hold', () => {
    const { onStart, onStop, emitSpace, dispose } = attach();
    keydown();
    vi.advanceTimersByTime(HOLD_MS - 50);
    const spy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    spy.mockRestore();
    vi.advanceTimersByTime(HOLD_MS * 4);
    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(emitSpace).not.toHaveBeenCalled();
    dispose();
  });

  it('o atraso é lido a cada pressionamento (mudança em Configurações vale na hora)', () => {
    let holdMs = 300;
    const onStart = vi.fn();
    const dispose = attachWindowPtt(
      { onStart, onStop: vi.fn(), emitSpace: vi.fn() },
      { getKeyCode: () => 'Space', isEnabled: () => true, getHoldMs: () => holdMs },
    );
    keydown();
    vi.advanceTimersByTime(300);
    expect(onStart).toHaveBeenCalledTimes(1);
    keyup();

    holdMs = 800;
    keydown();
    vi.advanceTimersByTime(700);
    expect(onStart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(onStart).toHaveBeenCalledTimes(2);
    keyup();
    dispose();
  });

  it('retém a tecla no keydown para que o espaço não vaze antes da decisão', () => {
    const { dispose } = attach();
    const down = keydown();
    expect(down.defaultPrevented).toBe(true);
    keyup();
    dispose();
  });

  it('perder o foco durante o hold encerra o ditado', () => {
    const { onStart, onStop, dispose } = attach();
    keydown();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onStart).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('blur'));
    expect(onStop).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('ignores Space while disabled', () => {
    const { onStart, emitSpace, dispose } = attach({ isEnabled: () => false });
    keydown();
    vi.advanceTimersByTime(HOLD_MS * 2);
    keyup();
    expect(onStart).not.toHaveBeenCalled();
    expect(emitSpace).not.toHaveBeenCalled();
    dispose();
  });

  it('Space desarmado avisa UMA vez por pressionamento (sem repeat)', () => {
    const { onDisabledKeyDown, dispose } = attach({
      isEnabled: () => false,
    });
    keydown();
    keydown(true);
    keydown(true);
    keyup();
    expect(onDisabledKeyDown).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('Space desarmado em formulário não avisa (espaço é digitação)', () => {
    const { onDisabledKeyDown, dispose } = attach({
      isEnabled: () => false,
    });
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = new KeyboardEvent('keydown', {
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    expect(onDisabledKeyDown).not.toHaveBeenCalled();
    input.remove();
    dispose();
  });

  it('habilitado nunca avisa', () => {
    const { onDisabledKeyDown, dispose } = attach();
    keydown();
    keyup();
    expect(onDisabledKeyDown).not.toHaveBeenCalled();
    dispose();
  });

  it('não intercepta Space em campos de formulário', () => {
    const { onStart, emitSpace, dispose } = attach();
    const input = document.createElement('input');
    document.body.appendChild(input);

    const event = new KeyboardEvent('keydown', {
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    vi.advanceTimersByTime(HOLD_MS * 2);

    expect(event.defaultPrevented).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    expect(emitSpace).not.toHaveBeenCalled();
    input.remove();
    dispose();
  });
});
