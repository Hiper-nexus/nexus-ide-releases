/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
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
});

describe('attachWindowPtt', () => {
  it('starts on Space keydown and stops on keyup when enabled', () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const dispose = attachWindowPtt(
      { onStart, onStop },
      {
        getKeyCode: () => 'Space',
        isEnabled: () => true,
      },
    );

    const term = document.createElement('div');
    term.className = 'xterm';
    document.body.appendChild(term);

    term.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', bubbles: true }),
    );
    // Listener is on window capture — dispatch on window.
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', bubbles: true }),
    );
    expect(onStart).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new KeyboardEvent('keyup', { code: 'Space', bubbles: true }),
    );
    expect(onStop).toHaveBeenCalledTimes(1);

    dispose();
    term.remove();
  });

  it('ignores Space while disabled', () => {
    const onStart = vi.fn();
    const dispose = attachWindowPtt(
      { onStart, onStop: vi.fn() },
      {
        getKeyCode: () => 'Space',
        isEnabled: () => false,
      },
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', bubbles: true }),
    );
    expect(onStart).not.toHaveBeenCalled();
    dispose();
  });
});
