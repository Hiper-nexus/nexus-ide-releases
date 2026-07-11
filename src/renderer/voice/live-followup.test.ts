import { describe, expect, it } from 'vitest';
import { scheduledTailMs } from './live-audio';
import {
  REPLY_RAW_SPEECH_RMS,
  buildReplyAutoStop,
  cancelLiveFollowUp,
  liveFollowUpGeneration,
  shouldArmLiveFollowUp,
  shouldContinueLiveFollowUp,
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
      silenceMs: Math.max(base.silenceMs, 1_600),
      minListenMs: Math.max(base.minListenMs ?? 0, 2_200),
      maxMs: Math.max(base.maxMs ?? 0, 22_000),
      rawSpeechRms: REPLY_RAW_SPEECH_RMS,
    });
  });
});
