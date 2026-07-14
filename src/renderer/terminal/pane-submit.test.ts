import { describe, expect, it, vi } from 'vitest';
import {
  submitPromptToPane,
  submitPromptToPaneConfirmed,
  type PaneSubmitPorts,
} from './pane-submit';

function createPorts(sessionId: string | null = 'session-1') {
  let currentSessionId = sessionId;
  const write = vi.fn();
  const writeConfirmed = vi.fn(async () => true);
  const ports: PaneSubmitPorts = {
    getSessionId: () => currentSessionId,
    write,
    writeConfirmed,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  };
  return {
    ports,
    write,
    writeConfirmed,
    setSessionId: (next: string | null) => {
      currentSessionId = next;
    },
  };
}

describe('pane prompt submission', () => {
  it('pastes multiline text, then sends Enter after the paste settles', () => {
    vi.useFakeTimers();
    try {
      const { ports, write } = createPorts();
      expect(submitPromptToPane('pane-1', 'Objective\nAcceptance', ports)).toBe(true);
      expect(write).toHaveBeenCalledWith(
        'session-1',
        '\x1b[200~Objective\nAcceptance\x1b[201~',
      );
      vi.advanceTimersByTime(749);
      expect(write).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1);
      expect(write).toHaveBeenLastCalledWith('session-1', '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirms only after Enter reaches the expected session', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writeConfirmed } = createPorts();
      const confirmed = submitPromptToPaneConfirmed(
        'pane-1',
        'Continue',
        'session-1',
        ports,
      );
      await Promise.resolve();
      vi.advanceTimersByTime(750);
      await expect(confirmed).resolves.toBe(true);
      expect(writeConfirmed).toHaveBeenNthCalledWith(
        1,
        'session-1',
        '\x1b[200~Continue\x1b[201~',
      );
      expect(writeConfirmed).toHaveBeenLastCalledWith('session-1', '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects before paste when another session already won', async () => {
    const { ports, writeConfirmed } = createPorts('session-newer');
    await expect(submitPromptToPaneConfirmed(
      'pane-1',
      'Continue',
      'session-recovered',
      ports,
    )).resolves.toBe(false);
    expect(writeConfirmed).not.toHaveBeenCalled();
  });

  it('does not send Enter when the recovered session changes after paste', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writeConfirmed, setSessionId } = createPorts();
      const confirmed = submitPromptToPaneConfirmed(
        'pane-1',
        'Continue',
        'session-1',
        ports,
      );
      await Promise.resolve();
      setSessionId('session-2');
      vi.advanceTimersByTime(750);
      await expect(confirmed).resolves.toBe(false);
      expect(writeConfirmed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing without a live session', async () => {
    const { ports, write, writeConfirmed } = createPorts(null);
    expect(submitPromptToPane('pane-1', 'Objective', ports)).toBe(false);
    await expect(submitPromptToPaneConfirmed(
      'pane-1',
      'Objective',
      'session-1',
      ports,
    )).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(writeConfirmed).not.toHaveBeenCalled();
  });

  it('rejects terminal control bytes before writing either half', async () => {
    const { ports, write, writeConfirmed } = createPorts();
    const injected = 'Safe prefix\x1b[201~\rdestructive command';
    expect(submitPromptToPane('pane-1', injected, ports)).toBe(false);
    await expect(submitPromptToPaneConfirmed(
      'pane-1',
      injected,
      'session-1',
      ports,
    )).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(writeConfirmed).not.toHaveBeenCalled();
  });

  it('does not confirm when main rejects either PTY write', async () => {
    vi.useFakeTimers();
    try {
      const { ports, writeConfirmed } = createPorts();
      writeConfirmed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const confirmed = submitPromptToPaneConfirmed(
        'pane-1',
        'Continue',
        'session-1',
        ports,
      );
      await Promise.resolve();
      vi.advanceTimersByTime(750);
      await expect(confirmed).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits longer before Enter for large Claude-style prompts', () => {
    vi.useFakeTimers();
    try {
      const { ports, write } = createPorts();
      const longPrompt = 'x'.repeat(1_200);
      expect(submitPromptToPane('pane-1', longPrompt, ports)).toBe(true);
      vi.advanceTimersByTime(1_679);
      expect(write).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1);
      expect(write).toHaveBeenLastCalledWith('session-1', '\r');
    } finally {
      vi.useRealTimers();
    }
  });
});
