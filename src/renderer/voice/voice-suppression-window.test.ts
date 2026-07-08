import { describe, expect, it } from 'vitest';
import {
  MAX_WAKE_SUPPRESSION_MS,
  MIN_WAKE_SUPPRESSION_MS,
  MS_PER_SPOKEN_CHAR,
  TTS_TAIL_GUARD_MS,
  estimatedSpeechMs,
  localAudioMicWithholdMs,
  pcm16DurationMs,
  playbackWakeSuppressionMs,
  realtimeChunkSuppressionMs,
  replyReopenDelayMs,
} from './voice-suppression-window';

describe('playbackWakeSuppressionMs', () => {
  it('covers the real playback duration plus a tail margin', () => {
    // A 23s reply must be suppressed for ~23s + tail, NOT capped mid-speech at
    // the old fixed heuristic — that is what let wake self-fire during the TTS.
    expect(playbackWakeSuppressionMs(23_000)).toBe(23_000 + TTS_TAIL_GUARD_MS);
  });

  it('floors short playback at a safe minimum', () => {
    expect(playbackWakeSuppressionMs(100)).toBe(MIN_WAKE_SUPPRESSION_MS);
  });

  it('clamps absurd durations to the max', () => {
    expect(playbackWakeSuppressionMs(10 * 60_000)).toBe(MAX_WAKE_SUPPRESSION_MS);
  });

  it('treats missing/NaN playback as the floor, never negative', () => {
    expect(playbackWakeSuppressionMs(Number.NaN)).toBe(MIN_WAKE_SUPPRESSION_MS);
    expect(playbackWakeSuppressionMs(-5)).toBe(MIN_WAKE_SUPPRESSION_MS);
  });
});

describe('pcm16DurationMs', () => {
  it('computes duration from byte length at the given sample rate', () => {
    // 24 kHz, 48000 bytes = 24000 int16 samples = 1.0s.
    expect(pcm16DurationMs(48_000, 24_000)).toBe(1_000);
  });

  it('is zero for an empty or invalid chunk', () => {
    expect(pcm16DurationMs(0, 24_000)).toBe(0);
    expect(pcm16DurationMs(100, 0)).toBe(0);
  });
});

describe('realtimeChunkSuppressionMs', () => {
  it('suppresses for the chunk duration plus a tail so streaming never lapses', () => {
    // 0.5s chunk → 500 + tail. Each arriving chunk re-extends the window.
    expect(realtimeChunkSuppressionMs(500)).toBe(500 + TTS_TAIL_GUARD_MS);
  });

  it('is just the tail for an empty chunk (still guards briefly)', () => {
    expect(realtimeChunkSuppressionMs(0)).toBe(TTS_TAIL_GUARD_MS);
  });
});

describe('localAudioMicWithholdMs', () => {
  it('withholds the mic for the real audible duration plus the acoustic tail', () => {
    // FIX 1: a 0.5s ack bleeds into the hot mic for ~0.5s + decay — withhold
    // exactly that, not a fixed floor.
    expect(localAudioMicWithholdMs(500)).toBe(500 + TTS_TAIL_GUARD_MS);
  });

  it('does NOT apply the wake floor — a short ack must not eat the command', () => {
    // If this used MIN_WAKE_SUPPRESSION_MS (4.5s), a 0.3s ack would swallow the
    // user's next 4s of speech. The withhold must track the audio, not the floor.
    expect(localAudioMicWithholdMs(300)).toBeLessThan(MIN_WAKE_SUPPRESSION_MS);
  });

  it('is just the tail for an empty/NaN duration', () => {
    expect(localAudioMicWithholdMs(0)).toBe(TTS_TAIL_GUARD_MS);
    expect(localAudioMicWithholdMs(Number.NaN)).toBe(TTS_TAIL_GUARD_MS);
  });
});

describe('replyReopenDelayMs', () => {
  it('is a real tail guard, longer than the old flat 700ms', () => {
    expect(replyReopenDelayMs()).toBeGreaterThan(700);
  });
});

describe('estimatedSpeechMs', () => {
  it('estimates duration from the spoken text length', () => {
    expect(estimatedSpeechMs(100)).toBe(100 * MS_PER_SPOKEN_CHAR);
  });

  it('is zero for empty/invalid text', () => {
    expect(estimatedSpeechMs(0)).toBe(0);
    expect(estimatedSpeechMs(Number.NaN)).toBe(0);
  });

  it('a long reply estimate stays within the suppression cap', () => {
    // ~330 chars ≈ a 23s reply; suppression covers it without clamping.
    expect(playbackWakeSuppressionMs(estimatedSpeechMs(330))).toBeLessThan(
      MAX_WAKE_SUPPRESSION_MS,
    );
  });
});
