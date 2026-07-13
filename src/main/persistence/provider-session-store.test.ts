import { describe, expect, it } from 'vitest';
import { sessionBelongsToAccount } from './provider-session-store';

describe('sessionBelongsToAccount', () => {
  it('allows legacy lookup when no account is requested', () => {
    expect(sessionBelongsToAccount('acc-a', undefined)).toBe(true);
    expect(sessionBelongsToAccount(null, undefined)).toBe(true);
  });

  it('rejects exact resume when stored owner differs from pin', () => {
    expect(sessionBelongsToAccount('acc-a', 'acc-b')).toBe(false);
    expect(sessionBelongsToAccount(null, 'acc-b')).toBe(false);
    expect(sessionBelongsToAccount(undefined, 'acc-b')).toBe(false);
  });

  it('allows exact resume only when owners match', () => {
    expect(sessionBelongsToAccount('acc-b', 'acc-b')).toBe(true);
  });
});
