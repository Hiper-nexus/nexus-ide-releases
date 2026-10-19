import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { HeavyCommandPermitPool, createHeavyCommandPressureCache, heavyCommandEffectiveCap, heavyCommandKindIsExclusive, heavyLaneBlocked, parseHeavyCommandPressureOutput } from './heavy-command-permit';
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

it('serializes builds in one checkout while worktrees of the same project run in parallel (F-983)', async () => {
  const value = pool(); const first = await value.acquire({ ...request(), kind: 'build' });
  let sameCheckout = false;
  const second = value.acquire({ ...request(), kind: 'install', sessionId: 'other-worker' }).then(p => { sameCheckout = true; return p; });
  // Parallel writers own separate worktrees: one project-wide slot made them
  // queue behind each other until the 300 s admission timeout (exit 74).
  const worktree = await value.acquire({ ...request(), scope: { ...scope, checkoutId: 'worker-checkout', rootRealPath: '/isolated' } });
  const other = await value.acquire(request('another-project'));
  await Promise.resolve(); expect(sameCheckout).toBe(false); expect(value.snapshot().active).toBe(3);
  first.release(); const next = await second; expect(sameCheckout).toBe(true);
  next.release(); worktree.release(); other.release(); expect(value.snapshot().active).toBe(0);
});

it('runs typecheck and tests of one root together, up to the machine cap', async () => {
  const value = pool();
  const first = await value.acquire(request());
  const second = await value.acquire({ ...request(), kind: 'tests', sessionId: 'reader' });
  expect(value.snapshot().active).toBe(2);
  first.release(); second.release();
});

it('does not let a later reader pass a build that is already waiting', async () => {
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {},
    pollMs: 10, waitMs: 1000, maxWaiters: 8, reserveMB: 1000, maxActive: 1 });
  pools.push(value);
  const holder = await value.acquire({ ...request(), scope: { ...scope, rootRealPath: '/other' }, kind: 'typescript' });
  let early = false, writer = false, late = false;
  const earlyPermit = value.acquire({ ...request(), kind: 'tests', sessionId: 'early' }).then(p => { early = true; return p; });
  const writerPermit = value.acquire({ ...request(), kind: 'build', sessionId: 'writer' }).then(p => { writer = true; return p; });
  const latePermit = value.acquire({ ...request(), kind: 'typescript', sessionId: 'late' }).then(p => { late = true; return p; });
  await Promise.resolve();
  expect(early || writer || late).toBe(false);
  holder.release();
  await Promise.resolve();
  expect(early).toBe(true); expect(writer).toBe(false); expect(late).toBe(false);
  (await earlyPermit).release();
  await Promise.resolve();
  expect(writer).toBe(true); expect(late).toBe(false);
  (await writerPermit).release();
  (await latePermit).release();
  expect(value.snapshot().active).toBe(0);
});

it('parks an attached waiter with a ticket and admits that same waiter on retry', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {},
    pollMs: 10, waitMs: 10_000, maxActive: 1, progressAfterMs: 20, parkMs: 45_000 });
  pools.push(value);
  const holder = await value.acquire({ ...request(), kind: 'build', sessionId: 'holder' });
  const controller = new AbortController();
  const queued = value.acquire({ ...request(), kind: 'typescript', signal: controller.signal, progressAfterMs: 20 })
    .then(() => { throw new Error('admitted'); }, (failure: Error & { ticket?: string; queue?: { blockedBy?: string; occupants?: Array<{ sessionId?: string; kind?: string }> } }) => failure);
  await vi.advanceTimersByTimeAsync(20);
  const failure = await queued;
  expect(failure.message).toBe('heavy_command_queued');
  expect(failure.ticket).toMatch(/^hq-[0-9a-f-]{36}$/i);
  expect(failure.queue?.blockedBy).toBe('exclusive');
  expect(failure.queue?.occupants?.[0]).toMatchObject({ sessionId: 'holder', kind: 'build' });
  controller.abort();
  expect(value.snapshot().waiting).toBe(1);
  let admitted = false;
  const retry = value.acquire({ ...request(), kind: 'typescript', queueTicket: failure.ticket, progressAfterMs: 20 })
    .then(permit => { admitted = true; return permit; });
  await Promise.resolve();
  expect(admitted).toBe(false);
  holder.release();
  (await retry).release();
  expect(admitted).toBe(true);
});

