import { LicenseError } from '../../shared/license-errors';
import { describe, expect, it } from 'vitest';
import {
  DistributedLeaseCoordinator,
  type LeaseAcquireResult,
  type LeaseBackend,
  type SharedScheduleLeaseRequest,
} from './distributed-lease';

const REQUEST: SharedScheduleLeaseRequest = {
  projectId: '31781d36-3f22-41b8-ad9d-8690c85d3343',
  scheduleId: '2a21a665-d7fd-45d5-b81f-41f433c665ad',
  definitionVersion: 1,
  definitionHash: 'a'.repeat(64),
  occurrenceAt: 1_800_000_000_000,
  ttlMs: 30_000,
};

class MemoryLeaseBackend implements LeaseBackend {
  lease: { token: string; expiresAt: number } | null = null;
  unavailable = false;
  now = 1_000;
  nextToken = 'lease-a';

  async acquire(request: SharedScheduleLeaseRequest): Promise<LeaseAcquireResult> {
    if (this.unavailable) throw new Error('offline');
    if (this.lease && this.lease.expiresAt > this.now) {
      return {
        acquired: false,
        reason: 'held-by-peer',
        retryAt: this.lease.expiresAt,
      };
    }
    this.lease = {
      token: this.nextToken,
      expiresAt: this.now + request.ttlMs,
    };
    return {
      acquired: true,
      token: this.lease.token,
      expiresAt: this.lease.expiresAt,
      reused: false,
    };
  }

  async renew(
    request: SharedScheduleLeaseRequest,
    token: string,
  ): Promise<LeaseAcquireResult> {
    if (this.unavailable) throw new Error('offline');
    if (
      !this.lease ||
      this.lease.token !== token ||
      this.lease.expiresAt <= this.now
    ) {
      return { acquired: false, reason: 'expired-or-not-owner' };
    }
    this.lease.expiresAt = this.now + request.ttlMs;
    return {
      acquired: true,
      token,
      expiresAt: this.lease.expiresAt,
      reused: true,
    };
  }

  async release(_request: SharedScheduleLeaseRequest, token: string): Promise<boolean> {
    if (this.unavailable) throw new Error('offline');
    if (!this.lease || this.lease.token !== token) return false;
    this.lease = null;
    return true;
  }
}

describe('DistributedLeaseCoordinator', () => {
  it('allows only one computer to run the same portable occurrence', async () => {
    const backend = new MemoryLeaseBackend();
    const pcA = new DistributedLeaseCoordinator(backend);
    const pcB = new DistributedLeaseCoordinator(backend);

    const first = await pcA.acquire(REQUEST);
    const second = await pcB.acquire(REQUEST);

    expect(first).toMatchObject({ acquired: true, token: 'lease-a' });
    expect(second).toMatchObject({ acquired: false, reason: 'held-by-peer' });
  });

  it('never runs a shared job when the lease backend is unavailable', async () => {
    const backend = new MemoryLeaseBackend();
    backend.unavailable = true;
    const coordinator = new DistributedLeaseCoordinator(backend);

    await expect(coordinator.acquire(REQUEST)).resolves.toMatchObject({
      acquired: false,
      reason: 'backend-unavailable',
    });
  });

  it('renews/releases only its opaque token and permits takeover after expiry', async () => {
    const backend = new MemoryLeaseBackend();
    const pcA = new DistributedLeaseCoordinator(backend);
    const pcB = new DistributedLeaseCoordinator(backend);
    await expect(pcA.acquire(REQUEST)).resolves.toMatchObject({ acquired: true });
    expect(await pcB.release(REQUEST, 'fabricated')).toBe(false);
    backend.now = 1_050;
    expect(await pcA.renew(REQUEST, 'lease-a')).toMatchObject({ acquired: true });
    backend.now = 31_051;
    backend.nextToken = 'lease-b';
    expect(await pcB.acquire(REQUEST)).toMatchObject({
      acquired: true,
      token: 'lease-b',
    });
  });

  it('does not interpret an opaque token as an identifier', async () => {
    const backend = new MemoryLeaseBackend();
    const opaque = 'base64/+== token with spaces';
    backend.nextToken = opaque;
    const coordinator = new DistributedLeaseCoordinator(backend);

    await expect(coordinator.acquire(REQUEST)).resolves.toMatchObject({
      acquired: true,
      token: opaque,
    });
    await expect(coordinator.renew(REQUEST, opaque)).resolves.toMatchObject({
      acquired: true,
      token: opaque,
    });
    await expect(coordinator.release(REQUEST, opaque)).resolves.toBe(true);
  });

  it('rejects a backend that substitutes the opaque token during renewal', async () => {
    const backend: LeaseBackend = {
      acquire: async () => ({
        acquired: true,
        token: 'right',
        expiresAt: 2_000,
        reused: false,
      }),
      renew: async () => ({
        acquired: true,
        token: 'substituted',
        expiresAt: 3_000,
        reused: true,
      }),
      release: async () => true,
    };
    const coordinator = new DistributedLeaseCoordinator(backend);
    await coordinator.acquire(REQUEST);
    await expect(coordinator.renew(REQUEST, 'right')).resolves.toEqual({
      acquired: false,
      reason: 'backend-unavailable',
    });
  });
});


it('preserves a license error instead of converting it to backend-unavailable', async () => {
  const backend = new MemoryLeaseBackend();
  backend.acquire = async () => { throw new LicenseError('license_access_denied', 'server-denied'); };
  const lease = new DistributedLeaseCoordinator(backend);
  await expect(lease.acquire(REQUEST)).rejects.toMatchObject({ code: 'license_access_denied' });
});
