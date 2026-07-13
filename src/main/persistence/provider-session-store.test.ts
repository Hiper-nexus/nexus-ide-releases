import { describe, expect, it } from 'vitest';
import { sessionBelongsToAccount } from './provider-session-store';

describe('sessionBelongsToAccount', () => {
  it('fail-closed: owned row without pin is denied', () => {
    expect(sessionBelongsToAccount('acc-a', undefined)).toBe(false);
    expect(sessionBelongsToAccount('acc-a', null)).toBe(false);
    expect(sessionBelongsToAccount('acc-a', '')).toBe(false);
  });

  it('fail-closed: pin without stored owner is denied', () => {
    expect(sessionBelongsToAccount(null, 'acc-b')).toBe(false);
    expect(sessionBelongsToAccount(undefined, 'acc-b')).toBe(false);
  });

  it('allows exact resume only when owners match', () => {
    expect(sessionBelongsToAccount('acc-b', 'acc-b')).toBe(true);
    expect(sessionBelongsToAccount('acc-a', 'acc-b')).toBe(false);
  });

  it('allows legacy unowned rows only when caller also has no pin', () => {
    expect(sessionBelongsToAccount(null, undefined)).toBe(true);
    expect(sessionBelongsToAccount(undefined, null)).toBe(true);
  });
});
