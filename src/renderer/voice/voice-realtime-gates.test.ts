import { describe, expect, it } from 'vitest';
import type { VoiceRuntimeInfo } from '../../shared/voice-ipc';
import { canAttemptRealtime, shouldIgnoreLiveReWake } from './voice-realtime-gates';

function infoWithKeys(
  transport: VoiceRuntimeInfo['jarvisLive']['transport'],
  present: string[],
): VoiceRuntimeInfo {
  return {
    jarvisLive: { enabled: true, transport },
    keys: ['XAI_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'].map((envVar) => ({
      envVar,
      hasEnv: present.includes(envVar),
      hasStoredKey: false,
    })),
  } as VoiceRuntimeInfo;
}

describe('shouldIgnoreLiveReWake', () => {
  it('allows barge-in re-wake while Live is speaking (full-duplex)', () => {
    expect(
      shouldIgnoreLiveReWake({
        status: 'speaking',
        remainingMs: 2_400,
        pendingChunks: 0,
        suppressAudioOut: false,
        realtimeTurnActive: true,
      }),
    ).toBe(false);
  });

  it('allows re-wake at idle even with turnActive when nothing is playing', () => {
    // FIX BARGE-IN: idle + turnActive + no audio/pending = greeting stuck or
    // post-reply gap. Allow re-wake; follow-up arming handles the gap safely.
    expect(
      shouldIgnoreLiveReWake({
        status: 'idle',
        remainingMs: 0,
        pendingChunks: 0,
        suppressAudioOut: false,
        realtimeTurnActive: true,
      }),
    ).toBe(false);
  });

  it('ignores re-wake while audio is still draining', () => {
    expect(
      shouldIgnoreLiveReWake({
        status: 'idle',
        remainingMs: 2_400,
        pendingChunks: 0,
        suppressAudioOut: false,
        realtimeTurnActive: true,
      }),
    ).toBe(true);
  });

  it('ignores re-wake while suppressed chunks are queued (pre-flush gap)', () => {
    expect(
      shouldIgnoreLiveReWake({
        status: 'idle',
        remainingMs: 0,
        pendingChunks: 84,
        suppressAudioOut: true,
        realtimeTurnActive: true,
      }),
    ).toBe(true);
  });

  it('allows barge-in when mute-stuck in transcribing with no audio', () => {
    expect(
      shouldIgnoreLiveReWake({
        status: 'transcribing',
        remainingMs: 0,
        pendingChunks: 0,
        suppressAudioOut: false,
        realtimeTurnActive: true,
      }),
    ).toBe(false);
  });

  it('ignores re-wake while transcribing AND audio is draining', () => {
    expect(
      shouldIgnoreLiveReWake({
        status: 'transcribing',
        remainingMs: 0,
        pendingChunks: 12,
        suppressAudioOut: false,
        realtimeTurnActive: true,
      }),
    ).toBe(true);
  });

  it('allows wake when Live turn is fully idle', () => {
    expect(
      shouldIgnoreLiveReWake({
        status: 'idle',
        remainingMs: 0,
        pendingChunks: 0,
        suppressAudioOut: false,
        realtimeTurnActive: false,
      }),
    ).toBe(false);
  });

  it('allows wake while listening for a fresh command / follow-up', () => {
    expect(
      shouldIgnoreLiveReWake({
        status: 'listening',
        remainingMs: 0,
        pendingChunks: 0,
        suppressAudioOut: false,
        realtimeTurnActive: true,
      }),
    ).toBe(false);
  });
});

describe('canAttemptRealtime', () => {
  it('engages grok-realtime when only XAI_API_KEY is present', () => {
    expect(canAttemptRealtime(infoWithKeys('grok-realtime', ['XAI_API_KEY']))).toBe(
      true,
    );
  });

  it('still engages via OpenAI/Gemini fallbacks on the grok chain', () => {
    expect(
      canAttemptRealtime(infoWithKeys('grok-realtime', ['OPENAI_API_KEY'])),
    ).toBe(true);
  });

  it('refuses realtime when Live is on but the chain has no key', () => {
    expect(canAttemptRealtime(infoWithKeys('grok-realtime', []))).toBe(false);
    expect(canAttemptRealtime(infoWithKeys('classic', ['XAI_API_KEY']))).toBe(false);
  });
});
