import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api-client';
import {
  createHttpSyncBackendFromEnvironment,
  HttpSyncBackend,
  SyncBackendQuotaError,
  SyncBackendUnavailableError,
} from './http-sync-backend';
import type { SyncMutation } from './sync-engine';

const mutation: SyncMutation = {
  entityType: 'context-fact',
  entityId: 'fact-a',
  entityVersion: 1,
  baseVersion: 0,
  payload: { statement: 'Tenant obrigatório' },
};

function requester(result: ApiResult) {
  return vi.fn(async () => result);
}

describe('HttpSyncBackend', () => {
  it('reads account-scoped state with the shared API timeout and byte budget', async () => {
    const request = requester({
      status: 200,
      json: {
        ok: true,
        data: {
          projectId: 'project-a',
          revision: 1,
          entities: [mutation],
          serverTime: 1_800_000_000_000,
        },
      },
    });
    const backend = new HttpSyncBackend({
      baseUrl: 'https://api.nexus.test',
      request,
      timeoutMs: 4_000,
      maxResponseBytes: 128 * 1024,
    });

    await expect(backend.read('project-a')).resolves.toEqual({
      revision: 1,
      entities: [mutation],
    });
    expect(request).toHaveBeenCalledWith('/v1/sync/projects/project-a', {
      method: 'GET',
      timeoutMs: 4_000,
      maxResponseBytes: 128 * 1024,
    });
  });

  it('performs CAS and maps an explicit server conflict to false', async () => {
    const request = vi
      .fn(async (): Promise<ApiResult> => ({ status: 0, json: null }))
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          data: { revision: 1, serverTime: 1_800_000_000_000 },
        },
      })
      .mockResolvedValueOnce({
        status: 409,
        json: {
          ok: false,
          error: 'revision-conflict',
          conflict: {
            expectedRevision: 0,
            actualRevision: 1,
            conflictingEntityIds: ['context-fact:fact-a'],
            serverTime: 1_800_000_000_001,
          },
        },
      });
    const backend = new HttpSyncBackend({
      baseUrl: 'https://api.nexus.test',
      request,
    });

    await expect(backend.compareAndSwap('project-a', 0, [mutation])).resolves.toBe(
      true,
    );
    await expect(backend.compareAndSwap('project-a', 0, [mutation])).resolves.toBe(
      false,
    );
    expect(request).toHaveBeenNthCalledWith(1, '/v1/sync/projects/project-a', {
      method: 'PUT',
      body: { expectedRevision: 0, entities: [mutation] },
      timeoutMs: 5_000,
      maxResponseBytes: 256 * 1024,
    });
  });

  it('fails closed on network errors and malformed responses', async () => {
    for (const result of [
      { status: 0, json: null },
      { status: 200, json: { ok: true, data: { revision: '1' } } },
    ]) {
      const backend = new HttpSyncBackend({
        baseUrl: 'https://api.nexus.test',
        request: requester(result),
      });
      await expect(backend.read('project-a')).rejects.toBeInstanceOf(
        SyncBackendUnavailableError,
      );
    }
  });

  it('surfaces quota rejection and never falls back to memory', async () => {
    const backend = new HttpSyncBackend({
      baseUrl: 'https://api.nexus.test',
      request: requester({
        status: 413,
        json: {
          ok: false,
          error: 'quota-exceeded',
          quota: { name: 'entities-per-project', limit: 1, actual: 2 },
        },
      }),
    });

    await expect(
      backend.compareAndSwap('project-a', 0, [mutation]),
    ).rejects.toBeInstanceOf(SyncBackendQuotaError);
  });

  it('rejects unsafe payloads before sending credentials to the backend', async () => {
    const request = requester({ status: 200, json: null });
    const backend = new HttpSyncBackend({
      baseUrl: 'https://api.nexus.test',
      request,
    });

    await expect(
      backend.compareAndSwap('project-a', 0, [
        { ...mutation, payload: { sourceContents: 'secret source' } },
      ]),
    ).rejects.toThrow(/not sync-safe/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('requires HTTPS and permits insecure localhost only under an explicit test flag', () => {
    expect(
      () => new HttpSyncBackend({ baseUrl: 'http://sync.example.test' }),
    ).toThrow(/HTTPS/i);
    expect(
      () =>
        new HttpSyncBackend({
          baseUrl: 'http://127.0.0.1:3100',
          allowInsecureLocalhostForTests: true,
        }),
    ).not.toThrow();
  });

  it('is opt-in and refuses to send Nexus auth to a different origin', () => {
    expect(createHttpSyncBackendFromEnvironment({})).toBeNull();
    expect(() =>
      createHttpSyncBackendFromEnvironment({
        NEXUS_BACKEND_URL: 'https://api.nexus.test',
        NEXUS_SYNC_BACKEND_URL: 'https://sync.attacker.test',
      }),
    ).toThrow(/same authenticated Nexus backend origin/i);
    expect(
      createHttpSyncBackendFromEnvironment({
        NEXUS_BACKEND_URL: 'https://api.nexus.test',
        NEXUS_SYNC_BACKEND_URL: 'https://api.nexus.test',
      }),
    ).toBeInstanceOf(HttpSyncBackend);
  });
});
