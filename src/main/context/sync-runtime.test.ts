import { resetLicensedAccessMock } from '../__tests__/licensed-access';
beforeEach(resetLicensedAccessMock);
import { beforeEach } from 'vitest';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
import { requireAccess } from '../license-access';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  configureSyncRuntime,
  disposeSyncRuntime,
  getSyncRuntimeCapability,
  inspectSyncRuntime,
  publishMainOwnedSync,
  SyncRuntimeNotConfiguredError,
} from './sync-runtime';
import type { SyncBackend, SyncMutation } from './sync-engine';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'installation-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/private/workspace-a',
  identitySource: 'manifest',
});

const mutation: SyncMutation = Object.freeze({
  entityType: 'context-fact',
  entityId: 'fact-a',
  entityVersion: 1,
  baseVersion: 0,
  payload: Object.freeze({ statement: 'Tenant isolation is mandatory' }),
});

afterEach(() => {
  disposeSyncRuntime();
});

describe('sync runtime registry', () => {
  it('reports unavailable without a configured backend and never falls back to memory', async () => {
    expect(configureSyncRuntime({ backend: null })).toEqual({
      backendConfigured: false,
    });

    await expect(inspectSyncRuntime(scope)).resolves.toEqual({
      available: false,
      projectId: 'project-a',
      serverStatus: 'unconfigured',
      revision: null,
      entityCount: 0,
      entityTypes: {},
    });
    expect(getSyncRuntimeCapability()).toEqual({ backendConfigured: false });
  });

  it('returns bounded metadata from the exact project without exposing payloads', async () => {
    const read = vi.fn(async () => ({
      revision: 7,
      entities: [
        mutation,
        {
          ...mutation,
          entityType: 'context-decision' as const,
          entityId: 'decision-a',
          payload: { secretNarrative: 'must never be returned' },
        },
      ],
    }));
    configureSyncRuntime({
      backend: { read, compareAndSwap: vi.fn() as never },
    });

    const status = await inspectSyncRuntime(scope);

    expect(read).toHaveBeenCalledWith('project-a');
    expect(status).toEqual({
      available: true,
      projectId: 'project-a',
      serverStatus: 'reachable',
      revision: 7,
      entityCount: 2,
      entityTypes: {
        'context-decision': 1,
        'context-fact': 1,
      },
    });
    expect(JSON.stringify(status)).not.toContain('secretNarrative');
    expect(JSON.stringify(status)).not.toContain(scope.rootRealPath);
  });

  it('fails closed with a stable unreachable status when the backend read fails', async () => {
    configureSyncRuntime({
      backend: {
        read: async () => {
          throw new Error('Bearer private-provider-token');
        },
        compareAndSwap: vi.fn() as never,
      },
    });

    await expect(inspectSyncRuntime(scope)).resolves.toEqual({
      available: false,
      projectId: 'project-a',
      serverStatus: 'unreachable',
      revision: null,
      entityCount: 0,
      entityTypes: {},
    });
  });

  it('binds internal publish authority to the exact scope project id', async () => {
    const backend: SyncBackend = {
      read: vi.fn(async () => ({ revision: 0, entities: [] })),
      compareAndSwap: vi.fn(async () => true),
    };
    configureSyncRuntime({ backend });

    await expect(
      publishMainOwnedSync(scope, {
        projectId: 'project-b',
        expectedRemoteRevision: 0,
        mutations: [mutation],
      }),
    ).rejects.toThrow(/differs from execution scope/i);
    expect(backend.read).not.toHaveBeenCalled();

    await expect(
      publishMainOwnedSync(scope, {
        projectId: 'project-a',
        expectedRemoteRevision: 0,
        mutations: [mutation],
      }),
    ).resolves.toEqual({ ok: true, remoteRevision: 1 });
    expect(backend.read).toHaveBeenCalledWith('project-a');
  });

  it('clears all authority on dispose and rejects access before configuration', async () => {
    configureSyncRuntime({ backend: null });
    disposeSyncRuntime();

    expect(() => getSyncRuntimeCapability()).toThrow(
      SyncRuntimeNotConfiguredError,
    );
    await expect(inspectSyncRuntime(scope)).rejects.toBeInstanceOf(
      SyncRuntimeNotConfiguredError,
    );
  });
});


it('blocks main-owned publication without touching the configured backend', async () => {
  const read = vi.fn(); configureSyncRuntime({ backend: { read, compareAndSwap: vi.fn() } });
  vi.mocked(requireAccess).mockReturnValue({ ok: false, reason: 'cloud-sync-disabled' });
  await expect(publishMainOwnedSync(scope, { projectId: scope.projectId, expectedRemoteRevision: 0, mutations: [mutation] })).rejects.toMatchObject({ code: 'license_access_denied' });
  expect(read).not.toHaveBeenCalled();
});
