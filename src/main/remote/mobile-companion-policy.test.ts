import { describe, expect, it } from 'vitest';
import {
  authorizeMobileRpc,
  isDestructiveMobileRpc,
} from './mobile-companion-policy';

describe('mobile-companion-policy', () => {
  it('allows read RPCs when device active', () => {
    expect(
      authorizeMobileRpc({ kind: 'pane.list', deviceActive: true }),
    ).toEqual({ allowed: true, requiresConfirmation: false });
    expect(
      authorizeMobileRpc({ kind: 'mission.list', deviceActive: true }),
    ).toEqual({ allowed: true, requiresConfirmation: false });
    expect(
      authorizeMobileRpc({ kind: 'ops.snapshot', deviceActive: true }),
    ).toEqual({ allowed: true, requiresConfirmation: false });
  });

  it('fails closed when device revoked', () => {
    expect(
      authorizeMobileRpc({ kind: 'pane.list', deviceActive: false }),
    ).toEqual({ allowed: false, reason: 'device-revoked' });
  });

  it('requires confirmation for destructive writes', () => {
    expect(
      authorizeMobileRpc({ kind: 'fs.delete', deviceActive: true }),
    ).toEqual({ allowed: false, reason: 'destructive-confirmation-required' });
    expect(
      authorizeMobileRpc({
        kind: 'fs.delete',
        deviceActive: true,
        deviceConfirmed: true,
      }),
    ).toEqual({ allowed: true, requiresConfirmation: true });
    expect(isDestructiveMobileRpc('git.push')).toBe(true);
  });

  it('never allows mission.complete from mobile', () => {
    expect(
      authorizeMobileRpc({
        kind: 'mission.complete',
        deviceActive: true,
        deviceConfirmed: true,
      }),
    ).toEqual({ allowed: false, reason: 'mission-complete-not-allowed-on-mobile' });
  });
});
