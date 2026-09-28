import { describe, expect, it } from 'vitest';
import { isOperatorHandContext } from './operator-hand-context';

describe('operator hand identity for context and validation', () => {
  it('preserves the native operator and its Main-proved promotion', () => {
    expect(isOperatorHandContext({ role: 'user' })).toBe(true);
    expect(isOperatorHandContext({ role: 'orchestrator', missionId: 'm', promotedFromUserSession: true })).toBe(true);
  });
  it('does not infer operator origin from a mission, role or worker flag alone', () => {
    expect(isOperatorHandContext({ role: 'user', missionId: 'm' })).toBe(false);
    expect(isOperatorHandContext({ role: 'orchestrator', missionId: 'm' })).toBe(false);
    expect(isOperatorHandContext({ role: 'worker', promotedFromUserSession: true })).toBe(false);
  });
});
