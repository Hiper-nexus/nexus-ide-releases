import { describe, expect, it } from 'vitest';
import { VoiceTurnTimeline } from './voice-turn-telemetry';

describe('VoiceTurnTimeline', () => {
  it('records each turn milestone once with wake and previous deltas', () => {
    let now = 1_000;
    const timeline = new VoiceTurnTimeline(() => now);

    expect(timeline.mark('turn-1', 'wake')).toMatchObject({
      turnId: 'turn-1',
      milestone: 'wake',
      timestampMs: 1_000,
      deltaFromWakeMs: 0,
      deltaFromPreviousMs: 0,
    });
    now = 1_025;
    expect(timeline.mark('turn-1', 'speech_start')).toMatchObject({
      deltaFromWakeMs: 25,
      deltaFromPreviousMs: 25,
    });
    now = 1_080;
    expect(timeline.mark('turn-1', 'speech_end')).toMatchObject({
      deltaFromWakeMs: 80,
      deltaFromPreviousMs: 55,
    });
    expect(timeline.mark('turn-1', 'speech_end')).toBeNull();
    const remainingMilestones = [
      'turn_committed',
      'first_tool_call',
      'effect_confirmed',
      'first_audio',
    ] as const;
    for (const milestone of remainingMilestones) {
      now += 10;
      expect(timeline.mark('turn-1', milestone)).toMatchObject({
        milestone,
        deltaFromWakeMs: now - 1_000,
        deltaFromPreviousMs: 10,
      });
    }
  });

  it('isolates consecutive turn timelines', () => {
    let now = 2_000;
    const timeline = new VoiceTurnTimeline(() => now);
    timeline.mark('turn-1', 'wake');
    now = 3_000;

    expect(timeline.mark('turn-2', 'wake')).toMatchObject({
      deltaFromWakeMs: 0,
      deltaFromPreviousMs: 0,
    });
  });
});
