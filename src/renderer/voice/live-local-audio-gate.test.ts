import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLocalAudioGate,
  isLocalAudioAudible,
  markLocalAudioPlaying,
} from './live-local-audio-gate';
import {
  TTS_TAIL_GUARD_MS,
  localAudioMicWithholdMs,
} from './voice-suppression-window';

afterEach(() => clearLocalAudioGate());

describe('live-local-audio-gate (FIX 1)', () => {
  it('withholds mic frames for the whole ack playback + tail, then reopens', () => {
    // Driving case: the wake ack ("Pois não") plays for 600ms while the mic is
    // hot. Frames must be withheld from the socket for 600ms + tail, then flow
    // again so the user's command still reaches the provider.
    const t0 = 10_000;
    markLocalAudioPlaying(600, t0);

    // During the ack: withheld (isLocalAudioAudible → true → tap skips liveMicIn).
    expect(isLocalAudioAudible(t0)).toBe(true);
    expect(isLocalAudioAudible(t0 + 600)).toBe(true); // still within tail
    // After playback + tail: mic reopens.
    const reopenAt = t0 + localAudioMicWithholdMs(600);
    expect(isLocalAudioAudible(reopenAt)).toBe(false);
    expect(isLocalAudioAudible(reopenAt + 1)).toBe(false);
  });

  it('extends (never shortens) the window when a second local audio overlaps', () => {
    // ack (long) then a short filler: the window must stay at the LATER end, so
    // a short filler starting late cannot reopen the mic mid-ack.
    const t0 = 0;
    markLocalAudioPlaying(2_000, t0); // ends at 2000 + tail
    markLocalAudioPlaying(100, t0 + 500); // would end at 600 + tail — shorter
    const ackEnd = t0 + localAudioMicWithholdMs(2_000);
    expect(isLocalAudioAudible(ackEnd - 1)).toBe(true);
    expect(isLocalAudioAudible(ackEnd)).toBe(false);
  });

  it('clearLocalAudioGate reopens the mic immediately (barge-in)', () => {
    markLocalAudioPlaying(5_000, 0);
    expect(isLocalAudioAudible(100)).toBe(true);
    clearLocalAudioGate();
    // Barge-in: the user is talking over her — capture their frames now.
    expect(isLocalAudioAudible(100)).toBe(false);
  });

  it('a fresh markLocalAudioPlaying after clear starts a new window', () => {
    markLocalAudioPlaying(1_000, 0);
    clearLocalAudioGate();
    markLocalAudioPlaying(300, 50_000);
    expect(isLocalAudioAudible(50_000)).toBe(true);
    expect(isLocalAudioAudible(50_000 + 300 + TTS_TAIL_GUARD_MS)).toBe(false);
  });
});
