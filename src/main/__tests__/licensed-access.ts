/** Unit fixtures explicitly run as Pro unless a test exercises a denied/trial state. */
import { vi } from 'vitest';
import { DEFAULT_LICENSE, type LicenseState } from '../../shared/billing-types';
import type { AccessDecision } from '../license-access';
export const licensedAccessMock = {
  requireAccess: vi.fn<() => AccessDecision>(() => ({ ok: true })),
  maxAgents: vi.fn<() => number | null>(() => null),
  getAccessState: vi.fn<() => LicenseState>(() => ({ ...DEFAULT_LICENSE, plan: 'pro', status: 'active', expiresAt: new Date(Date.now() + 3600000).toISOString(), access: 'pro', verified: true, canUseApp: true, blockedReason: null, limits: { maxAgents: null, cloudSync: true } })),
  applyLicenseToken: vi.fn(() => ({ ok: true })),
  applyOnlineLicenseToken: vi.fn(() => ({ ok: true })),
  onAccessChanged: vi.fn(() => () => {}),
  clearAccess: vi.fn(),
};
export function resetLicensedAccessMock(): void {
  licensedAccessMock.requireAccess.mockReset().mockReturnValue({ ok: true });
  licensedAccessMock.maxAgents.mockReset().mockReturnValue(null);
  licensedAccessMock.getAccessState.mockReset().mockReturnValue({ ...DEFAULT_LICENSE, plan: 'pro', status: 'active', expiresAt: new Date(Date.now() + 3600000).toISOString(), access: 'pro', verified: true, canUseApp: true, blockedReason: null, limits: { maxAgents: null, cloudSync: true } });
}