it('drops a parked waiter that nobody reattaches, then a new ticket waits fresh', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {},
    pollMs: 10, waitMs: 10_000, maxActive: 1, progressAfterMs: 20, parkMs: 45_000 });
  pools.push(value);
  const holder = await value.acquire({ ...request(), kind: 'build' });
  const queued = value.acquire({ ...request(), progressAfterMs: 20 }).then(() => { throw new Error('admitted'); }, (failure: Error & { ticket?: string }) => failure);
  await vi.advanceTimersByTimeAsync(20);
  const failure = await queued;
  await vi.advanceTimersByTimeAsync(45_000);
  expect(value.snapshot().waiting).toBe(0);
  let admitted = false;
  const fresh = value.acquire({ ...request(), queueTicket: failure.ticket }).then(permit => { admitted = true; return permit; });
  await Promise.resolve();
  expect(admitted).toBe(false);
  holder.release();
  (await fresh).release();
  expect(admitted).toBe(true);
});

it('classifies exclusive kinds and a writer already ahead of a reader', () => {
  expect(heavyCommandKindIsExclusive('build')).toBe(true);
  expect(heavyCommandKindIsExclusive('install')).toBe(true);
  expect(heavyCommandKindIsExclusive('typescript')).toBe(false);
  expect(heavyCommandKindIsExclusive('tests')).toBe(false);
  expect(heavyLaneBlocked({ kind: 'typescript', occupants: [{ kind: 'tests' }], earlierExclusive: false })).toBe(false);
  expect(heavyLaneBlocked({ kind: 'typescript', occupants: [{ kind: 'build' }], earlierExclusive: false })).toBe(true);
  expect(heavyLaneBlocked({ kind: 'tests', occupants: [], earlierExclusive: true })).toBe(true);
  expect(heavyLaneBlocked({ kind: 'build', occupants: [{ kind: 'typescript' }], earlierExclusive: false })).toBe(true);
  expect(heavyLaneBlocked({ kind: 'install', occupants: [], earlierExclusive: false })).toBe(false);
});

it('F-1229: a wait timeout carries how long it waited and what held its root or the machine', async () => {
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10, waitMs: 60, reserveMB: 1000, maxActive: 2 });
  pools.push(value);
  const lane = (root: string) => ({ ...request(), scope: { ...scope, rootRealPath: root } });
  const timedOut = (root: string) => value.acquire(lane(root))
    .then(() => { throw new Error('unexpected admission'); }, (failure: Error & { queue?: { waitedMs: number } }) => failure);
  const held = await value.acquire({ ...lane('/wt'), kind: 'build', sessionId: 'holder' });
  const sameRoot = await timedOut('/wt');
  expect(sameRoot.message).toBe('heavy_command_wait_timeout');
  expect(sameRoot).toMatchObject({ queue: { root: '/wt', running: 1, waiting: 0, machineActive: 1, maxActive: 2, blockedBy: 'exclusive' } });
  expect(sameRoot.queue && 'occupants' in sameRoot.queue ? sameRoot.queue.occupants : []).toMatchObject([{ sessionId: 'holder', kind: 'build' }]);
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
  const active = await value.acquire({ ...request(), kind: 'build', signal: activeController.signal });
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
  const value = pool(); const first = await value.acquire({ ...request(), kind: 'build' }); let current = true;
  const stale = value.acquire({ ...request(), kind: 'build', isCurrent: () => current });
  const staleResult = expect(stale).rejects.toThrow('authority');
  const last = value.acquire({ ...request(), kind: 'build' });
  await expect(value.acquire({ ...request(), kind: 'build' })).rejects.toThrow('queue_full');
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

