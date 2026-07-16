import { describe, expect, it } from 'vitest';
import {
  assertIdentityAllowlistNonEmpty,
  filterAllowedIdentityFingerprints,
  identityAllowlistIsWildcard,
} from './ssh-identity-filter';

describe('ssh-identity-filter', () => {
  it('filters allowlist case-sensitively (SHA-256 base64 is case-sensitive)', () => {
    // 'bb' must NOT match 'BB' — collapsing case would weaken pinning (H3/L17).
    expect(
      filterAllowedIdentityFingerprints(['AA', 'BB', 'CC'], ['bb', 'dd']),
    ).toEqual([]);
    expect(
      filterAllowedIdentityFingerprints(['AA', 'BB', 'CC'], ['BB', 'dd']),
    ).toEqual(['BB']);
  });

  it('normalizes the SHA256: prefix on both sides', () => {
    expect(
      filterAllowedIdentityFingerprints(['SHA256:abcDEF'], ['abcDEF']),
    ).toEqual(['SHA256:abcDEF']);
  });

  it('wildcard offers all available identities', () => {
    expect(identityAllowlistIsWildcard(['*'])).toBe(true);
    expect(filterAllowedIdentityFingerprints(['AA', 'BB'], ['*'])).toEqual([
      'AA',
      'BB',
    ]);
  });

  it('fail closed on empty allowlist', () => {
    expect(() => assertIdentityAllowlistNonEmpty([])).toThrow(/fail closed/);
  });
});
