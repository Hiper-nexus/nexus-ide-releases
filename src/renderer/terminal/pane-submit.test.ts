import { describe, expect, it, vi } from 'vitest';
import { submitPromptToPane, type PaneSubmitPorts } from './pane-submit';

function createPorts(sessionId: string | null = 'session-1') {
  let currentSessionId = sessionId;
  const write = vi.fn();
  const ports: PaneSubmitPorts = {
    getSessionId: () => currentSessionId,
    write,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  };
  return {
    ports,
    write,
    setSessionId: (next: string | null) => {
      currentSessionId = next;
    },
  };
}

describe('submitPromptToPane', () => {
  it('pastes multiline text, then sends Enter as CR after the paste settles', () => {
    vi.useFakeTimers();
    try {
      const { ports, write } = createPorts();

      expect(submitPromptToPane('pane-1', 'Objective\nAcceptance', ports)).toBe(true);
      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenNthCalledWith(
        1,
        'session-1',
        '\x1b[200~Objective\nAcceptance\x1b[201~',
      );

      vi.advanceTimersByTime(249);
      expect(write).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1);
      expect(write).toHaveBeenNthCalledWith(2, 'session-1', '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when the pane has no live session', () => {
    const { ports, write } = createPorts(null);

    expect(submitPromptToPane('pane-1', 'Objective', ports)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not submit into a replacement session', () => {
    vi.useFakeTimers();
    try {
      const { ports, write, setSessionId } = createPorts();

      expect(submitPromptToPane('pane-1', 'Objective', ports)).toBe(true);
      setSessionId('session-2');
      vi.advanceTimersByTime(250);

      expect(write).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
