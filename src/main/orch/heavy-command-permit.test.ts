import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import { testProjectScope } from './__tests__/scope-fixture';

const pools: HeavyCommandPermitPool[] = [];
const scope = testProjectScope();
const request = (projectId = scope.projectId) => ({ scope: { ...scope, projectId }, missionId: 'mission',
  sessionId: 'worker', kind: 'typescript' as const });
function pool(memory: () => { freeMB: number | null; swapUsedMB: number | null } | null = () => ({ freeMB: 20_000, swapUsedMB: 0 })) {
  const value = new HeavyCommandPermitPool({ memory, limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {},
    pollMs: 10, waitMs: 100, maxWaiters: 2, reserveMB: 1000 });
  pools.push(value); return value;
}
afterEach(() => { for (const value of pools.splice(0)) value.close(); vi.useRealTimers(); });

it.each(['typescript', 'tests', 'build', 'install'] as const)('reserves the conservative 2048 MB for %s in production', async (kind) => {
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 20_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {} });
  pools.push(value);
  const permit = await value.acquire({ ...request(), kind });
  try { expect(value.snapshot().reservedMB).toBe(2048); }
  finally { permit.release(); }
});

it('expires mission and loose-helper waits before the shipped file transport times out', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let freeMB = 100;
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {} });
  pools.push(value);
  const reasons: string[] = [];
  const waits = [request(), { ...request(), missionId: undefined }].map(input => value.acquire(input)
    .then(permit => { permit.release(); reasons.push('unexpected admission'); }, error => { reasons.push(error.message); }));

  // Execute the shipped client, with no disk/network effects: zero available
  // file slots keeps a genuine transport request pending until its deadline.
  const transportModule = { exports: undefined as unknown as (directory: string, packet: object) => Promise<string> };
  let poll = () => {};
  runInNewContext(fs.readFileSync(path.resolve('resources/heavy-command/file-channel-client.cjs'), 'utf8'), {
    module: transportModule, Date,
    require: () => ({ fs: {}, path: {}, SLOTS: 0, directoryIdentity: () => ({}), checkDirectory: () => {} }),
    process: { once: () => {}, removeListener: () => {} },
    setTimeout: (fn: () => void) => { poll = fn; return 1; }, clearTimeout: () => {},
  });
  let transportReason: string | undefined;
  const transport = transportModule.exports('/isolated-channel', { id: 'fixture' })
    .catch((error: Error) => { transportReason = error.message; });
  try {
    await vi.advanceTimersByTimeAsync(300_001);
    poll(); await Promise.resolve();
    expect([...reasons]).toEqual(['heavy_command_wait_timeout', 'heavy_command_wait_timeout']);
    expect(value.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    expect(transportReason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    poll(); await transport;
    expect(transportReason).toBe('file_request_timeout');
    // Timeout is retryable admission failure, not a retained slot/permission.
    freeMB = 20_000;
    const retry = await value.acquire(request());
    expect(value.snapshot().active).toBe(1);
    retry.release();
  } finally {
    value.close(); await Promise.all(waits);
    vi.setSystemTime(360_001); poll(); await transport;
  }
});

it('serializes jobs in one checkout while worktrees of the same project run in parallel (F-983)', async () => {
  const value = pool(); const first = await value.acquire(request());
  let sameCheckout = false;
  const second = value.acquire({ ...request(), sessionId: 'other-worker' }).then(p => { sameCheckout = true; return p; });
  // Parallel writers own separate worktrees: one project-wide slot made them
  // queue behind each other until the 300 s admission timeout (exit 74).
  const worktree = await value.acquire({ ...request(), scope: { ...scope, checkoutId: 'worker-checkout', rootRealPath: '/isolated' } });
  const other = await value.acquire(request('another-project'));
  await Promise.resolve(); expect(sameCheckout).toBe(false); expect(value.snapshot().active).toBe(3);
  first.release(); const next = await second; expect(sameCheckout).toBe(true);
  next.release(); worktree.release(); other.release(); expect(value.snapshot().active).toBe(0);
});

