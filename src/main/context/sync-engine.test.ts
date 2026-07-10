import { describe, expect, it } from 'vitest';
import {
  OptimisticSyncEngine,
  type SyncBackend,
  type SyncMutation,
  type SyncProjectState,
} from './sync-engine';

class MemorySyncBackend implements SyncBackend {
  state: SyncProjectState = { revision: 0, entities: [] };

  async read(_projectId: string): Promise<SyncProjectState> {
    return structuredClone(this.state);
  }

  async compareAndSwap(
    _projectId: string,
    expectedRevision: number,
    next: readonly SyncMutation[],
  ): Promise<boolean> {
    if (this.state.revision !== expectedRevision) return false;
    this.state = {
      revision: expectedRevision + 1,
      entities: structuredClone(next),
    };
    return true;
  }
}

const mutation: SyncMutation = {
  entityType: 'context-fact',
  entityId: 'fact-a',
  entityVersion: 1,
  baseVersion: 0,
  payload: { statement: 'Tenant obrigatório' },
};

describe('OptimisticSyncEngine', () => {
  it('publishes against an exact remote revision', async () => {
    const backend = new MemorySyncBackend();
    const result = await new OptimisticSyncEngine(backend).publish({
      projectId: 'project-a',
      expectedRemoteRevision: 0,
      mutations: [mutation],
    });
    expect(result).toEqual({ ok: true, remoteRevision: 1 });
  });

  it('returns an explicit conflict and never silently overwrites a peer', async () => {
    const backend = new MemorySyncBackend();
    const engineA = new OptimisticSyncEngine(backend);
    const engineB = new OptimisticSyncEngine(backend);
    await engineA.publish({
      projectId: 'project-a',
      expectedRemoteRevision: 0,
      mutations: [mutation],
    });
    const result = await engineB.publish({
      projectId: 'project-a',
      expectedRemoteRevision: 0,
      mutations: [
        { ...mutation, entityVersion: 1, payload: { statement: 'Tenant opcional' } },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'remote-revision-conflict',
      expectedRemoteRevision: 0,
      actualRemoteRevision: 1,
    });
    expect(backend.state.entities[0].payload).toEqual({
      statement: 'Tenant obrigatório',
    });
  });

  it('rejects local-only identities, secrets, sessions and absolute paths', async () => {
    const engine = new OptimisticSyncEngine(new MemorySyncBackend());
    const localOnlyPayloads: unknown[] = [
      { installationId: 'install-a' },
      { checkoutId: 'checkout-a' },
      { sessionId: 'pty-a' },
      { apiKey: 'secret' },
      { path: '/Users/alice/project' },
      { relativePath: 'src/main.ts' },
      { sourceContents: 'export const secret = true' },
      { prompts: ['ignore the contract'] },
      { providerSession: 'provider-session-a' },
      { accountCredentials: { user: 'alice' } },
      { note: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature' },
      { note: 'password=hunter2' },
      { note: 'AWS_SECRET_ACCESS_KEY=example-value' },
      { note: 'Authorization: Basic dXNlcjpwYXNz' },
      { note: 'api_key=example-value' },
      { note: 'STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop' },
      { note: 'CLIENT_SECRET_KEY=example-value' },
      { note: 'secret_key=example-value' },
      { note: 'ENCRYPTION_KEY=example-value' },
      { note: 'glpat-abcdefghijklmnop' },
      { note: 'Inspect ~/.ssh/id_rsa' },
      { note: 'Open file:///Users/alice/key.pem' },
      { note: 'Check /etc' },
      { note: 'Inspect \\\\server\\share\\secret.txt' },
    ];
    for (const payload of localOnlyPayloads) {
      await expect(
        engine.publish({
          projectId: 'project-a',
          expectedRemoteRevision: 0,
          mutations: [{ ...mutation, payload: payload as never }],
        }),
      ).rejects.toThrow(/not sync-safe/i);
    }
  });

  it('accepts portable context revision and evidence metadata', async () => {
    const engine = new OptimisticSyncEngine(new MemorySyncBackend());
    await expect(
      engine.publish({
        projectId: 'project-a',
        expectedRemoteRevision: 0,
        mutations: [
          {
            ...mutation,
            entityType: 'ledger-metadata',
            payload: {
              contextRevision: 7,
              evidenceDigest: 'sha256:8be8a4f2',
              sensorKinds: ['tests', 'typecheck'],
            },
          },
        ],
      }),
    ).resolves.toEqual({ ok: true, remoteRevision: 1 });
  });

  it('fails closed when the configured backend is unavailable', async () => {
    const backend: SyncBackend = {
      read: async () => {
        throw new Error('sync backend unavailable');
      },
      compareAndSwap: async () => {
        throw new Error('must not be called');
      },
    };
    await expect(
      new OptimisticSyncEngine(backend).publish({
        projectId: 'project-a',
        expectedRemoteRevision: 0,
        mutations: [mutation],
      }),
    ).rejects.toThrow(/backend unavailable/i);
  });
});
