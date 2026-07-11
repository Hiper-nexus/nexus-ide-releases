import { describe, expect, it } from 'vitest';
import {
  assertIdentityAllowlistNonEmpty,
  filterAllowedIdentityFingerprints,
} from './ssh-identity-filter';

describe('ssh-identity-filter', () => {
  it('filters allowlist', () => {
    expect(
      filterAllowedIdentityFingerprints(['AA', 'BB', 'CC'], ['bb', 'dd']),
    ).toEqual(['BB']);
  });

  it('fail closed on empty allowlist', () => {
    expect(() => assertIdentityAllowlistNonEmpty([])).toThrow(/fail closed/);
  });
});
