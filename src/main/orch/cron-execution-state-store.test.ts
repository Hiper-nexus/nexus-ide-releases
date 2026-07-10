import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { CronExecutionStateStore } from './cron-execution-state-store';

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function manager(baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cron-state-'))): ProjectRuntimeManager {
  roots.push(baseDir);
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
  });
  managers.push(value);
  return value;
}

function scope(projectId: string, checkoutId: string): ProjectExecutionScope {
  return {
    version: 1,
    installationId: 'installation-a',
    projectId,
    checkoutId,
    rootRealPath: `/workspace/${projectId}/${checkoutId}`,
    identitySource: 'manifest',
  };
}

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CronExecutionStateStore', () => {
  it('physically isolates projects and checkouts even when job ids collide', () => {
    const runtime = manager();
    const storeA = new CronExecutionStateStore(runtime, scope('project-a', 'checkout-a'));
    const storeB = new CronExecutionStateStore(runtime, scope('project-b', 'checkout-b'));

    expect(storeA.start({
      jobId: 'same-job',
      scheduledFor: 1_000,
      executionMode: 'shared',
      leaseExpiresAt: 2_000,
      updatedAt: 1_010,
    })).toBe(true);

    expect(storeA.read('same-job')).toMatchObject({
      jobId: 'same-job',
      scheduledFor: 1_000,
      status: 'started',
    });
    expect(storeB.read('same-job')).toBeNull();
  });

  it('keeps the latest occurrence durable across a full manager restart', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cron-restart-'));
    const projectScope = scope('project-a', 'checkout-a');
    const first = manager(baseDir);
    const firstStore = new CronExecutionStateStore(first, projectScope);

    expect(firstStore.start({
      jobId: 'nightly',
      scheduledFor: 10_000,
      executionMode: 'local',
      leaseExpiresAt: null,
      updatedAt: 10_010,
    })).toBe(true);
    firstStore.finish('nightly', 10_000, 'completed', null, 10_020);
    first.closeAll();

    const second = manager(baseDir);
    const restarted = new CronExecutionStateStore(second, projectScope);
    expect(restarted.read('nightly')).toMatchObject({
      scheduledFor: 10_000,
      status: 'completed',
      executionMode: 'local',
    });
    expect(restarted.start({
      jobId: 'nightly',
      scheduledFor: 10_000,
      executionMode: 'local',
      leaseExpiresAt: null,
      updatedAt: 10_030,
    })).toBe(false);
  });

  it('refuses to overwrite a newer occurrence with an older retry', () => {
    const store = new CronExecutionStateStore(
      manager(),
      scope('project-a', 'checkout-a'),
    );
    expect(store.suppress({
      jobId: 'nightly',
      scheduledFor: 20_000,
      executionMode: 'shared',
      reason: 'backend-unavailable',
      leaseExpiresAt: null,
      error: 'offline',
      updatedAt: 20_010,
    })).toBe(true);
    expect(store.start({
      jobId: 'nightly',
      scheduledFor: 10_000,
      executionMode: 'shared',
      leaseExpiresAt: 11_000,
      updatedAt: 20_020,
    })).toBe(false);
    expect(store.read('nightly')).toMatchObject({
      scheduledFor: 20_000,
      status: 'suppressed',
      reason: 'backend-unavailable',
    });
  });
});
