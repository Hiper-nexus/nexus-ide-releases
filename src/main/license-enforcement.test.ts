import { describe, expect, it } from 'vitest';
import { createLicenseAdmission } from './license-enforcement';
import { LicenseError } from '../shared/license-errors';

function setup(max: number | null = 2) {
  let allowed = true;
  return { block: () => { allowed = false; }, admission: createLicenseAdmission({
    requireAccess: () => allowed ? { ok: true } : { ok: false, reason: 'trial-ended' },
    maxAgents: () => max,
  }) };
}
describe('license agent admission', () => {
  it('denies use before reserving and cannot be disabled by the pane guard', () => {
    const { admission, block } = setup();
    block();
    expect(() => admission.reserveAgent()).toThrowError(expect.objectContaining({ code: 'license_access_denied', reason: 'trial-ended' }));
    expect(admission.activeAgents()).toBe(0);
  });
  it('counts PTY, ACP, initialization reservations and idle/headless sessions equally; release is idempotent', () => {
    const { admission } = setup();
    const pty = admission.reserveAgent(), acp = admission.reserveAgent();
    expect(() => admission.reserveAgent()).toThrow('Você já está usando os 2 agentes');
    pty(); pty();
    const replacement = admission.reserveAgent();
    expect(admission.activeAgents()).toBe(2);
    acp(); replacement();
    expect(admission.activeAgents()).toBe(0);
  });
  it('admits exactly one concurrent claimant for the last slot', async () => {
    const { admission } = setup();
    const release = admission.reserveAgent();
    const outcomes = await Promise.allSettled([Promise.resolve().then(() => admission.reserveAgent()), Promise.resolve().then(() => admission.reserveAgent())]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
    release();
    for (const result of outcomes) if (result.status === 'fulfilled') result.value();
  });
  it('null is unlimited, while a shell/use check consumes no agent slot', () => {
    const { admission } = setup(null);
    admission.assertAccess('use');
    expect(admission.activeAgents()).toBe(0);
    const releases = Array.from({ length: 50 }, () => admission.reserveAgent());
    expect(admission.activeAgents()).toBe(50);
    releases.forEach(release => release());
  });
  it('license messages never match terminal authority recovery patterns', () => {
    const messages = [new LicenseError('license_access_denied', 'license-expired').message, new LicenseError('license_agent_limit', undefined, 2).message];
    for (const message of messages) expect(message).not.toMatch(/persisted mission pane authority|unknown or expired|orchestration spawn request/i);
  });
});
