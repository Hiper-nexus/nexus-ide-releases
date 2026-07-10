import { z } from 'zod';
import {
  normalizeSyncEntities,
  syncProjectIdSchema,
  type SyncMutation,
  type SyncProjectState,
} from '../../../shared/sync-contract';
import {
  apiFetchAt,
  type ApiRequestInit,
  type ApiResult,
} from '../api-client';
import type { SyncBackend } from './sync-engine';

export type SyncBackendRequest = ApiRequestInit;
export type SyncBackendRequester = (
  path: string,
  init: SyncBackendRequest,
) => Promise<ApiResult>;

export interface HttpSyncBackendOptions {
  readonly baseUrl: string;
  readonly request?: SyncBackendRequester;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowInsecureLocalhostForTests?: boolean;
}

const serverTimeSchema = z.number().int().nonnegative();
const readEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        projectId: syncProjectIdSchema,
        revision: z.number().int().nonnegative(),
        entities: z.array(z.unknown()).max(1_000),
        serverTime: serverTimeSchema,
      })
      .strict(),
  })
  .strict();
const casEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        revision: z.number().int().positive(),
        serverTime: serverTimeSchema,
      })
      .strict(),
  })
  .strict();
const conflictEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    error: z.enum(['revision-conflict', 'entity-version-conflict']),
    conflict: z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        actualRevision: z.number().int().nonnegative(),
        conflictingEntityIds: z.array(z.string().min(1).max(320)).max(1_000),
        serverTime: serverTimeSchema,
      })
      .strict(),
  })
  .strict();
const quotaEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    error: z.literal('quota-exceeded'),
    quota: z
      .object({
        name: z.enum([
          'projects-per-account',
          'entities-per-project',
          'bytes-per-project',
        ]),
        limit: z.number().int().nonnegative(),
        actual: z.number().int().nonnegative(),
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
    throw new Error('sync backend URL is invalid', { cause: error });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('sync backend URL cannot contain credentials/query/fragment');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('sync backend URL must be an origin without a path');
  }
  const isLocalhost =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLocalhost && allowInsecureLocalhostForTests)
  ) {
    throw new Error('sync backend requires HTTPS (HTTP is test-localhost only)');
  }
  return url.origin;
}

export class SyncBackendUnavailableError extends Error {
  constructor() {
    super('sync backend unavailable');
    this.name = 'SyncBackendUnavailableError';
  }
}

export class SyncBackendQuotaError extends Error {
  readonly quota:
    | 'projects-per-account'
    | 'entities-per-project'
    | 'bytes-per-project';
  readonly limit: number;
  readonly actual: number;

  constructor(input: {
    quota:
      | 'projects-per-account'
      | 'entities-per-project'
      | 'bytes-per-project';
    limit: number;
    actual: number;
  }) {
    super(`sync backend quota exceeded: ${input.quota}`);
    this.name = 'SyncBackendQuotaError';
    this.quota = input.quota;
    this.limit = input.limit;
    this.actual = input.actual;
  }
}

export class HttpSyncBackend implements SyncBackend {
  readonly baseUrl: string;
  readonly #request: SyncBackendRequester;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: HttpSyncBackendOptions) {
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

  async read(projectId: string): Promise<SyncProjectState> {
    const project = syncProjectIdSchema.parse(projectId);
    const response = await this.#request(
      `/v1/sync/projects/${encodeURIComponent(project)}`,
      {
        method: 'GET',
        timeoutMs: this.#timeoutMs,
        maxResponseBytes: this.#maxResponseBytes,
      },
    );
    const parsed = readEnvelopeSchema.safeParse(response.json);
    if (
      response.status !== 200 ||
      !parsed.success ||
      parsed.data.data.projectId !== project
    ) {
      throw new SyncBackendUnavailableError();
    }
    return Object.freeze({
      revision: parsed.data.data.revision,
      entities: normalizeSyncEntities(parsed.data.data.entities),
    });
  }

  async compareAndSwap(
    projectId: string,
    expectedRevision: number,
    next: readonly SyncMutation[],
  ): Promise<boolean> {
    const project = syncProjectIdSchema.parse(projectId);
    const expected = z.number().int().nonnegative().parse(expectedRevision);
    const entities = normalizeSyncEntities(next);
    const response = await this.#request(
      `/v1/sync/projects/${encodeURIComponent(project)}`,
      {
        method: 'PUT',
        body: { expectedRevision: expected, entities },
        timeoutMs: this.#timeoutMs,
        maxResponseBytes: this.#maxResponseBytes,
      },
    );

    const success = casEnvelopeSchema.safeParse(response.json);
    if (
      response.status === 200 &&
      success.success &&
      success.data.data.revision === expected + 1
    ) {
      return true;
    }
    const conflict = conflictEnvelopeSchema.safeParse(response.json);
    if (
      response.status === 409 &&
      conflict.success &&
      conflict.data.conflict.expectedRevision === expected
    ) {
      return false;
    }
    const quota = quotaEnvelopeSchema.safeParse(response.json);
    if (response.status === 413 && quota.success) {
      throw new SyncBackendQuotaError({
        quota: quota.data.quota.name,
        limit: quota.data.quota.limit,
        actual: quota.data.quota.actual,
      });
    }
    throw new SyncBackendUnavailableError();
  }
}

export function createHttpSyncBackendFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): HttpSyncBackend | null {
  const baseUrl = env.NEXUS_SYNC_BACKEND_URL?.trim();
  if (!baseUrl) return null;
  const allowLocal =
    env.NODE_ENV === 'test' &&
    env.NEXUS_SYNC_ALLOW_INSECURE_LOCALHOST_TEST === '1';
  const backend = new HttpSyncBackend({
    baseUrl,
    allowInsecureLocalhostForTests: allowLocal,
  });
  const authOrigin = normalizedBaseUrl(
    env.NEXUS_BACKEND_URL ?? 'https://api.nexuside.app',
    allowLocal,
  );
  if (backend.baseUrl !== authOrigin) {
    throw new Error(
      'sync backend must share the same authenticated Nexus backend origin',
    );
  }
  return backend;
}
