import { beforeEach, describe, expect, it } from 'vitest';
import {
  liveMuteRescueCount,
  markLiveMuteRescueAttempt,
  markLiveMicFrameOffered,
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
  it('only replays an explicit usable turn when zero frames were sent', () => {
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
    ).toBe(false);
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: false,
        offeredFrames: 0,
      }),
    ).toBe(false);
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
