// Copyright (c) 2026 Lovecast Inc. — MIT License
import { describe, expect, it, vi } from 'vitest';
import { TerminalInputVisibilityController } from './terminal-input-visibility';

function harness() {
  let now = 1_000;
  let frame: FrameRequestCallback | null = null;
  const scrollToBottom = vi.fn();
  const refresh = vi.fn();
  const toggle = vi.fn(() => false);
  const controller = new TerminalInputVisibilityController({
    term: { rows: 24, scrollToBottom, refresh },
    classList: { toggle },
    now: () => now,
    requestFrame: (callback) => {
      frame = callback;
      return 7;
    },
    cancelFrame: vi.fn(),
  });
  return {
    controller,
    scrollToBottom,
    refresh,
    toggle,
    advance: (ms: number) => {
      now += ms;
    },
    paint: () => {
      const callback = frame;
      frame = null;
      callback?.(now);
    },
  };
}

describe('TerminalInputVisibilityController', () => {
  it('returns a scrolled pane to live output before forwarding user input', () => {
    const h = harness();
    h.controller.onScroll(12, 40);

    expect(h.controller.isFollowing).toBe(false);
    expect(h.toggle).toHaveBeenLastCalledWith('term-host--history', true);

    h.controller.onUserInput();

    expect(h.controller.isFollowing).toBe(true);
    expect(h.scrollToBottom).toHaveBeenCalledOnce();
    expect(h.toggle).toHaveBeenLastCalledWith('term-host--history', false);
  });

  it('coalesces interactive input and parsed output into one visual frame', () => {
    const h = harness();

    h.controller.onUserInput();
    h.advance(10);
    h.controller.onOutputParsed();
    h.paint();

    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledWith(0, 23);
    expect(h.scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it('does not force repaints for unrelated background output', () => {
    const h = harness();
    h.advance(1_000);

    h.controller.onOutputParsed();
    h.paint();

    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('can repaint immediately after a WebGL context loss', () => {
    const h = harness();

    h.controller.repaintNow();

    expect(h.refresh).toHaveBeenCalledWith(0, 23);
  });
});
