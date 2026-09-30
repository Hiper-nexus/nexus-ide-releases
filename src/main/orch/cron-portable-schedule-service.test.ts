import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';;
import type { ProjectExecutionScope } from '../../shared/types';
import type { CronJob } from './cron-loop';
import {
  CronPortableScheduleConflictError,
  CronPortableScheduleService,
} from './cron-portable-schedule-service';
import {
  cronDefinitionHash,
  type PortableCronDefinition,
  type PortableCronSchedule,
  type PortableCronScheduleBackend,
} from './portable-cron-definition';
import { runCronTick, type CronRuntimeDeps } from './cron-runtime';

const PROJECT_ID = '31781d36-3f22-41b8-ad9d-8690c85d3343';
const roots: string[] = [];

class MemoryPortableBackend implements PortableCronScheduleBackend {
  readonly schedules = new Map<string, PortableCronSchedule>();
  unavailable = false;
  now = 10_000;
  publishCalls = 0;
  beforePublish:
    | ((options?: { readonly signal?: AbortSignal }) => Promise<void>)
    | undefined;
  lastPublishOptions: { readonly signal?: AbortSignal } | undefined;

  async list(projectId: string) {
    if (this.unavailable) {
      return { ok: false as const, reason: 'backend-unavailable' as const };
    }
    return {
      ok: true as const,
      schedules: [...this.schedules.values()].filter(
        (schedule) => schedule.projectId === projectId,
      ),
    };
  }

