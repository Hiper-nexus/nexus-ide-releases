import { beforeEach, describe, expect, it } from 'vitest';
import {
  hasInsufficientLiveMicFrames,
  liveMuteRescueCount,
  markLiveMuteRescueAttempt,
  markLiveMicFrameOffered,
  MIN_USABLE_LIVE_MIC_FRAMES,
  resetLiveMuteRescues,
  resetOfferedLiveMicFramesThisTurn,
  shouldAttemptLiveMuteRescue,
  offeredLiveMicFramesThisTurn,
  waitForLiveRescueEvidence,
} from './live-mute-rescue';

beforeEach(() => {
  resetLiveMuteRescues();
  resetOfferedLiveMicFramesThisTurn();
});

describe('live mute rescue', () => {
  it('treats zero or one socket frame as insufficient Live capture', () => {
    expect(hasInsufficientLiveMicFrames(0)).toBe(true);
    expect(hasInsufficientLiveMicFrames(1)).toBe(true);
    expect(hasInsufficientLiveMicFrames(MIN_USABLE_LIVE_MIC_FRAMES)).toBe(false);

    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: true,
        offeredFrames: 0,
      }),
    ).toBe(true);
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: true,
        offeredFrames: 1,
      }),
    ).toBe(true);
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: true,
        offeredFrames: 2,
      }),
    ).toBe(false);
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: false,
        offeredFrames: 0,
      }),
    ).toBe(false);
    // Follow-up: rescue even when frames already went to Live (missed final).
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: false,
        offeredFrames: 40,
        captureReason: 'reply',
      }),
    ).toBe(true);
  });

  it('waits for real provider evidence and rejects a superseded turn', async () => {
    let now = 1_000;
    let playedAudioChunks = 4;
    const read = () => ({
      turnToken: 7,
      playedAudioChunks,
      heldAudioChunks: 2,
      toolInFlight: 0,
      lastToolAt: 0,
    });
    const result = await waitForLiveRescueEvidence({
      turnToken: 7,
      startedAt: 1_000,
      playedBaseline: 4,
      heldBaseline: 2,
      read,
      now: () => now,
      delay: async () => {
        now += 50;
        playedAudioChunks += 1;
      },
      timeoutMs: 500,
    });
    expect(result).toBe('audio');

    await expect(
      waitForLiveRescueEvidence({
        turnToken: 8,
        startedAt: 1_000,
        playedBaseline: 0,
        heldBaseline: 0,
        read,
        now: () => now,
        delay: async () => {},
      }),
    ).resolves.toBe('superseded');
  });

  it('bounds consecutive rescue attempts and tracks socket frames', () => {
    expect(markLiveMuteRescueAttempt()).toBe(1);
    expect(markLiveMuteRescueAttempt()).toBe(2);
    expect(liveMuteRescueCount()).toBe(2);
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: true,
        offeredFrames: 0,
      }),
    ).toBe(false);
    markLiveMicFrameOffered();
    markLiveMicFrameOffered();
    expect(offeredLiveMicFramesThisTurn()).toBe(2);
  });
});
