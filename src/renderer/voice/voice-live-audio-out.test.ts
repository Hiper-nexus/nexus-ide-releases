import { describe, expect, it, beforeEach } from 'vitest';
import {
  suppressRealtimeAudioOut,
  setSuppressRealtimeAudioOut,
  setRealtimeTurnActive,
  resetPendingRealtimeAudioOut,
} from './voice-session-state';
import { openLiveAudioGate } from './voice-live-audio-out';

describe('openLiveAudioGate', () => {
  beforeEach(() => {
    setSuppressRealtimeAudioOut(true);
    setRealtimeTurnActive(true);
    resetPendingRealtimeAudioOut();
  });

  it('clears stuck suppress so Live audio can play again (root cause of mute)', () => {
    // Log evidence 20:25:16–20:25:33: audioSuppressed climbed to 308 while
    // suppress stayed true after a failed claim / early return.
    expect(suppressRealtimeAudioOut).toBe(true);
    openLiveAudioGate();
    expect(suppressRealtimeAudioOut).toBe(false);
  });

  it('is idempotent when already open', () => {
    openLiveAudioGate();
    openLiveAudioGate();
    expect(suppressRealtimeAudioOut).toBe(false);
  });
});
