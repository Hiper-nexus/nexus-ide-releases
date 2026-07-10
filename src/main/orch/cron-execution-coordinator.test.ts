import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  DistributedLeaseCoordinator,
  type LeaseAcquireResult,
  type LeaseBackend,
  type SharedScheduleLeaseRequest,
} from '../context/distributed-lease';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { CronJob } from './cron-loop';
import {
  CronExecutionCoordinator,
  createCronLeaseRequest,
  type CronRenewalTimer,
} from './cron-execution-coordinator';
import { CronExecutionStateStore } from './cron-execution-state-store';
import { cronDefinitionHash } from './portable-cron-definition';

const PROJECT_ID = '31781d36-3f22-41b8-ad9d-8690c85d3343';
const PORTABLE_SCHEDULE_ID = '2a21a665-d7fd-45d5-b81f-41f433c665ad';

class MemoryLeaseBackend implements LeaseBackend {
  readonly states = new Map<string, { token: string; expiresAt: number }>();
  unavailable = false;
  now = 10_000;
  tokenCounter = 0;

  #key(request: SharedScheduleLeaseRequest): string {
    return `${request.projectId}:${request.scheduleId}:${request.occurrenceAt}`;
  }

  async acquire(request: SharedScheduleLeaseRequest): Promise<LeaseAcquireResult> {
    if (this.unavailable) throw new Error('offline');
    const key = this.#key(request);
    const current = this.states.get(key);
    if (current && current.expiresAt > this.now) {
      return {
        acquired: false,
        reason: 'held-by-peer',
        retryAt: current.expiresAt,
      };
    }
    const token = `opaque/+ token-${++this.tokenCounter}`;
    const next = { token, expiresAt: this.now + request.ttlMs };
    this.states.set(key, next);
    return {
      acquired: true,
      token,
      expiresAt: next.expiresAt,
      reused: false,
    };
  }

  async renew(
    request: SharedScheduleLeaseRequest,
    token: string,
  ): Promise<LeaseAcquireResult> {
    if (this.unavailable) throw new Error('offline');
    const current = this.states.get(this.#key(request));
    if (!current || current.token !== token || current.expiresAt <= this.now) {
      return { acquired: false, reason: 'expired-or-not-owner' };
    }
    current.expiresAt = this.now + request.ttlMs;
    return {
      acquired: true,
      token,
      expiresAt: current.expiresAt,
      reused: true,
    };
  }

  async release(request: SharedScheduleLeaseRequest, token: string): Promise<boolean> {
    if (this.unavailable) throw new Error('offline');
    const key = this.#key(request);
    const current = this.states.get(key);
    if (!current || current.token !== token) return false;
    this.states.delete(key);
    return true;
  }
}

const managers: ProjectRuntimeManager[] = [];
const roots: string[] = [];

function manager(baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cron-pc-'))): ProjectRuntimeManager {
  roots.push(baseDir);
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
  });
  managers.push(value);
  return value;
}

function scope(installationId: string): ProjectExecutionScope {
  return {
    version: 1,
    installationId,
    projectId: PROJECT_ID,
    checkoutId: 'checkout-shared',
    rootRealPath: `/workspace/${installationId}`,
    identitySource: 'manifest',
  };
}

