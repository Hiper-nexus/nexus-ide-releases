import { resetLicensedAccessMock } from '../__tests__/licensed-access';
beforeEach(resetLicensedAccessMock);
import { beforeEach } from 'vitest';
import { expect, it, vi } from 'vitest';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({ acpCustomHarnesses: [] }), replaceOrchSettings: vi.fn() }));
vi.mock('./acp-client', () => ({ AcpClient: { spawn: vi.fn(() => { throw new Error('should not spawn'); }) }, AcpClientError: Error }));
import { requireAccess } from '../license-access';
import { probeAcpHarness } from './harness-store';
import { PRESET_HARNESSES } from '../../shared/harness-catalog';
import { AcpClient } from './acp-client';
it('probe refuses before spawning when blocked', async () => {
  vi.mocked(requireAccess).mockReturnValue({ ok: false, reason: 'trial-ended' });
  expect(await probeAcpHarness(PRESET_HARNESSES[0].id)).toMatchObject({ ok: false, code: 'license_access_denied' });
  expect(AcpClient.spawn).not.toHaveBeenCalled();
});
