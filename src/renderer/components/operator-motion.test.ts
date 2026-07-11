import { describe, expect, it } from 'vitest';
import { operatorFrameMs, shouldAnimateOperatorMood } from './operator-motion';

describe('operator sprite motion budget', () => {
  it('idle breathes but sleeping stays static', () => {
    // Idle now has a slow breathing cadence (more life); sleeping is the one
    // calm/static state (empty ops-board columns).
    expect(shouldAnimateOperatorMood('idle', false, true)).toBe(true);
    expect(shouldAnimateOperatorMood('sleeping', false, true)).toBe(false);
  });

  it('animates only while visible and motion is allowed', () => {
    expect(shouldAnimateOperatorMood('celebrating', false, true)).toBe(true);
    expect(shouldAnimateOperatorMood('evolving', false, true)).toBe(true);
    // Reduced motion and hidden document suppress ALL moods, idle included.
    expect(shouldAnimateOperatorMood('celebrating', true, true)).toBe(false);
    expect(shouldAnimateOperatorMood('idle', true, true)).toBe(false);
    expect(shouldAnimateOperatorMood('celebrating', false, false)).toBe(false);
    expect(shouldAnimateOperatorMood('idle', false, false)).toBe(false);
  });

  it('idle uses a slower cadence than action moods', () => {
    expect(operatorFrameMs('idle')).toBeGreaterThan(operatorFrameMs('celebrating'));
    expect(operatorFrameMs('celebrating')).toBe(operatorFrameMs('evolving'));
  });
});
