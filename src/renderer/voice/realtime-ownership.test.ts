import fs from 'node:fs';
import path from 'node:path';
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

describe('Live mute while owner — never Classic STT (regression)', () => {
  it('finishAndProcess idles on Live mute for any captureReason when owner', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'voice-finish-and-process.ts'),
      'utf-8',
    );
    expect(source).toContain('jarvis.liveMuteIdle');
    expect(source).toContain('Live mudo (sem áudio/transcript) — idle sem Classic');
    // Must NOT set realtimeMuteDegrade while realtimeIsOwner (that raced Classic marin).
    expect(source).toMatch(
      /if \(realtimeIsOwner\) \{[\s\S]*?jarvis\.liveMuteIdle[\s\S]*?return;\s*\}/,
    );
  });
});
