import { beforeEach, describe, expect, it } from 'vitest';
import { sessionLeaseRegistry } from './session-lease-registry';

describe('sessionLeaseRegistry', () => {
  beforeEach(() => {
    sessionLeaseRegistry.resetForTesting();
  });

  it('issues a lease with an opaque startKey on spawn', () => {
    const lease = sessionLeaseRegistry.issueLease('session-1', { kind: 'claude' });
    expect(lease.sessionId).toBe('session-1');
    expect(lease.kind).toBe('claude');
    expect(lease.startKey).toMatch(/^sk_session-1_/);
    expect(lease.bornAtMs).toBeGreaterThan(0);

    const metrics = sessionLeaseRegistry.getMetrics();
    expect(metrics.issued).toBe(1);
    expect(metrics.activeCount).toBe(1);
  });

  it('authorizes kill with matching startKey', () => {
    const lease = sessionLeaseRegistry.issueLease('session-1', { kind: 'claude' });
    const auth = sessionLeaseRegistry.authorizeKill('session-1', lease.startKey);

    expect(auth.ok).toBe(true);
    expect(auth.lease).toEqual(lease);

    const metrics = sessionLeaseRegistry.getMetrics();
    expect(metrics.authorized).toBe(1);
    expect(metrics.refusedNoStartKey).toBe(0);
  });

  it('refuses kill without startKey with "no startKey on lease"', () => {
    sessionLeaseRegistry.issueLease('session-1', { kind: 'claude' });
    const auth = sessionLeaseRegistry.authorizeKill('session-1', undefined);

    expect(auth.ok).toBe(false);
    expect(auth.reason).toBe('no startKey on lease');

    const metrics = sessionLeaseRegistry.getMetrics();
    expect(metrics.refusedNoStartKey).toBe(1);
    expect(metrics.authorized).toBe(0);
  });

  it('refuses kill with mismatched/stale startKey with "startKey/live mismatch"', () => {
    sessionLeaseRegistry.issueLease('session-1', { kind: 'claude' });
    const auth = sessionLeaseRegistry.authorizeKill('session-1', 'sk_old_stale_key');

    expect(auth.ok).toBe(false);
    expect(auth.reason).toBe('startKey/live mismatch');

    const metrics = sessionLeaseRegistry.getMetrics();
    expect(metrics.refusedMismatch).toBe(1);
  });

  it('allows human operator bypass with force: true even with mismatched or absent startKey', () => {
    const lease = sessionLeaseRegistry.issueLease('session-1', { kind: 'claude' });
    const auth = sessionLeaseRegistry.authorizeKill('session-1', 'wrong-key', { force: true });

    expect(auth.ok).toBe(true);
    expect(auth.forced).toBe(true);
    expect(auth.lease).toEqual(lease);

    const metrics = sessionLeaseRegistry.getMetrics();
    expect(metrics.forced).toBe(1);
  });

  it('simulates the field race: stale kill arriving after respawn does NOT kill the live session', () => {
    // 1. Initial spawn
    const lease1 = sessionLeaseRegistry.issueLease('pane-42', { kind: 'codex' });
    expect(lease1.startKey).toBeDefined();

    // 2. Physical exit/respawn: previous process terminated and new one spawns
    sessionLeaseRegistry.revokeLease('pane-42');
    const lease2 = sessionLeaseRegistry.issueLease('pane-42', { kind: 'codex' });
    expect(lease2.startKey).not.toBe(lease1.startKey);

    // 3. Stale kill arrives with lease1's startKey
    const staleKillAuth = sessionLeaseRegistry.authorizeKill('pane-42', lease1.startKey);
    expect(staleKillAuth.ok).toBe(false);
    expect(staleKillAuth.reason).toBe('startKey/live mismatch');

    // Live session was NOT killed, active lease remains intact
    expect(sessionLeaseRegistry.inspectLease('pane-42')).toEqual(lease2);

    // 4. Valid kill with current startKey succeeds
    const validKillAuth = sessionLeaseRegistry.authorizeKill('pane-42', lease2.startKey);
    expect(validKillAuth.ok).toBe(true);
  });

  it('reaps stale leases exceeding maxAgeMs without condemning newer ones', () => {
    const now = 1_000_000;
    sessionLeaseRegistry.issueLease('session-stale', {
      kind: 'worker',
      bornAtMs: now - 30_000,
    });
    sessionLeaseRegistry.issueLease('session-fresh', {
      kind: 'worker',
      bornAtMs: now - 5_000,
    });

    const stale = sessionLeaseRegistry.reapStaleLeases(20_000, now);
    expect(stale.map((l) => l.sessionId)).toEqual(['session-stale']);
  });
});
