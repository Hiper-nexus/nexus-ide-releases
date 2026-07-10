import { z } from 'zod';
import {
  apiFetchAt,
  type ApiRequestInit,
  type ApiResult,
} from '../api-client';
import type {
  LeaseAcquireResult,
  LeaseBackend,
  SharedScheduleLeaseRequest,
} from '../context/distributed-lease';
import {
  portableCronDefinitionSchema,
  portableProjectIdSchema,
  portableScheduleIdSchema,
  type PortableCronDefinition,
  type PortableCronScheduleBackend,
  type PublishPortableScheduleResult,
} from './portable-cron-definition';

export type CronBackendRequest = ApiRequestInit;
export type CronBackendRequester = (
  path: string,
  init: CronBackendRequest,
) => Promise<ApiResult>;

export interface HttpCronBackendOptions {
  readonly baseUrl: string;
  readonly request?: CronBackendRequester;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowInsecureLocalhostForTests?: boolean;
}

const leaseSuccessSchema = z
  .object({
    acquired: z.literal(true),
    token: z.string().min(1).max(4_096),
    expiresAt: z.number().int().nonnegative(),
    reused: z.boolean(),
  })
  .strict();
const leaseDeniedSchema = z
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
  .strict();
const leaseEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    data: z.union([leaseSuccessSchema, leaseDeniedSchema]),
  })
  .strict();
const releaseEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    data: z.object({ released: z.boolean() }).strict(),
  })
  .strict();
const portableScheduleSchema = z
  .object({
    projectId: portableProjectIdSchema,
    scheduleId: portableScheduleIdSchema,
    version: z.number().int().positive(),
    definition: portableCronDefinitionSchema,
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
const listEnvelopeSchema = z
  .object({ ok: z.literal(true), data: z.array(portableScheduleSchema).max(10_000) })
  .strict();
const publishEnvelopeSchema = z
  .object({ ok: z.literal(true), data: portableScheduleSchema })
  .strict();
const conflictEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    error: z.literal('version-conflict'),
    conflict: z
      .object({
        expectedVersion: z.number().int().nonnegative(),
        actualVersion: z.number().int().nonnegative(),
        current: portableScheduleSchema.nullable(),
      })
      .strict(),
  })
  .strict();

function normalizedBaseUrl(
  raw: string,
  allowInsecureLocalhostForTests: boolean,
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error('cron backend URL is invalid', { cause: error });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('cron backend URL cannot contain credentials/query/fragment');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('cron backend URL must be an origin without a path');
  }
  const isLocalhost =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLocalhost && allowInsecureLocalhostForTests)
  ) {
    throw new Error('cron backend requires HTTPS (HTTP is test-localhost only)');
  }
  return url.origin;
}

function unavailable(): LeaseAcquireResult {
  return { acquired: false, reason: 'backend-unavailable' };
}

