import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classicSuppressedByRealtimeOwner,
  shouldFallbackClassicAfterRealtimeMute,
} from './realtime-ownership';

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

  it('P1: suppresses reply follow-on while Live owns (no Classic racer)', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'reply', isRealtimeLive: true }),
    ).toBe(true);
  });

  it('P1: suppresses manual/ptt while Live owns the session', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'manual', isRealtimeLive: true }),
    ).toBe(true);
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'ptt', isRealtimeLive: true }),
    ).toBe(true);
  });
});

describe('Live mute degradation', () => {
  it('falls back for explicit user captures but not ambient reply follow-ups', () => {
    for (const captureReason of ['wake', 'click', 'manual', 'ptt'] as const) {
      expect(shouldFallbackClassicAfterRealtimeMute(captureReason)).toBe(true);
    }
    expect(shouldFallbackClassicAfterRealtimeMute('reply')).toBe(false);
  });

  it('finishAndProcess keeps reply mute idle and degrades explicit captures', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'voice-finish-and-process.ts'),
      'utf-8',
    );
    expect(source).toContain(
      'const explicitCapture = shouldFallbackClassicAfterRealtimeMute',
    );
    expect(source).toContain('shouldAttemptLiveMuteRescue');
    expect(source).toContain('jarvis.replyMuteIdle');
    expect(source).toContain('jarvis.realtimeMuteDegraded');
  });
});
