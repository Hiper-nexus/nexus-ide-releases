import { describe, expect, it } from 'vitest';
import {
  GRACE_STALE_SERVER_MS,
  GRACE_STALE_NO_PROGRESS_MS,
  isGraceSocketStale,
  isIgnorableRealtimeError,
  isLocalToolCallId,
  isScreenContext,
  localToolCallId,
  shouldLogWakeSyncReset,
  trimLiveHistory,
  buildResumeContext,
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

  it('does not mark a fresh connect as stale before the no-progress threshold', () => {
    const connectedAt = 1_000;
    expect(isGraceSocketStale(0, connectedAt, GRACE_STALE_SERVER_MS, connectedAt)).toBe(false);
    expect(isGraceSocketStale(0, connectedAt + GRACE_STALE_NO_PROGRESS_MS, GRACE_STALE_SERVER_MS, connectedAt)).toBe(false);
    expect(isGraceSocketStale(0, connectedAt + GRACE_STALE_NO_PROGRESS_MS + 1, GRACE_STALE_SERVER_MS, connectedAt)).toBe(true);
  });

  it('uses full threshold when server progress exists', () => {
    expect(isGraceSocketStale(5_000, 5_000 + GRACE_STALE_SERVER_MS, GRACE_STALE_SERVER_MS, 1_000)).toBe(false);
    expect(isGraceSocketStale(5_000, 5_000 + GRACE_STALE_SERVER_MS + 1, GRACE_STALE_SERVER_MS, 1_000)).toBe(true);
  });

  it('marks unknown sockets (no connect, no progress) as stale', () => {
    expect(isGraceSocketStale(0, 10_000)).toBe(true);
  });

  it('logs wake sync reset only when tearing down live state', () => {
    expect(shouldLogWakeSyncReset({
      forceFresh: true,
      inGrace: true,
      providerReady: false,
      connecting: false,
    })).toBe(true);
    expect(shouldLogWakeSyncReset({
      forceFresh: false,
      inGrace: true,
      providerReady: true,
      connecting: false,
    })).toBe(false);
    expect(shouldLogWakeSyncReset({
      forceFresh: true,
      inGrace: false,
      providerReady: false,
      connecting: false,
    })).toBe(false);
  });

  it('trims live history and builds resume context', () => {
    const history = [
      { role: 'user' as const, text: 'a' },
      { role: 'assistant' as const, text: 'b' },
      { role: 'user' as const, text: 'c' },
    ];
    expect(trimLiveHistory(history, 2)).toEqual([
      { role: 'assistant', text: 'b' },
      { role: 'user', text: 'c' },
    ]);
    expect(buildResumeContext(history)).toContain('Usuário: a');
  });
});
