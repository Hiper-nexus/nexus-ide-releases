import { expect, it } from 'vitest';
import { LicenseError, licenseErrorFrom, licenseFailure } from './license-errors';
it('preserves typed errors and recovers the stable code after IPC has copied only the message', () => {
  const original = new LicenseError('license_agent_limit', undefined, 2);
  expect(licenseErrorFrom(original)).toBe(original);
  expect(licenseFailure(new Error(original.message))).toMatchObject({ code: 'license_agent_limit', error: original.message });
  expect(licenseErrorFrom('some other failure')).toBeNull();
});

it.each(['login-required', 'trial-ended', 'suspended', 'inactive', 'license-expired', 'verification-unavailable', 'invalid-license', 'account-mismatch', 'cloud-sync-disabled', 'remote-trial-unavailable', 'server-denied'] as const)('B1: recovers %s after Electron keeps only the message', reason => {
  const original = new LicenseError('license_access_denied', reason);
  const wrapped = new Error(`Error invoking remote method 'pty:spawn': Error: ${original.message}`);
  expect(licenseErrorFrom(wrapped)?.reason).toBe(reason);
  expect(licenseFailure(wrapped)?.blockedReason).toBe(reason);
});
it('B1: preserves the numeric trial limit after message serialization', () => {
  const original = new LicenseError('license_agent_limit', undefined, 2);
  expect(licenseErrorFrom(original.message)?.limit).toBe(2);
});
