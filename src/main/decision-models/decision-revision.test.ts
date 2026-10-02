import { describe, expect, it, vi } from 'vitest';
import { bumpDecisionCredentialRevision, decisionCredentialRevision, onDecisionConfigurationChanged } from './decision-revision';

describe('decision configuration revision', () => {
  it('advances monotonically on every bump', () => {
    const start = decisionCredentialRevision();
    bumpDecisionCredentialRevision(); bumpDecisionCredentialRevision();
    expect(decisionCredentialRevision()).toBe(start + 2);
  });

  it('notifies subscribers synchronously and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onDecisionConfigurationChanged(listener);
    bumpDecisionCredentialRevision();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    bumpDecisionCredentialRevision();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps notifying the others when one subscriber throws, without leaking its message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const healthy = vi.fn();
    const stopBroken = onDecisionConfigurationChanged(() => { throw new Error('private subscriber failure'); });
    const stopHealthy = onDecisionConfigurationChanged(healthy);
    expect(() => bumpDecisionCredentialRevision()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls)).not.toContain('private subscriber failure');
    stopBroken(); stopHealthy(); warn.mockRestore();
  });

  it('lets a subscriber unsubscribe itself while the bump is delivering', () => {
    const calls: string[] = [];
    const stopFirst: () => void = onDecisionConfigurationChanged(() => { calls.push('first'); stopFirst(); });
    const stopSecond = onDecisionConfigurationChanged(() => calls.push('second'));
    bumpDecisionCredentialRevision();
    bumpDecisionCredentialRevision();
    expect(calls).toEqual(['first', 'second', 'second']);
    stopSecond();
  });
});