export class HttpCronBackend
  implements LeaseBackend, PortableCronScheduleBackend
{
  readonly baseUrl: string;
  readonly #request: CronBackendRequester;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: HttpCronBackendOptions) {
    this.baseUrl = normalizedBaseUrl(
      options.baseUrl,
      options.allowInsecureLocalhostForTests === true,
    );
    this.#timeoutMs = z
      .number()
      .int()
      .min(500)
      .max(30_000)
      .parse(options.timeoutMs ?? 5_000);
    this.#maxResponseBytes = z
      .number()
      .int()
      .min(1_024)
      .max(1024 * 1024)
      .parse(options.maxResponseBytes ?? 256 * 1024);
    this.#request =
      options.request ??
      ((path, init) => apiFetchAt(this.baseUrl, path, init));
  }

  acquire(request: SharedScheduleLeaseRequest): Promise<LeaseAcquireResult> {
    return this.#lease('/v1/cron/leases/acquire', request);
  }

  renew(
    request: SharedScheduleLeaseRequest,
    token: string,
  ): Promise<LeaseAcquireResult> {
    return this.#lease('/v1/cron/leases/renew', { ...request, token });
  }

  async release(
    request: SharedScheduleLeaseRequest,
    token: string,
  ): Promise<boolean> {
    const response = await this.#call('/v1/cron/leases/release', {
      ...request,
      token,
    });
    const parsed = releaseEnvelopeSchema.safeParse(response.json);
    return response.status === 200 && parsed.success && parsed.data.data.released;
  }

  async list(projectId: string) {
    const project = portableProjectIdSchema.parse(projectId);
    const response = await this.#request(
      `/v1/cron/projects/${encodeURIComponent(project)}/schedules`,
      {
        method: 'GET',
        timeoutMs: this.#timeoutMs,
        maxResponseBytes: this.#maxResponseBytes,
      },
    );
    const parsed = listEnvelopeSchema.safeParse(response.json);
    return response.status === 200 && parsed.success
      ? { ok: true as const, schedules: parsed.data.data }
      : { ok: false as const, reason: 'backend-unavailable' as const };
  }

  async publish(
    projectId: string,
    scheduleId: string,
    expectedVersion: number,
    definition: PortableCronDefinition,
  ): Promise<PublishPortableScheduleResult> {
    const project = portableProjectIdSchema.parse(projectId);
    const schedule = portableScheduleIdSchema.parse(scheduleId);
    const version = z.number().int().nonnegative().parse(expectedVersion);
    const portable = portableCronDefinitionSchema.parse(definition);
    const response = await this.#request(
      `/v1/cron/projects/${encodeURIComponent(project)}/schedules/${encodeURIComponent(schedule)}`,
      {
        method: 'PUT',
        body: { expectedVersion: version, definition: portable },
        timeoutMs: this.#timeoutMs,
        maxResponseBytes: this.#maxResponseBytes,
      },
    );
    const success = publishEnvelopeSchema.safeParse(response.json);
    if ((response.status === 200 || response.status === 201) && success.success) {
      return {
        ok: true,
        created: response.status === 201,
        schedule: success.data.data,
      };
    }
    const conflict = conflictEnvelopeSchema.safeParse(response.json);
    if (response.status === 409 && conflict.success) {
      return {
        ok: false,
        reason: 'version-conflict',
        expectedVersion: conflict.data.conflict.expectedVersion,
        actualVersion: conflict.data.conflict.actualVersion,
        current: conflict.data.conflict.current,
      };
    }
    return {
      ok: false,
      reason: 'backend-unavailable',
      expectedVersion: version,
      actualVersion: 0,
      current: null,
    };
  }

  async #lease(path: string, body: unknown): Promise<LeaseAcquireResult> {
    const response = await this.#call(path, body);
    const parsed = leaseEnvelopeSchema.safeParse(response.json);
    if ((response.status !== 200 && response.status !== 409) || !parsed.success) {
      return unavailable();
    }
    return parsed.data.data;
  }

  #call(path: string, body: unknown): Promise<ApiResult> {
    return this.#request(path, {
      method: 'POST',
      body,
      timeoutMs: this.#timeoutMs,
      maxResponseBytes: this.#maxResponseBytes,
    });
  }
}

export function createHttpCronBackendFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): HttpCronBackend | null {
  const baseUrl = env.NEXUS_CRON_BACKEND_URL?.trim();
  if (!baseUrl) return null;
  const allowLocal =
    env.NODE_ENV === 'test' &&
    env.NEXUS_CRON_ALLOW_INSECURE_LOCALHOST_TEST === '1';
  const backend = new HttpCronBackend({
    baseUrl,
    allowInsecureLocalhostForTests: allowLocal,
  });
  const authOrigin = normalizedBaseUrl(
    env.NEXUS_BACKEND_URL ?? 'https://api.nexuside.app',
    allowLocal,
  );
  if (backend.baseUrl !== authOrigin) {
    throw new Error(
      'cron backend must share the authenticated Nexus backend origin',
    );
  }
  return backend;
}
