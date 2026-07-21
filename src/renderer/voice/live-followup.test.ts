import { describe, expect, it } from 'vitest';
import { scheduledTailMs } from './live-audio';
import {
  REPLY_RAW_SPEECH_RMS,
  buildReplyAutoStop,
  cancelLiveFollowUp,
  liveFollowUpGeneration,
  shouldArmLiveFollowUp,
  shouldContinueLiveFollowUp,
  waitForLivePlaybackDrain,
} from './live-followup';

describe('live follow-up continuity helpers', () => {
  it('scheduledTailMs reports remaining gapless queue (used by remainingMs)', () => {
    expect(scheduledTailMs(12.5, 10)).toBe(2500);
    expect(scheduledTailMs(10, 10)).toBe(0);
    expect(scheduledTailMs(9, 10)).toBe(0);
  });

  it('cancelLiveFollowUp bumps generation for stale arm bail-out', () => {
    const before = liveFollowUpGeneration();
    cancelLiveFollowUp();
    expect(liveFollowUpGeneration()).toBe(before + 1);
  });

  it('does not arm a microphone follow-up when a native tool owns the turn', () => {
    expect(shouldArmLiveFollowUp()).toBe(true);
    expect(shouldArmLiveFollowUp(false)).toBe(false);
  });

  it('cancels a scheduled follow-up when the turn is no longer provider-audio owned', () => {
    const armedAt = liveFollowUpGeneration();
    expect(shouldContinueLiveFollowUp(armedAt, () => true)).toBe(true);
    expect(shouldContinueLiveFollowUp(armedAt, () => false)).toBe(false);
    cancelLiveFollowUp();
    expect(shouldContinueLiveFollowUp(armedAt, () => true)).toBe(false);
  });

  it('requires a meaningful raw mic signal before ambient audio can close a follow-up', () => {
    const base = {
      silenceMs: 700,
      minListenMs: 1_500,
      maxMs: 15_000,
      onAutoStop: () => {},
    };

    expect(buildReplyAutoStop(base)).toEqual({
      ...base,
      silenceMs: Math.max(base.silenceMs, 1_200),
      minListenMs: Math.max(base.minListenMs ?? 0, 1_400),
      maxMs: Math.max(base.maxMs ?? 0, 28_000),
      rawSpeechRms: REPLY_RAW_SPEECH_RMS,
    });
  });

  it('waits for a late PCM start and then for the Live queue to drain', async () => {
    let now = 0;
    let remainingMs = 0;
    await expect(
      waitForLivePlaybackDrain({
        remainingMs: () => remainingMs,
        isCurrent: () => true,
        now: () => now,
        delay: async (ms) => {
          now += ms;
          if (now >= 100 && now < 500) remainingMs = 400;
          if (now >= 500) remainingMs = 0;
        },
        startGraceMs: 1_000,
        maxDrainMs: 2_000,
      }),
    ).resolves.toBe('drained');
    expect(now).toBeGreaterThanOrEqual(500);
  });

  it('does not settle playback from a superseded turn', async () => {
    await expect(
      waitForLivePlaybackDrain({
        remainingMs: () => 500,
        isCurrent: () => false,
        delay: async () => {},
      }),
    ).resolves.toBe('superseded');
  });

  it('bounds a Live queue that never drains', async () => {
    let now = 0;
    await expect(
      waitForLivePlaybackDrain({
        remainingMs: () => 500,
        isCurrent: () => true,
        audioAlreadyDrained: true,
        now: () => now,
        delay: async (ms) => {
          now += ms;
        },
        maxDrainMs: 500,
      }),
    ).resolves.toBe('timeout');
  });
});
