import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLocalAudioGate,
  isLocalAudioAudible,
  markLocalAudioPlaying,
  setLocalAudioWithholdUntil,
} from './live-local-audio-gate';
import {
  TTS_TAIL_GUARD_MS,
  localAudioMicWithholdMs,
} from './voice-suppression-window';

afterEach(() => clearLocalAudioGate());

describe('live-local-audio-gate (FIX 1)', () => {
  it('withholds mic frames for the whole ack playback + tail, then reopens', () => {
    const t0 = 10_000;
    markLocalAudioPlaying(600, t0);

    expect(isLocalAudioAudible(t0)).toBe(true);
    expect(isLocalAudioAudible(t0 + 600)).toBe(true);
    const reopenAt = t0 + localAudioMicWithholdMs(600);
    expect(isLocalAudioAudible(reopenAt)).toBe(false);
    expect(isLocalAudioAudible(reopenAt + 1)).toBe(false);
  });

  it('extends (never shortens) the window when a second local audio overlaps', () => {
    const t0 = 0;
    markLocalAudioPlaying(2_000, t0);
    markLocalAudioPlaying(100, t0 + 500);
    const ackEnd = t0 + localAudioMicWithholdMs(2_000);
    expect(isLocalAudioAudible(ackEnd - 1)).toBe(true);
    expect(isLocalAudioAudible(ackEnd)).toBe(false);
  });

  it('clearLocalAudioGate reopens the mic immediately (barge-in)', () => {
    markLocalAudioPlaying(5_000, 0);
    expect(isLocalAudioAudible(100)).toBe(true);
    clearLocalAudioGate();
    expect(isLocalAudioAudible(100)).toBe(false);
  });

  it('a fresh markLocalAudioPlaying after clear starts a new window', () => {
    markLocalAudioPlaying(1_000, 0);
    clearLocalAudioGate();
    markLocalAudioPlaying(300, 50_000);
    expect(isLocalAudioAudible(50_000)).toBe(true);
    expect(isLocalAudioAudible(50_000 + 300 + TTS_TAIL_GUARD_MS)).toBe(false);
  });

  it('setLocalAudioWithholdUntil can shorten a long wake hold when audio starts', () => {
    markLocalAudioPlaying(12_000, 0);
    expect(isLocalAudioAudible(5_000)).toBe(true);
    setLocalAudioWithholdUntil(1_800);
    expect(isLocalAudioAudible(1_000)).toBe(true);
    expect(isLocalAudioAudible(1_800)).toBe(false);
  });
});
