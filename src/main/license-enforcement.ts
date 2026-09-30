/** Hard product gates, independent of pane-admission and all environment switches.
 * One synchronous reservation per physical PTY/ACP child, retained through idle,
 * headless/parked presentation and async initialization. Only physical finalization
 * or a spawn that never created a child may release it. Adopting a child reuses it.
 */
import { requireAccess, maxAgents, getAccessState, type AccessDecision } from './license-access';
import { LicenseError } from '../shared/license-errors';

export function createLicenseAdmission(policy: {
  requireAccess: (capability: 'use' | 'cloudSync') => AccessDecision;
  maxAgents: () => number | null;
}) {
  let agents = 0;
  function assertAccess(capability: 'use' | 'cloudSync' = 'use'): void {
    const result = policy.requireAccess(capability);
    if (!result.ok) throw new LicenseError('license_access_denied', result.reason);
  }
  function assertAgentCapacity(): void {
    assertAccess();
    const limit = policy.maxAgents();
    if (limit !== null && agents >= limit) throw new LicenseError('license_agent_limit', undefined, limit);
  }
  return {
    assertAccess, assertAgentCapacity,
    activeAgents: () => agents,
    reserveAgent(): () => void {
      assertAgentCapacity();
      agents += 1;
      let released = false;
      return () => { if (!released) { released = true; agents -= 1; } };
    },
  };
}
const admission = createLicenseAdmission({ requireAccess, maxAgents });
export const assertLicenseAccess = admission.assertAccess;
export const assertLicensedAgentCapacity = admission.assertAgentCapacity;
export const reserveLicensedAgent = admission.reserveAgent;
export const licensedAgentCount = admission.activeAgents;
export function assertRemoteLicenseAccess(): void {
  assertLicenseAccess();
  if (getAccessState().access === 'trial') throw new LicenseError('license_access_denied', 'remote-trial-unavailable');
}
export function assertLicenseResponse(status: number): void {
  if (status === 403) throw new LicenseError('license_access_denied', 'server-denied');
}