it('maps dispatch vm pressure onto the configured machine cap', () => {
  expect(heavyCommandEffectiveCap(5, 1)).toBe(5);
  expect(heavyCommandEffectiveCap(5, 2)).toBe(2);
  expect(heavyCommandEffectiveCap(5, 4)).toBe(1);
  expect(heavyCommandEffectiveCap(1, 2)).toBe(1);
  expect(heavyCommandEffectiveCap(1, 4)).toBe(1);
  for (const level of [null, 0, 3, 9, -1]) expect(heavyCommandEffectiveCap(5, level)).toBe(5);
});

it('shrinks new admissions under darwin memory pressure and leaves running jobs alone', async () => {
  let level: number | null = 1;
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {},
    pollMs: 10, waitMs: 500, reserveMB: 1000, maxActive: 5, pressure: () => level });
  pools.push(value);
  const lane = (root: string) => ({ ...request(), scope: { ...scope, rootRealPath: root } });
  const normal = await Promise.all(['/n1', '/n2', '/n3'].map((root) => value.acquire(lane(root))));
  expect(value.snapshot().active).toBe(3);
  level = 2;
  let warned = false;
  const warnWait = value.acquire(lane('/warn')).then((permit) => { warned = true; return permit; });
  await Promise.resolve();
  expect(warned).toBe(false);
  expect(value.snapshot().active).toBe(3);
  normal[0].release();
  await Promise.resolve();
  expect(warned).toBe(false);
  expect(value.snapshot().active).toBe(2);
  normal[1].release();
  const warnedPermit = await warnWait;
  expect(warned).toBe(true);
  expect(value.snapshot().active).toBe(2);
  warnedPermit.release(); normal[2].release();
  level = null;
  const running = await Promise.all(['/live-a', '/live-b'].map((root) => value.acquire(lane(root))));
  expect(value.snapshot().active).toBe(2);
  level = 4;
  let extra = false;
  const criticalWait = value.acquire(lane('/critical')).then((permit) => { extra = true; return permit; });
  await Promise.resolve();
  expect(extra).toBe(false);
  running[0].release();
  await Promise.resolve();
  expect(extra).toBe(false);
  expect(value.snapshot().active).toBe(1);
  level = 3;
  const opened = value.acquire(lane('/opened')).then((permit) => permit);
  await Promise.resolve();
  expect(extra).toBe(true);
  expect(value.snapshot().active).toBe(3);
  (await criticalWait).release();
  (await opened).release();
  running[1].release();
  expect(value.snapshot().active).toBe(0);
});

it('parses a sysctl pressure line and rejects anything that is not an integer', () => {
  expect(parseHeavyCommandPressureOutput('1\n')).toBe(1);
  expect(parseHeavyCommandPressureOutput(' 4 ')).toBe(4);
  expect(parseHeavyCommandPressureOutput('1.5')).toBeNull();
  expect(parseHeavyCommandPressureOutput('nope')).toBeNull();
});

it('refreshes the pressure sample asynchronously, at most once every 3s', () => {
  let now = 0;
  const pending: Array<(level: number | null) => void> = [];
  let calls = 0;
  const read = createHeavyCommandPressureCache({
    now: () => now, intervalMs: 3_000, platform: 'darwin',
    probe: (callback) => { calls += 1; pending.push(callback); },
  });
  expect(read()).toBeNull();
  expect(read()).toBeNull();
  expect(calls).toBe(1);
  pending[0](1);
  expect(read()).toBe(1);
  now = 2_999;
  expect(read()).toBe(1);
  expect(calls).toBe(1);
  now = 3_000;
  expect(read()).toBe(1);
  expect(calls).toBe(2);
  now = 9_000;
  expect(read()).toBe(1);
  expect(calls).toBe(2);
  pending[1](null);
  expect(read()).toBeNull();
  expect(calls).toBe(3);
  expect(read()).toBeNull();
  expect(calls).toBe(3);
  let linuxCalls = 0;
  const linux = createHeavyCommandPressureCache({
    platform: 'linux', probe: () => { linuxCalls += 1; },
  });
  expect(linux()).toBeNull();
  expect(linuxCalls).toBe(0);
});

