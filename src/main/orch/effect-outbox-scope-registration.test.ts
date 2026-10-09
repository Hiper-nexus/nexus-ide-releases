import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedEffectOutboxStore } from './effect-outbox';
import {
  drainEffectOutbox,
  registerEffectOutboxHandler,
} from './effect-outbox-worker';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
} from './project-domain-store-registry';

describe('effect outbox reconciles on first scope registration', () => {
  const directories: string[] = [];
  const managers: ProjectRuntimeManager[] = [];
  let configured = false;

  afterEach(async () => {
    if (configured) {
      configured = false;
      await disposeProjectDomainStoreRegistry();
    }
    for (const manager of managers.splice(0)) manager.closeAll();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels a process-bound row from the previous process before drain can claim it', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-late-scope-'));
    directories.push(baseDir);
    const manager = new ProjectRuntimeManager({
      baseDir,
      appVersion: 'late-scope-test',
    });
    managers.push(manager);
    const scope = testProjectScope({
      projectId: 'project-late-open',
      checkoutId: 'checkout-late-open',
    });
    const planted = createScopedEffectOutboxStore(manager, scope);
    const stale = planted.enqueue({
      commandId: 'cmd-stale-turn',
      threadId: 'thread-previous-main',
      type: 'turn.start',
    });
    expect(planted.claimNext({
      workerId: 'previous-main',
      leaseDurationMs: 60_000,
    })?.id).toBe(stale.id);

    const registry = configureProjectDomainStoreRegistry(manager);
    configured = true;
    expect(registry.listSuites()).toEqual([]);

    let executed = false;
    const unregister = registerEffectOutboxHandler('turn.start', () => {
      executed = true;
    });
    try {
      const suite = registry.forScope(scope);
      expect(registry.listSuites()).toEqual([suite]);
      const settled = planted.get(stale.id);
      expect(settled?.status).toBe('cancelled');
      expect(settled?.lastError).toContain('server process ended');

      const drained = await drainEffectOutbox({
        store: planted,
        scope,
        workerId: 'orchestration-coordinator',
      });
      expect(drained.claimed).toBe(0);
      expect(executed).toBe(false);
    } finally {
      unregister();
    }
  });
});
