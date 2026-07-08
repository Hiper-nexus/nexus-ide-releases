import { describe, expect, it } from 'vitest';
import { classicSuppressedByRealtimeOwner } from './realtime-ownership';

describe('classicSuppressedByRealtimeOwner — DEFECT 1: per-SESSION ownership', () => {
  it('suppresses Classic on a wake turn while realtime is live (owner)', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'wake', isRealtimeLive: true }),
    ).toBe(true);
  });

  it('suppresses Classic on a click turn while realtime is live', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'click', isRealtimeLive: true }),
    ).toBe(true);
  });

  it('does NOT suppress when realtime is not live (legit degradation → Classic)', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'wake', isRealtimeLive: false }),
    ).toBe(false);
  });

  it('never suppresses the hot-listen reply follow-on (Classic-owned by design)', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'reply', isRealtimeLive: true }),
    ).toBe(false);
  });

  it('leaves non-ack captures (manual/ptt) on Classic even when realtime is live', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'manual', isRealtimeLive: true }),
    ).toBe(false);
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'ptt', isRealtimeLive: true }),
    ).toBe(false);
  });
});
