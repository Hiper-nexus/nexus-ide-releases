import { expect, it } from 'vitest';
import { LicenseError, licenseErrorFrom, licenseFailure } from './license-errors';
it('preserves typed errors and recovers the stable code after IPC has copied only the message', () => {
  const original = new LicenseError('license_agent_limit', undefined, 2);
  expect(licenseErrorFrom(original)).toBe(original);
  expect(licenseFailure(new Error(original.message))).toMatchObject({ code: 'license_agent_limit', error: original.message });
  expect(licenseErrorFrom('some other failure')).toBeNull();
});