it('F-1229: a wait timeout carries how long it waited and what held its root or the machine', async () => {
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10, waitMs: 60, reserveMB: 1000, maxActive: 2 });
  pools.push(value);
  const lane = (root: string) => ({ ...request(), scope: { ...scope, rootRealPath: root } });
  const timedOut = (root: string) => value.acquire(lane(root))
    .then(() => { throw new Error('unexpected admission'); }, (failure: Error & { queue?: { waitedMs: number } }) => failure);
  const held = await value.acquire(lane('/wt'));
  const sameRoot = await timedOut('/wt');
  expect(sameRoot.message).toBe('heavy_command_wait_timeout');
  expect(sameRoot).toMatchObject({ queue: { root: '/wt', running: 1, waiting: 0, machineActive: 1, maxActive: 2 } });
  expect(sameRoot.queue?.waitedMs).toBeGreaterThanOrEqual(60);
  const other = await value.acquire(lane('/other'));
  const machine = await timedOut('/third');
  expect(machine).toMatchObject({ message: 'heavy_command_wait_timeout', queue: { root: '/third', running: 0, waiting: 0, machineActive: 2, maxActive: 2 } });
  held.release(); other.release(); expect(value.snapshot()).toMatchObject({ active: 0, waiting: 0 });
});

it('bounds machine-wide concurrency even when RAM would admit more lanes', async () => {
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10, waitMs: 1000, reserveMB: 1000, maxActive: 2 });
  pools.push(value);
  const lane = (root: string) => ({ ...request(), scope: { ...scope, rootRealPath: root } });
  const [a, b] = await Promise.all([value.acquire(lane('/a')), value.acquire(lane('/b'))]);
  let third = false;
  const c = value.acquire(lane('/c')).then(p => { third = true; return p; });
  await Promise.resolve(); expect(third).toBe(false);
  a.release(); (await c).release(); b.release(); expect(value.snapshot().active).toBe(0);
});

it('cancels queued commands and keeps an active reservation through caller cancellation', async () => {
  const value = pool(); const activeController = new AbortController();
  const active = await value.acquire({ ...request(), signal: activeController.signal });
  const cancelled = new AbortController();
  const waiting = value.acquire({ ...request(), signal: cancelled.signal });
  const rejected = expect(waiting).rejects.toThrow('aborted'); cancelled.abort(); await rejected;
  activeController.abort(); expect(value.snapshot().active).toBe(1);
  active.release(); active.release(); expect(value.snapshot().active).toBe(0);
});

it('reserves RAM atomically across projects and admits after physical release', async () => {
  const value = pool(() => ({ freeMB: 2500, swapUsedMB: 99999 })); // stale swap peak is not pressure by default
  const first = await value.acquire(request()); let admitted = false;
  const second = value.acquire(request('second')).then(p => { admitted = true; return p; });
  await Promise.resolve(); expect(admitted).toBe(false); expect(value.snapshot().reservedMB).toBe(1000);
  first.release(); (await second).release();
});

it('does not let stale authority consume the next slot and bounds its waiting queue', async () => {
  const value = pool(); const first = await value.acquire(request()); let current = true;
  const stale = value.acquire({ ...request(), isCurrent: () => current });
  const staleResult = expect(stale).rejects.toThrow('authority');
  const last = value.acquire(request());
  await expect(value.acquire(request())).rejects.toThrow('queue_full');
  current = false; first.release(); await staleResult; (await last).release();
});

it('expires a pressure-blocked waiter without starting work, and closes queued work', async () => {
  vi.useFakeTimers(); const value = pool(() => ({ freeMB: 100, swapUsedMB: 0 }));
  const pending = value.acquire(request()); const expired = expect(pending).rejects.toThrow('wait_timeout');
  await vi.advanceTimersByTimeAsync(110); await expired; expect(value.snapshot().active).toBe(0);
  const second = value.acquire(request()); const closed = expect(second).rejects.toThrow('closed'); value.close(); await closed;
});

it('uses one machine slot when RAM is unknown', async () => {
  const value = pool(() => null); const first = await value.acquire(request()); let admitted = false;
  const second = value.acquire(request('another')).then(p => { admitted = true; return p; });
  await Promise.resolve(); expect(admitted).toBe(false); first.release(); (await second).release();
});

it('queues Main-owned loose helpers without a mission, including direct assistant tools', async () => {
  const value = pool();
  const helper = await value.acquire({ ...request(), missionId: undefined });
  expect(helper.id).not.toBe('');
  let admitted = false;
  const assistant = value.acquire({ ...request(), missionId: undefined, sessionId: undefined }).then(p => { admitted = true; return p; });
  await Promise.resolve(); expect(admitted).toBe(false);
  helper.release(); (await assistant).release();
});