function job(overrides: Partial<CronJob> = {}): CronJob {
  const value: CronJob = {
    id: 'nightly-review',
    name: 'nightly review',
    schedule: '0 0 * * *',
    brief: 'review code',
    status: 'active',
    executionMode: 'shared',
    workspacePath: '/workspace/a',
    projectId: PROJECT_ID,
    checkoutId: 'checkout-shared',
    portableScheduleId: PORTABLE_SCHEDULE_ID,
    definitionVersion: 1,
    agentName: 'reviewer',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
  value.definitionHash =
    overrides.definitionHash ??
    cronDefinitionHash({
      schemaVersion: 1,
      name: value.name,
      schedule: value.schedule,
      brief: value.brief,
      target: value.agentName
        ? { kind: 'agent', id: value.agentName }
        : { kind: 'squad', id: value.squadId },
      status: value.status,
    });
  return value;
}

function coordinator(options: {
  runtimeManager: ProjectRuntimeManager;
  projectScope: ProjectExecutionScope;
  backend?: LeaseBackend;
  now: () => number;
  renewalTimer?: CronRenewalTimer;
  leaseTtlMs?: number;
  staleMs?: number;
}): CronExecutionCoordinator {
  return new CronExecutionCoordinator({
    runtimeManager: options.runtimeManager,
    leaseBackend: options.backend,
    now: options.now,
    leaseTtlMs: options.leaseTtlMs,
    staleMs: options.staleMs,
    renewalTimer: options.renewalTimer,
    resolveScope: () => options.projectScope,
  });
}

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CronExecutionCoordinator multi-PC semantics', () => {
  it('allows exactly one concurrent fire across two installations', async () => {
    const backend = new MemoryLeaseBackend();
    const now = () => 10_000;
    const pcA = coordinator({
      runtimeManager: manager(),
      projectScope: scope('installation-a'),
      backend,
      now,
    });
    const pcB = coordinator({
      runtimeManager: manager(),
      projectScope: scope('installation-b'),
      backend,
      now,
    });
    const fireA = vi.fn(async () => {});
    const fireB = vi.fn(async () => {});

    const results = await Promise.all([
      pcA.execute(job(), 9_000, fireA),
      pcB.execute(job(), 9_000, fireB),
    ]);

    expect(results.filter((result) => result.fired)).toHaveLength(1);
    expect(fireA.mock.calls.length + fireB.mock.calls.length).toBe(1);
  });

  it('completion-fences one occurrence so two computers cannot run it sequentially', async () => {
    const backend = new MemoryLeaseBackend();
    const now = () => 10_000;
    const pcA = coordinator({
      runtimeManager: manager(),
      projectScope: scope('installation-a'),
      backend,
      now,
    });
    const pcB = coordinator({
      runtimeManager: manager(),
      projectScope: scope('installation-b'),
      backend,
      now,
    });
    const fireA = vi.fn(async () => {});
    const fireB = vi.fn(async () => {});

    await expect(pcA.execute(job(), 9_000, fireA)).resolves.toMatchObject({
      fired: true,
      disposition: 'completed',
    });
    await expect(pcB.execute(job(), 9_000, fireB)).resolves.toMatchObject({
      fired: false,
      disposition: 'lease-held',
    });
    expect(fireA).toHaveBeenCalledOnce();
    expect(fireB).not.toHaveBeenCalled();
  });

  it('fails closed and records suppression when the remote backend is down', async () => {
    const backend = new MemoryLeaseBackend();
    backend.unavailable = true;
    const fire = vi.fn(async () => {});
    const runtimeManager = manager();
    const projectScope = scope('installation-a');
    const pc = coordinator({
      runtimeManager,
      projectScope,
      backend,
      now: () => 10_000,
    });

    await expect(pc.execute(job(), 9_000, fire)).resolves.toMatchObject({
      fired: false,
      disposition: 'backend-unavailable',
    });
    expect(fire).not.toHaveBeenCalled();
    expect(
      new CronExecutionStateStore(runtimeManager, projectScope).read(
        'nightly-review',
      ),
    ).toMatchObject({
      scheduledFor: 9_000,
      status: 'suppressed',
      reason: 'backend-unavailable',
    });
  });

  it('treats missing backend as unavailable; only explicit local jobs may run', async () => {
    const fire = vi.fn(async () => {});
    const pc = coordinator({
      runtimeManager: manager(),
      projectScope: scope('installation-a'),
      now: () => 10_000,
    });

    await expect(
      pc.execute(job({ executionMode: undefined }), 9_000, fire),
    ).resolves.toMatchObject({
      fired: false,
      disposition: 'backend-unavailable',
    });
    await expect(
      pc.execute(job({ id: 'local-job', executionMode: 'local' }), 9_000, fire),
    ).resolves.toMatchObject({ fired: true, disposition: 'completed' });
    expect(fire).toHaveBeenCalledOnce();
  });

  it('permits takeover after an abandoned execution lease expires', async () => {
    const backend = new MemoryLeaseBackend();
    let currentTime = 10_000;
    const jobValue = job();
    const scheduledFor = 9_000;
    const abandoned = new DistributedLeaseCoordinator(backend);
    await expect(
      abandoned.acquire(
        createCronLeaseRequest(
          scope('installation-a'),
          jobValue,
          scheduledFor,
          3_000,
        ),
      ),
    ).resolves.toMatchObject({ acquired: true });

    currentTime = 13_001;
    backend.now = currentTime;
    const fire = vi.fn(async () => {});
    const pcB = coordinator({
      runtimeManager: manager(),
      projectScope: scope('installation-b'),
      backend,
      now: () => currentTime,
      leaseTtlMs: 3_000,
    });
    await expect(pcB.execute(jobValue, scheduledFor, fire)).resolves.toMatchObject({
      fired: true,
      disposition: 'completed',
    });
    expect(fire).toHaveBeenCalledOnce();
  });

  it('keeps a remote occurrence fenced after fire starts and then fails', async () => {
    const backend = new MemoryLeaseBackend();
    let currentTime = 10_000;
    const controls: {
      pulse?: () => void;
      rejectFire?: (error: Error) => void;
    } = {};
    const renewalTimer: CronRenewalTimer = {
      setInterval: (callback) => {
        controls.pulse = callback;
        return 1;
      },
      clearInterval: () => {
        delete controls.pulse;
      },
    };
    const fireA = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          controls.rejectFire = reject;
        }),
    );
    const pcA = coordinator({
      runtimeManager: manager(),
      projectScope: scope('installation-a'),
      backend,
      now: () => currentTime,
      leaseTtlMs: 3_000,
      staleMs: 300_000,
      renewalTimer,
    });
    const pending = pcA.execute(job(), 9_000, fireA);
    await vi.waitFor(() => expect(controls.pulse).toBeTypeOf('function'));
    expect([...backend.states.values()][0]?.expiresAt).toBeGreaterThanOrEqual(
      311_000,
    );
    currentTime = 10_050;
    backend.now = currentTime;
    controls.pulse?.();
    await vi.waitFor(() => {
      const active = [...backend.states.values()][0];
      expect(active?.expiresAt).toBeGreaterThanOrEqual(310_000);
    });
    controls.rejectFire?.(new Error('spawn failed'));
    await expect(pending).resolves.toMatchObject({
      fired: false,
      disposition: 'fire-failed',
    });

    const fireB = vi.fn(async () => {});
    const pcB = coordinator({
      runtimeManager: manager(),
      projectScope: scope('installation-b'),
      backend,
      now: () => currentTime,
      leaseTtlMs: 3_000,
    });
    await expect(pcB.execute(job(), 9_000, fireB)).resolves.toMatchObject({
      fired: false,
      disposition: 'lease-held',
    });
    expect(fireB).not.toHaveBeenCalled();
  });

  it('does not repeat an already-started occurrence after a physical restart', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cron-restart-pc-'));
    const projectScope = scope('installation-a');
    const firstManager = manager(baseDir);
    const receipt = new CronExecutionStateStore(firstManager, projectScope);
    expect(receipt.start({
      jobId: 'nightly-review',
      scheduledFor: 9_000,
      executionMode: 'local',
      leaseExpiresAt: null,
      updatedAt: 9_010,
    })).toBe(true);
    firstManager.closeAll();

    const restarted = coordinator({
      runtimeManager: manager(baseDir),
      projectScope,
      now: () => 10_100,
    });
    const fireAgain = vi.fn(async () => {});
    await expect(
      restarted.execute(job({ executionMode: 'local' }), 9_000, fireAgain),
    ).resolves.toMatchObject({
      fired: false,
      disposition: 'already-recorded',
    });
    expect(fireAgain).not.toHaveBeenCalled();
  });
});
