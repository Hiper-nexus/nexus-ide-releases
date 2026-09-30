import { resolveBackendUrl } from '../backend-url';
vi.mock('../backend-url', async (original) => { const mod = await original<typeof import('../backend-url')>(); return { ...mod, resolveBackendUrl: vi.fn(mod.resolveBackendUrl) }; });
import { resetLicensedAccessMock } from '../__tests__/licensed-access';
beforeEach(resetLicensedAccessMock);
import { beforeEach } from 'vitest';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api-client';
import {
  HttpCronBackend,
  createHttpCronBackendFromEnvironment,
  type CronBackendRequest,
} from './http-cron-backend';
import {
  cronDefinitionHash,
  type PortableCronDefinition,
} from './portable-cron-definition';

const PROJECT_ID = '31781d36-3f22-41b8-ad9d-8690c85d3343';
const SCHEDULE_ID = '2a21a665-d7fd-45d5-b81f-41f433c665ad';

const definition: PortableCronDefinition = {
  schemaVersion: 1,
  name: 'Nightly review',
  schedule: '0 0 * * *',
  brief: 'review code',
  target: { kind: 'agent', id: 'reviewer' },
  status: 'active',
};

function lease() {
  return {
    projectId: PROJECT_ID,
    scheduleId: SCHEDULE_ID,
    definitionVersion: 1,
    definitionHash: cronDefinitionHash(definition),
    occurrenceAt: 1_800_000_000_000,
    ttlMs: 90_000,
  };
}

function response(json: unknown, status = 200): ApiResult {
  return { status, json };
}

