import { z } from 'zod';

export interface SharedScheduleLeaseRequest {
  readonly projectId: string;
  readonly scheduleId: string;
  readonly definitionVersion: number;
  readonly definitionHash: string;
  readonly occurrenceAt: number;
  readonly ttlMs: number;
}

export type LeaseAcquireResult =
  | {
      readonly acquired: true;
      readonly token: string;
      readonly expiresAt: number;
      readonly reused: boolean;
    }
  | {
      readonly acquired: false;
      readonly reason:
        | 'held-by-peer'
        | 'concurrent-conflict'
        | 'backend-unavailable'
        | 'expired-or-not-owner'
        | 'definition-conflict';
      readonly retryAt?: number;
      readonly actualVersion?: number;
      readonly actualDefinitionHash?: string;
    };

/**
 * Remote authority contract. Implementations must make acquire atomic, mint
 * tokens server-side, persist only a token hash, and evaluate TTL in the
 * authority's clock. No read primitive exists because it would leak tokens.
 */
export interface LeaseBackend {
  acquire(request: SharedScheduleLeaseRequest): Promise<LeaseAcquireResult>;
  renew(
    request: SharedScheduleLeaseRequest,
    token: string,
  ): Promise<LeaseAcquireResult>;
  release(request: SharedScheduleLeaseRequest, token: string): Promise<boolean>;
}

const requestSchema = z
  .object({
    projectId: z.string().uuid(),
    scheduleId: z.string().uuid(),
    definitionVersion: z.number().int().positive().max(2_147_483_647),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    occurrenceAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ttlMs: z.number().int().min(1_000).max(24 * 60 * 60_000),
  })
  .strict();

const opaqueTokenSchema = z.string().min(1).max(4_096);
const acquireResultSchema = z.discriminatedUnion('acquired', [
  z
    .object({
      acquired: z.literal(true),
      token: opaqueTokenSchema,
      expiresAt: z.number().int().nonnegative(),
      reused: z.boolean(),
    })
    .strict(),
  z
    .object({
      acquired: z.literal(false),
      reason: z.enum([
        'held-by-peer',
        'concurrent-conflict',
        'backend-unavailable',
        'expired-or-not-owner',
        'definition-conflict',
      ]),
      retryAt: z.number().int().nonnegative().optional(),
      actualVersion: z.number().int().nonnegative().optional(),
      actualDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
    .strict(),
]);

function unavailable(): LeaseAcquireResult {
  return Object.freeze({ acquired: false, reason: 'backend-unavailable' });
}

function parsedResult(raw: unknown): LeaseAcquireResult {
  return Object.freeze(acquireResultSchema.parse(raw));
}

export class DistributedLeaseCoordinator {
  readonly #backend: LeaseBackend;

  constructor(backend: LeaseBackend) {
    if (!backend) throw new Error('distributed lease backend is required');
    this.#backend = backend;
  }

  async acquire(rawRequest: SharedScheduleLeaseRequest): Promise<LeaseAcquireResult> {
    const request = requestSchema.parse(rawRequest);
    try {
      return parsedResult(await this.#backend.acquire(request));
    } catch {
      return unavailable();
    }
  }

  async renew(
    rawRequest: SharedScheduleLeaseRequest,
    rawToken: string,
  ): Promise<LeaseAcquireResult> {
    const request = requestSchema.parse(rawRequest);
    const token = opaqueTokenSchema.safeParse(rawToken);
    if (!token.success) {
      return Object.freeze({ acquired: false, reason: 'expired-or-not-owner' });
    }
    try {
      const result = parsedResult(await this.#backend.renew(request, token.data));
      if (result.acquired && result.token !== token.data) return unavailable();
      return result;
    } catch {
      return unavailable();
    }
  }

  async release(
    rawRequest: SharedScheduleLeaseRequest,
    rawToken: string,
  ): Promise<boolean> {
    const request = requestSchema.parse(rawRequest);
    const token = opaqueTokenSchema.safeParse(rawToken);
    if (!token.success) return false;
    try {
      return (await this.#backend.release(request, token.data)) === true;
    } catch {
      return false;
    }
  }
}