  async publish(
    projectId: string,
    scheduleId: string,
    expectedVersion: number,
    definition: PortableCronDefinition,
    options?: { readonly signal?: AbortSignal },
  ) {
    this.publishCalls += 1;
    this.lastPublishOptions = options;
    await this.beforePublish?.(options);
    if (this.unavailable) {
      return {
        ok: false as const,
        reason: 'backend-unavailable' as const,
        expectedVersion,
        actualVersion: 0,
        current: null,
      };
    }
    const current = this.schedules.get(scheduleId) ?? null;
    if ((current?.version ?? 0) !== expectedVersion) {
      return {
        ok: false as const,
        reason: 'version-conflict' as const,
        expectedVersion,
        actualVersion: current?.version ?? 0,
        current,
      };
    }
    const next: PortableCronSchedule = {
      projectId,
      scheduleId,
      version: expectedVersion + 1,
      definition,
      definitionHash: cronDefinitionHash(definition),
      updatedAt: ++this.now,
    };
    this.schedules.set(scheduleId, next);
    return { ok: true as const, created: expectedVersion === 0, schedule: next };
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function scope(installationId: string, checkoutId: string): ProjectExecutionScope {
  const rootRealPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-portable-cron-')),
  );
  roots.push(rootRealPath);
  return {
    version: 1,
    installationId,
    projectId: PROJECT_ID,
    checkoutId,
    rootRealPath,
    identitySource: 'manifest',
  };
}

function localStore(initial: CronJob[] = []) {
  let jobs = structuredClone(initial);
  return {
    load: () => structuredClone(jobs),
    save: (next: CronJob[]) => {
      jobs = structuredClone(next);
    },
    read: () => structuredClone(jobs),
  };
}

function service(
  backend: MemoryPortableBackend,
  store = localStore(),
  idFactory: () => string = randomUUID,
) {
  return {
    store,
    value: new CronPortableScheduleService({
      backend,
      load: store.load,
      save: store.save,
      now: () => 20_000,
      idFactory,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

describe('CronPortableScheduleService', () => {
  it('publishes a versioned definition and keeps machine coordinates local', async () => {
    const backend = new MemoryPortableBackend();
    const pcA = service(backend, localStore(), () => '2a21a665-d7fd-45d5-b81f-41f433c665ad');
    const projectScope = scope('installation-a', 'checkout-a');
    const nested = path.join(projectScope.rootRealPath, 'packages', 'api');
    fs.mkdirSync(nested, { recursive: true });

    const created = await pcA.value.create(
      {
        name: 'Nightly',
        schedule: '0 0 * * *',
        brief: 'review code',
        workingDirectory: nested,
        agentName: 'reviewer',
      },
      projectScope,
    );

    expect(created).toMatchObject({
      portableScheduleId: '2a21a665-d7fd-45d5-b81f-41f433c665ad',
      definitionVersion: 1,
      definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      projectId: PROJECT_ID,
      checkoutId: 'checkout-a',
      workspacePath: projectScope.rootRealPath,
      workingDirectory: nested,
    });
    const remote = [...backend.schedules.values()][0];
    expect(remote.definition.workingDirectory).toBe('packages/api');
    expect(JSON.stringify(remote)).not.toMatch(/installation|checkout|rootRealPath/);
  });

  it('binds authorization to the final create identity before remote publish', async () => {
    const backend = new MemoryPortableBackend();
    const scheduleId = '2a21a665-d7fd-45d5-b81f-41f433c665ad';
    const pc = service(backend, localStore(), () => scheduleId);
    const projectScope = scope('installation-a', 'checkout-a');
    let candidate: CronJob | undefined;

    await expect(
      pc.value.create(
        {
          name: 'Nightly',
          schedule: '0 0 * * *',
          brief: 'review code',
          agentName: 'reviewer',
        },
        projectScope,
        undefined,
        (value) => {
          candidate = value;
          throw new Error('synthetic authorization failure');
        },
      ),
    ).rejects.toThrow(/synthetic authorization failure/);

    expect(candidate).toMatchObject({
      id: `cron-${scheduleId}`,
      portableScheduleId: scheduleId,
      definitionVersion: 1,
      definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(backend.publishCalls).toBe(0);
    expect(backend.schedules.size).toBe(0);
    expect(pc.store.read()).toEqual([]);
  });

  it('materializes the same portable schedule on a second PC with its own checkout/root', async () => {
    const backend = new MemoryPortableBackend();
    const pcA = service(backend, localStore(), () => '2a21a665-d7fd-45d5-b81f-41f433c665ad');
    const scopeA = scope('installation-a', 'checkout-a');
    fs.mkdirSync(path.join(scopeA.rootRealPath, 'packages', 'api'), { recursive: true });
    const original = await pcA.value.create(
      {
        name: 'Nightly',
        schedule: '0 0 * * *',
        brief: 'review code',
        workingDirectory: path.join(scopeA.rootRealPath, 'packages', 'api'),
        agentName: 'reviewer',
      },
      scopeA,
    );

    const scopeB = scope('installation-b', 'checkout-b');
    fs.mkdirSync(path.join(scopeB.rootRealPath, 'packages', 'api'), { recursive: true });
    const pcB = service(backend);
    await expect(pcB.value.syncScope(scopeB)).resolves.toMatchObject({ ok: true });
    expect(pcB.store.read()).toHaveLength(1);
    expect(pcB.store.read()[0]).toMatchObject({
      portableScheduleId: original.portableScheduleId,
      definitionVersion: 1,
      projectId: PROJECT_ID,
      checkoutId: 'checkout-b',
      workspacePath: scopeB.rootRealPath,
      workingDirectory: path.join(scopeB.rootRealPath, 'packages', 'api'),
    });
  });

  it('returns an explicit CAS conflict for concurrent edits and preserves the loser', async () => {
    const backend = new MemoryPortableBackend();
    const scheduleId = '2a21a665-d7fd-45d5-b81f-41f433c665ad';
    const scopeA = scope('installation-a', 'checkout-a');
    const pcA = service(backend, localStore(), () => scheduleId);
    const initial = await pcA.value.create(
      {
        name: 'Nightly',
        schedule: '0 0 * * *',
        brief: 'review code',
        agentName: 'reviewer',
      },
      scopeA,
    );
    const scopeB = scope('installation-b', 'checkout-b');
    const pcB = service(backend);
    await pcB.value.syncScope(scopeB);

    await pcA.value.update(initial.id, { name: 'Winner' }, scopeA);
    await expect(
      pcB.value.update(pcB.store.read()[0].id, { name: 'Loser' }, scopeB),
    ).rejects.toMatchObject({
      name: 'CronPortableScheduleConflictError',
      expectedVersion: 1,
      actualVersion: 2,
    });
    expect(pcB.store.read()[0].name).toBe('Nightly');
  });

  it('binds update authorization to the next CAS version before remote publish', async () => {
    const backend = new MemoryPortableBackend();
    const pc = service(
      backend,
      localStore(),
      () => '2a21a665-d7fd-45d5-b81f-41f433c665ad',
    );
    const projectScope = scope('installation-a', 'checkout-a');
    const initial = await pc.value.create(
      {
        name: 'Nightly',
        schedule: '0 0 * * *',
        brief: 'review code',
        agentName: 'reviewer',
      },
      projectScope,
    );
    let candidate: CronJob | undefined;

    await expect(
      pc.value.update(
        initial.id,
        { brief: 'review the approved code and tests' },
        projectScope,
        undefined,
        (_current, value) => {
          candidate = value;
          throw new Error('synthetic reauthorization failure');
        },
      ),
    ).rejects.toThrow(/synthetic reauthorization failure/);

    expect(candidate).toMatchObject({
      id: initial.id,
      portableScheduleId: initial.portableScheduleId,
      definitionVersion: 2,
      definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      brief: 'review the approved code and tests',
    });
    expect(candidate?.definitionHash).not.toBe(initial.definitionHash);
    expect(backend.publishCalls).toBe(1);
    expect(pc.store.read()).toEqual([initial]);
  });

  it('linearizes update with create so neither stale snapshot can drop the other', async () => {
    const backend = new MemoryPortableBackend();
    const store = localStore();
    const ids = [
      '2a21a665-d7fd-45d5-b81f-41f433c665ad',
      'a844e570-4f43-4bda-b1c6-61befb5932a8',
    ];
    const pc = service(backend, store, () => ids.shift()!);
    const projectScope = scope('installation-a', 'checkout-a');
    const initial = await pc.value.create(
      {
        name: 'Nightly',
        schedule: '0 0 * * *',
        brief: 'review code',
        agentName: 'reviewer',
      },
      projectScope,
    );
    const entered = deferred();
    const release = deferred();
    backend.beforePublish = async () => {
      backend.beforePublish = undefined;
      entered.resolve();
      await release.promise;
    };

    const updating = pc.value.update(initial.id, { name: 'Winner' }, projectScope);
    await entered.promise;
    const creating = pc.value.create(
      {
        name: 'Second',
        schedule: '30 1 * * *',
        brief: 'review docs',
        agentName: 'reviewer',
      },
      projectScope,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsWhileUpdateBlocked = backend.publishCalls;
    release.resolve();
    await Promise.all([updating, creating]);

    expect(callsWhileUpdateBlocked).toBe(2);
    expect(pc.store.read().map((job) => job.name).sort()).toEqual([
      'Second',
      'Winner',
    ]);
  });

  it('linearizes a firing tick with delete so the tick cannot resurrect the job', async () => {
    const backend = new MemoryPortableBackend();
    const store = localStore();
    const pc = service(
      backend,
      store,
      () => '2a21a665-d7fd-45d5-b81f-41f433c665ad',
    );
    const projectScope = scope('installation-a', 'checkout-a');
    const created = await pc.value.create(
      {
        name: 'Every minute',
        schedule: '* * * * *',
        brief: 'review code',
        agentName: 'reviewer',
      },
      projectScope,
    );
    const due = store.read();
    due[0].nextFireAt = 60_000;
    store.save(due);
    const tickEntered = deferred();
    const releaseTick = deferred();
    const deps: CronRuntimeDeps = {
      load: store.load,
      save: store.save,
      fire: async () => undefined,
      executeOccurrence: async () => {
        tickEntered.resolve();
        await releaseTick.promise;
        return { fired: true, disposition: 'completed' };
      },
      now: () => 60_001,
    };

    const ticking = runCronTick(deps);
    await tickEntered.promise;
    const deleting = pc.value.delete(created.id, projectScope);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsWhileTickBlocked = backend.publishCalls;
    releaseTick.resolve();
    await Promise.all([ticking, deleting]);

    expect(callsWhileTickBlocked).toBe(1);
    expect(store.read()).toEqual([]);
  });

  it('propagates cancellation and refuses the local write after authority revocation', async () => {
    const backend = new MemoryPortableBackend();
    const pc = service(
      backend,
      localStore(),
      () => '2a21a665-d7fd-45d5-b81f-41f433c665ad',
    );
    const projectScope = scope('installation-a', 'checkout-a');
    const created = await pc.value.create(
      {
        name: 'Nightly',
        schedule: '0 0 * * *',
        brief: 'review code',
        agentName: 'reviewer',
      },
      projectScope,
    );
    const entered = deferred();
    const release = deferred();
    backend.beforePublish = async () => {
      backend.beforePublish = undefined;
      entered.resolve();
      await release.promise;
    };
    const controller = new AbortController();
    const invocation = {
      signal: controller.signal,
      assertCurrentAuthority: () => {
        if (controller.signal.aborted) throw new Error('session_authority_revoked');
      },
    };

    const updating = pc.value.update(
      created.id,
      { name: 'Must not persist locally' },
      projectScope,
      invocation,
    );
    await entered.promise;
    controller.abort();
    release.resolve();

    await expect(updating).rejects.toThrow(/session_authority_revoked/);
    expect(backend.lastPublishOptions?.signal).toBe(controller.signal);
    expect(pc.store.read()[0].name).toBe('Nightly');
  });

  it('does not create local state when the backend is unavailable', async () => {
    const backend = new MemoryPortableBackend();
    backend.unavailable = true;
    const pc = service(backend);

    await expect(
      pc.value.create(
        {
          name: 'Nightly',
          schedule: '0 0 * * *',
          brief: 'review code',
          agentName: 'reviewer',
        },
        scope('installation-a', 'checkout-a'),
      ),
    ).rejects.toThrow(/unavailable/);
    expect(pc.store.read()).toEqual([]);
  });

  it('marks same-version local divergence as a conflict without overwriting it', async () => {
    const backend = new MemoryPortableBackend();
    const scopeA = scope('installation-a', 'checkout-a');
    const pc = service(backend, localStore(), () => '2a21a665-d7fd-45d5-b81f-41f433c665ad');
    const created = await pc.value.create(
      {
        name: 'Nightly',
        schedule: '0 0 * * *',
        brief: 'review code',
        agentName: 'reviewer',
      },
      scopeA,
    );
    const tampered = pc.store.read();
    tampered[0].brief = 'local unsynchronized edit';
    pc.store.save(tampered);

    const result = await pc.value.syncScope(scopeA);
    expect(result).toMatchObject({
      ok: false,
      reason: 'definition-conflict',
      scheduleIds: [created.portableScheduleId],
    });
    expect(pc.store.read()[0]).toMatchObject({
      brief: 'local unsynchronized edit',
      lastError: expect.stringContaining('portable schedule conflict'),
    });
  });

  it('propagates a versioned tombstone so another PC removes the binding', async () => {
    const backend = new MemoryPortableBackend();
    const scopeA = scope('installation-a', 'checkout-a');
    const pcA = service(backend, localStore(), () => '2a21a665-d7fd-45d5-b81f-41f433c665ad');
    const created = await pcA.value.create(
      {
        name: 'Nightly',
        schedule: '0 0 * * *',
        brief: 'review code',
        agentName: 'reviewer',
      },
      scopeA,
    );
    const scopeB = scope('installation-b', 'checkout-b');
    const pcB = service(backend);
    await pcB.value.syncScope(scopeB);

    await expect(pcA.value.delete(created.id, scopeA)).resolves.toBe(true);
    await pcB.value.syncScope(scopeB);
    expect(pcB.store.read()).toEqual([]);
  });

  it('rejects non-manifest projects because their path-derived id is not portable', async () => {
    const backend = new MemoryPortableBackend();
    const pc = service(backend);
    const provisional = {
      ...scope('installation-a', 'checkout-a'),
      identitySource: 'provisional' as const,
    };
    await expect(
      pc.value.create(
        {
          name: 'Nightly',
          schedule: '0 0 * * *',
          brief: 'review code',
          agentName: 'reviewer',
        },
        provisional,
      ),
    ).rejects.toThrow(/manifest/);
  });

  it('exports a typed conflict error for callers that need remediation metadata', () => {
    const error = new CronPortableScheduleConflictError(2, 3, null);
    expect(error).toMatchObject({ expectedVersion: 2, actualVersion: 3 });
  });
});
