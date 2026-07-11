import { describe, expect, it } from 'vitest';
import { FollowUpAuthority } from './follow-up-authority';

describe('FollowUpAuthority', () => {
  it('autoriza somente dentro do deadline monotônico', () => {
    const authority = new FollowUpAuthority();
    authority.arm(1_000, 8_000);
    expect(authority.isAuthorized(8_999)).toBe(true);
    expect(authority.isAuthorized(9_000)).toBe(false);
    expect(authority.remainingMs(9_001)).toBe(0);
  });

  it('clear revoga autoridade sem derrubar o socket', () => {
    const authority = new FollowUpAuthority();
    authority.arm(100, 8_000);
    authority.clear();
    expect(authority.isAuthorized(101)).toBe(false);
  });
});
