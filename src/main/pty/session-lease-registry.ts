import { randomBytes } from 'node:crypto';

export interface SessionLease {
  readonly sessionId: string;
  readonly startKey: string;
  readonly bornAtMs: number;
  readonly kind: string;
}

export type LeaseRefusalReason =
  | 'no startKey on lease'
  | 'startKey/live mismatch';

export interface AuthorizeKillResult {
  readonly ok: boolean;
  readonly reason?: LeaseRefusalReason;
  readonly forced?: boolean;
  readonly lease?: SessionLease;
}

export interface SessionLeaseMetrics {
  issued: number;
  authorized: number;
  forced: number;
  refusedNoStartKey: number;
  refusedMismatch: number;
  revoked: number;
  activeCount: number;
}

export interface IssueLeaseOptions {
  kind?: string;
  bornAtMs?: number;
  startKey?: string;
}

export interface AuthorizeKillOptions {
  force?: boolean;
}

class SessionLeaseRegistry {
  private readonly leases = new Map<string, SessionLease>();
  private readonly metrics: SessionLeaseMetrics = {
    issued: 0,
    authorized: 0,
    forced: 0,
    refusedNoStartKey: 0,
    refusedMismatch: 0,
    revoked: 0,
    activeCount: 0,
  };

  /**
   * Generates a unique opaque startKey proof for a physical spawn.
   */
  private generateStartKey(sessionId: string, bornAtMs: number): string {
    const nonce = randomBytes(6).toString('hex');
    return `sk_${sessionId.slice(0, 16)}_${bornAtMs.toString(36)}_${nonce}`;
  }

  /**
   * Issues a new lease for a physical session spawn.
   */
  issueLease(sessionId: string, options: IssueLeaseOptions = {}): SessionLease {
    const bornAtMs = options.bornAtMs ?? Date.now();
    const kind = options.kind ?? 'unknown';
    const startKey =
      options.startKey ?? this.generateStartKey(sessionId, bornAtMs);

    const lease: SessionLease = {
      sessionId,
      startKey,
      bornAtMs,
      kind,
    };

    this.leases.set(sessionId, lease);
    this.metrics.issued += 1;
    this.metrics.activeCount = this.leases.size;
    return lease;
  }

  /**
   * Validates whether a kill request is authorized for the given session.
   *
   * 1. If options.force is true (e.g. human operator closes tab), kill is authorized.
   * 2. If no startKey is supplied, returns { ok: false, reason: 'no startKey on lease' }.
   * 3. If startKey does not match the active lease for sessionId, returns
   *    { ok: false, reason: 'startKey/live mismatch' }.
   */
  authorizeKill(
    sessionId: string,
    startKey?: string,
    options: AuthorizeKillOptions = {},
  ): AuthorizeKillResult {
    const lease = this.leases.get(sessionId);

    if (options.force) {
      this.metrics.forced += 1;
      return { ok: true, forced: true, lease };
    }

    if (!startKey || startKey.trim().length === 0) {
      this.metrics.refusedNoStartKey += 1;
      return { ok: false, reason: 'no startKey on lease', lease };
    }

    if (!lease || lease.startKey !== startKey) {
      this.metrics.refusedMismatch += 1;
      return { ok: false, reason: 'startKey/live mismatch', lease };
    }

    this.metrics.authorized += 1;
    return { ok: true, lease };
  }

  /**
   * Revokes an active lease when a session process finalizes or is explicitly destroyed.
   */
  revokeLease(sessionId: string): boolean {
    const existed = this.leases.delete(sessionId);
    if (existed) {
      this.metrics.revoked += 1;
      this.metrics.activeCount = this.leases.size;
    }
    return existed;
  }

  /**
   * Inspects lease info for diagnostics.
   */
  inspectLease(sessionId: string): SessionLease | null {
    return this.leases.get(sessionId) ?? null;
  }

  /**
   * Lists all active leases in the registry.
   */
  listLeases(): readonly SessionLease[] {
    return Array.from(this.leases.values());
  }

  /**
   * Finds leases whose age exceeds maxAgeMs.
   */
  reapStaleLeases(
    maxAgeMs: number,
    now: number = Date.now(),
  ): readonly SessionLease[] {
    const stale: SessionLease[] = [];
    for (const lease of this.leases.values()) {
      if (now - lease.bornAtMs >= maxAgeMs) {
        stale.push(lease);
      }
    }
    return stale;
  }

  /**
   * Returns current telemetry metrics snapshot.
   */
  getMetrics(): SessionLeaseMetrics {
    return { ...this.metrics, activeCount: this.leases.size };
  }

  /**
   * Resets registry state for test suites.
   */
  resetForTesting(): void {
    this.leases.clear();
    this.metrics.issued = 0;
    this.metrics.authorized = 0;
    this.metrics.forced = 0;
    this.metrics.refusedNoStartKey = 0;
    this.metrics.refusedMismatch = 0;
    this.metrics.revoked = 0;
    this.metrics.activeCount = 0;
  }
}

export const sessionLeaseRegistry = new SessionLeaseRegistry();