describe('HttpCronBackend transport policy', () => {
  it('requires TLS and permits insecure localhost only behind the explicit test flag', () => {
    expect(
      () => new HttpCronBackend({ baseUrl: 'http://cron.example.test' }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new HttpCronBackend({
          baseUrl: 'http://127.0.0.1:8080',
          allowInsecureLocalhostForTests: true,
        }),
    ).not.toThrow();
    expect(
      () =>
        new HttpCronBackend({
          baseUrl: 'http://192.168.1.20:8080',
          allowInsecureLocalhostForTests: true,
        }),
    ).toThrow(/HTTPS/);
  });

  it('is opt-in and never claims a backend when the URL is absent', () => {
    expect(createHttpCronBackendFromEnvironment({})).toBeNull();
    expect(() =>
      createHttpCronBackendFromEnvironment({
        NEXUS_CRON_BACKEND_URL: 'https://attacker.example',
        NEXUS_BACKEND_URL: 'https://api.nexuside.app',
      }),
    ).toThrow(/authenticated Nexus backend origin/);
    expect(
      createHttpCronBackendFromEnvironment({
        NODE_ENV: 'test',
        NEXUS_BACKEND_URL: 'http://127.0.0.1:8080',
        NEXUS_CRON_BACKEND_URL: 'http://127.0.0.1:8080',
        NEXUS_CRON_ALLOW_INSECURE_LOCALHOST_TEST: '1',
      }),
    ).toBeInstanceOf(HttpCronBackend);
  });

  it('sends only portable lease coordinates with a bounded request', async () => {
    const request = vi.fn<
      (path: string, init: CronBackendRequest) => Promise<ApiResult>
    >(async () =>
      response({
        ok: true,
        data: {
          acquired: true,
          token: 'opaque/+ token',
          expiresAt: 1_800_000_090_000,
          reused: false,
        },
      }),
    );
    const backend = new HttpCronBackend({
      baseUrl: 'https://cron.example.test',
      request,
      timeoutMs: 4_000,
      maxResponseBytes: 32_000,
    });

    await expect(backend.acquire(lease())).resolves.toMatchObject({
      acquired: true,
      token: 'opaque/+ token',
    });
    expect(request).toHaveBeenCalledWith(
      '/v1/cron/leases/acquire',
      expect.objectContaining({
        method: 'POST',
        body: lease(),
        timeoutMs: 4_000,
        maxResponseBytes: 32_000,
      }),
    );
    const serialized = JSON.stringify(request.mock.calls[0][1].body);
    expect(serialized).not.toMatch(/installation|checkout|workspace|rootRealPath/);
  });

  it('maps timeout/offline and malformed authority responses to fail-closed unavailability', async () => {
    const offline = new HttpCronBackend({
      baseUrl: 'https://cron.example.test',
      request: async () => response(null, 0),
    });
    await expect(offline.acquire(lease())).resolves.toEqual({
      acquired: false,
      reason: 'backend-unavailable',
    });

    const malformed = new HttpCronBackend({
      baseUrl: 'https://cron.example.test',
      request: async () => response({ ok: true, data: { acquired: true } }),
    });
    await expect(malformed.acquire(lease())).resolves.toEqual({
      acquired: false,
      reason: 'backend-unavailable',
    });
  });

  it('round-trips the exact opaque token for renew and release', async () => {
    const token = 'opaque/+== token';
    const request = vi.fn<
      (path: string, init: CronBackendRequest) => Promise<ApiResult>
    >(async (path: string, _init: CronBackendRequest) => {
      if (path.endsWith('/release')) {
        return response({ ok: true, data: { released: true } });
      }
      return response({
        ok: true,
        data: {
          acquired: true,
          token,
          expiresAt: 1_800_000_090_000,
          reused: true,
        },
      });
    });
    const backend = new HttpCronBackend({
      baseUrl: 'https://cron.example.test',
      request,
    });

    await expect(backend.renew(lease(), token)).resolves.toMatchObject({
      acquired: true,
      token,
    });
    await expect(backend.release(lease(), token)).resolves.toBe(true);
    expect(request.mock.calls[0][1]?.body).toMatchObject({ token });
    expect(request.mock.calls[1][1]?.body).toMatchObject({ token });
  });

  it('publishes definitions with CAS and exposes version conflicts', async () => {
    const hash = cronDefinitionHash(definition);
    const request = vi.fn(async () =>
      response(
        {
          ok: false,
          error: 'version-conflict',
          conflict: {
            expectedVersion: 1,
            actualVersion: 2,
            current: {
              projectId: PROJECT_ID,
              scheduleId: SCHEDULE_ID,
              version: 2,
              definition,
              definitionHash: hash,
              updatedAt: 10,
            },
          },
        },
        409,
      ),
    );
    const backend = new HttpCronBackend({
      baseUrl: 'https://cron.example.test',
      request,
    });

    await expect(
      backend.publish(PROJECT_ID, SCHEDULE_ID, 1, definition),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'version-conflict',
      expectedVersion: 1,
      actualVersion: 2,
    });
  });

  it('propagates the caller abort signal to portable schedule requests', async () => {
    const request = vi.fn<
      (path: string, init: CronBackendRequest) => Promise<ApiResult>
    >(async () => response(null, 0));
    const backend = new HttpCronBackend({
      baseUrl: 'https://cron.example.test',
      request,
    });
    const controller = new AbortController();

    await backend.list(PROJECT_ID, { signal: controller.signal });
    await backend.publish(PROJECT_ID, SCHEDULE_ID, 0, definition, {
      signal: controller.signal,
    });

    expect(request.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(request.mock.calls[1]?.[1]?.signal).toBe(controller.signal);
  });
});


it('preserves a server license denial for schedule reads', async () => {
  const request = vi.fn(async () => ({ status: 403, json: { ok: false } }));
  const backend = new HttpCronBackend({ baseUrl: 'https://api.test', request });
  await expect(backend.list(lease().projectId)).rejects.toMatchObject({ code: 'license_access_denied' });
  expect(request).toHaveBeenCalledOnce();
});


it('uses the packaged authenticated origin policy before accepting a cloud backend override', () => {
  vi.mocked(resolveBackendUrl).mockReturnValueOnce('https://api.nexuside.app');
  expect(() => createHttpCronBackendFromEnvironment({ NEXUS_CRON_BACKEND_URL: 'https://attacker.example', NEXUS_BACKEND_URL: 'https://attacker.example' })).toThrow(/authenticated Nexus backend origin/);
});
