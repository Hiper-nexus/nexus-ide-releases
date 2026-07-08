import { describe, expect, it } from 'vitest';
import { scheduledTailMs } from './live-audio';
import { cancelLiveFollowUp, liveFollowUpGeneration } from './live-followup';

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
});
