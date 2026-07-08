import { describe, expect, it } from 'vitest';
import {
  hasRealtimeProviderAudioAnswer,
  liveWakeGreetingText,
  liveWakeInjectPrompt,
  shouldSendLiveWakeGreeting,
} from './live-wake-greeting';

describe('Live wake greeting / provider answer gate', () => {
  it('sends a Live greeting only when Classic ack is skipped for wake/click', () => {
    expect(shouldSendLiveWakeGreeting('wake', true)).toBe(true);
    expect(shouldSendLiveWakeGreeting('click', true)).toBe(true);
    expect(shouldSendLiveWakeGreeting('reply', true)).toBe(false);
    expect(shouldSendLiveWakeGreeting('wake', false)).toBe(false);
  });

  it('builds a short Portuguese wake greeting for Charon', () => {
    expect(liveWakeGreetingText('Cleofas')).toBe('Olá, Cleofas.');
    expect(liveWakeGreetingText('')).toBe('Olá.');
  });

  it('never documents Classic TTS as wake greeting fallback (one voice)', () => {
    // Regression guard: liveWakeGreeting must not imply Classic marin speak.
    expect(shouldSendLiveWakeGreeting('wake', true)).toBe(true);
  });

  it('builds Overclock-style [wake] inject prompt', () => {
    expect(liveWakeInjectPrompt('Cleofas')).toContain('[wake]');
    expect(liveWakeInjectPrompt('Cleofas')).toContain('Olá, Cleofas.');
    expect(liveWakeInjectPrompt(null)).toContain('diga exatamente "Olá."');
  });

  it('treats held or already-played Live audio as the provider answer', () => {
    expect(hasRealtimeProviderAudioAnswer({ heldChunks: 1, playedChunks: 0 })).toBe(true);
    expect(hasRealtimeProviderAudioAnswer({ heldChunks: 0, playedChunks: 1 })).toBe(true);
    expect(hasRealtimeProviderAudioAnswer({ heldChunks: 0, playedChunks: 0 })).toBe(false);
  });
});