it('keeps the configured cap when memory pressure cannot be read', async () => {
  const readers = [() => null, () => 0, () => 1.5, () => 9, () => { throw new Error('sysctl'); }];
  for (const pressure of readers) {
    const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
      limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {},
      pollMs: 10, waitMs: 200, reserveMB: 1000, maxActive: 5, pressure });
    pools.push(value);
    const lane = (root: string) => ({ ...request(), scope: { ...scope, rootRealPath: root } });
    const held = await Promise.all(['/p1', '/p2', '/p3'].map((root) => value.acquire(lane(root))));
    expect(value.snapshot().active).toBe(3);
    for (const permit of held) permit.release();
  }
});

it('queues Main-owned loose helpers without a mission, including direct assistant tools', async () => {
  const value = pool();
  const helper = await value.acquire({ ...request(), missionId: undefined, kind: 'build' });
  expect(helper.id).not.toBe('');
  let admitted = false;
  const assistant = value.acquire({ ...request(), missionId: undefined, sessionId: undefined }).then(p => { admitted = true; return p; });
  await Promise.resolve(); expect(admitted).toBe(false);
  helper.release(); (await assistant).release();
});

// Ghost lock: the native watcher releases a slot only through its own cohort
// proof. A caller that dies while executor/authority processes are re-parented
// to a daemon never delivers that proof, and the exclusive lease outlives the
// job — every other worker of the root waits forever.
it('expires a ghost exclusive lease whose executor pid is gone and admits the queued reader', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {},
    pollMs: 10, waitMs: 10_000, maxActive: 2, staleExclusiveMs: 1_000,
    executorLive: (pid) => pid !== 4242, sessionLive: () => true });
  pools.push(value);
  const ghost = await value.acquire({ ...request(), kind: 'build', sessionId: 'pty-ghost', executorPid: 4242 });
  let admitted = false;
  const reader = value.acquire({ ...request(), kind: 'typescript', sessionId: 'reader' }).then((permit) => { admitted = true; return permit; });
  await vi.advanceTimersByTimeAsync(500);
  expect(admitted).toBe(false); // the executor is dead but the TTL has not elapsed
  await vi.advanceTimersByTimeAsync(600);
  expect(admitted).toBe(true);
  ghost.release(); // a late release after expiry is a harmless no-op
  (await reader).release();
  expect(value.snapshot()).toMatchObject({ active: 0, waiting: 0 });
});

it('does not expire a live exclusive lease; expiry follows the executor pid death', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let executorLive = true;
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {},
    pollMs: 10, waitMs: 10_000, maxActive: 2, staleExclusiveMs: 1_000,
    executorLive: () => executorLive, sessionLive: () => true });
  pools.push(value);
  const holder = await value.acquire({ ...request(), kind: 'build', sessionId: 'pty-holder', executorPid: 111 });
  let admitted = false;
  const reader = value.acquire({ ...request(), kind: 'tests', sessionId: 'reader' }).then((permit) => { admitted = true; return permit; });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(admitted).toBe(false); // a job with a live executor keeps its lease
  executorLive = false;
  await vi.advanceTimersByTimeAsync(1_050);
  expect(admitted).toBe(true);
  holder.release(); (await reader).release();
  expect(value.snapshot()).toMatchObject({ active: 0, waiting: 0 });
});

it('expires a ghost exclusive lease whose executor survives re-parenting but its session closed', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const sessions = new Set(['pty-open']);
  const value = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 100_000, swapUsedMB: 0 }),
    limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {},
    pollMs: 10, waitMs: 10_000, maxActive: 2, staleExclusiveMs: 1_000,
    executorLive: () => true, sessionLive: (id) => sessions.has(id) });
  pools.push(value);
  const ghost = await value.acquire({ ...request(), kind: 'build', sessionId: 'pty-closed', executorPid: 501 });
  let admitted = false;
  const reader = value.acquire({ ...request(), kind: 'typescript', sessionId: 'reader' }).then((permit) => { admitted = true; return permit; });
  await vi.advanceTimersByTimeAsync(1_100);
  expect(admitted).toBe(true);
  ghost.release(); (await reader).release();
  expect(value.snapshot()).toMatchObject({ active: 0, waiting: 0 });
});
