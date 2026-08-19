import { describe, expect, it } from 'vitest';
import { autoSeatReadiness, isLiveSeat } from './auth-readiness';

describe('auth-readiness', () => {
  it('só present é assento vivo', () => {
    expect(isLiveSeat('present')).toBe(true);
    expect(isLiveSeat('incomplete')).toBe(false);
    expect(isLiveSeat('no-credential')).toBe(false);
    expect(isLiveSeat(undefined)).toBe(false);
  });

  it('usa readiness explícito quando existir', () => {
    expect(
      autoSeatReadiness({
        readiness: 'incomplete',
        authStrategy: 'subscription',
      }),
    ).toBe('incomplete');
  });

  it('subscription/credentialless/api-key+hasKey → present', () => {
    expect(autoSeatReadiness({ authStrategy: 'subscription' })).toBe('present');
    expect(autoSeatReadiness({ authStrategy: 'credentialless' })).toBe(
      'present',
    );
    expect(autoSeatReadiness({ authStrategy: 'api-key', hasKey: true })).toBe(
      'present',
    );
    expect(autoSeatReadiness({ authStrategy: 'api-key' })).toBe('no-credential');
    expect(autoSeatReadiness({ authStrategy: 'login-needed' })).toBe(
      'no-credential',
    );
  });
});
