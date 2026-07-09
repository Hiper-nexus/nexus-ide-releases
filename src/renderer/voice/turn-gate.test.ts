import { describe, expect, it } from 'vitest';
import { shouldOpenGateOnTurnExit } from './turn-gate';

describe('shouldOpenGateOnTurnExit', () => {
  it('opens the gate when the exiting turn is still the current one', () => {
    expect(shouldOpenGateOnTurnExit(7, 7)).toBe(true);
  });

  it('does NOT open when a newer turn superseded this one (it owns the gate now)', () => {
    expect(shouldOpenGateOnTurnExit(8, 7)).toBe(false);
  });

  it('does NOT open on a stale/foreign token', () => {
    expect(shouldOpenGateOnTurnExit(7, 9)).toBe(false);
  });
});
