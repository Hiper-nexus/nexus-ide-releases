import { describe, expect, it } from 'vitest';
import {
  isIgnorableRealtimeError,
  isLocalToolCallId,
  isScreenContext,
  localToolCallId,
  trimLiveHistory,
  buildResumeContext,
  MAX_LIVE_HISTORY_ENTRY_CHARS,
  MAX_RESUME_CONTEXT_CHARS,
} from './live-transport-helpers';

describe('live-transport-helpers', () => {
  it('classifies wake/reconexão as non-screen context', () => {
    expect(isScreenContext('[wake] diga Olá')).toBe(false);
    expect(isScreenContext('[reconexão] Histórico')).toBe(false);
    expect(isScreenContext('Tela: 3 panes')).toBe(true);
  });

  it('detects local tool call ids', () => {
    expect(isLocalToolCallId(localToolCallId('end', 1))).toBe(true);
    expect(isLocalToolCallId('call_abc')).toBe(false);
  });

  it('ignores benign realtime cancel errors', () => {
    expect(isIgnorableRealtimeError('Cancellation failed: no active response')).toBe(true);
    expect(isIgnorableRealtimeError('OpenAI realtime socket closed')).toBe(false);
  });

  it('trims complete user turns and never starts resume history with assistant', () => {
    const history = [
      { role: 'assistant' as const, text: 'orphan' },
      { role: 'user' as const, text: 'a' },
      { role: 'assistant' as const, text: 'b' },
      { role: 'user' as const, text: 'c' },
      { role: 'assistant' as const, text: 'd' },
      { role: 'user' as const, text: 'e' },
    ];
    expect(trimLiveHistory(history, 2)).toEqual([
      { role: 'user', text: 'c' },
      { role: 'assistant', text: 'd' },
      { role: 'user', text: 'e' },
    ]);
    expect(buildResumeContext(trimLiveHistory(history, 2))).not.toContain('orphan');
  });

  it('bounds individual history entries and the full resume prompt', () => {
    const huge = 'x'.repeat(MAX_LIVE_HISTORY_ENTRY_CHARS * 10);
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: huge,
    }));
    const trimmed = trimLiveHistory(history, 10);
    expect(trimmed.every((entry) => entry.text.length <= MAX_LIVE_HISTORY_ENTRY_CHARS)).toBe(true);
    expect(buildResumeContext(trimmed)?.length).toBeLessThanOrEqual(
      MAX_RESUME_CONTEXT_CHARS,
    );
  });
});
