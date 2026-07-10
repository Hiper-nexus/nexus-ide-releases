import { describe, expect, it } from 'vitest';
import { shouldAnimateOperatorMood } from './operator-motion';

describe('operator sprite motion budget', () => {
  it('keeps idle and sleeping sprites static', () => {
    expect(shouldAnimateOperatorMood('idle', false, true)).toBe(false);
    expect(shouldAnimateOperatorMood('sleeping', false, true)).toBe(false);
  });

  it('animates meaningful moments only while visible and motion is allowed', () => {
    expect(shouldAnimateOperatorMood('celebrating', false, true)).toBe(true);
    expect(shouldAnimateOperatorMood('evolving', false, true)).toBe(true);
    expect(shouldAnimateOperatorMood('celebrating', true, true)).toBe(false);
    expect(shouldAnimateOperatorMood('celebrating', false, false)).toBe(false);
  });
});
