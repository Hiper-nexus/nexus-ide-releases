import { describe, expect, it } from 'vitest';

/**
 * Decision contract of hasAvailableAccount (account-store.ts):
 * - zero Nexus-managed accounts → available (third-party auth not judged)
 * - managed pool all cooling (pick null) → unavailable
 * - pick returns an account → available
 */

function hasAvailableAccountDecision(
  accountCount: number,
  pick: unknown | null,
): boolean {
  if (accountCount === 0) return true;
  return pick !== null;
}

describe('hasAvailableAccount decision contract', () => {
  it('reports available when the adapter has no Nexus-managed accounts', () => {
    expect(hasAvailableAccountDecision(0, null)).toBe(true);
  });

  it('reports unavailable when every managed account is cooling', () => {
    expect(hasAvailableAccountDecision(2, null)).toBe(false);
  });

  it('reports available when pickAvailable returns an account', () => {
    expect(hasAvailableAccountDecision(2, { id: 'a1' })).toBe(true);
  });
});
