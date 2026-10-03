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

it('serializes workers and worktrees of one project while independent projects can proceed', async () => {
  const value = pool(); const first = await value.acquire(request());
  let admitted = false;
  const second = value.acquire({ ...request(), scope: { ...scope, checkoutId: 'worker-checkout', rootRealPath: '/isolated' } }).then(p => { admitted = true; return p; });
  const other = await value.acquire(request('another-project'));
  await Promise.resolve(); expect(admitted).toBe(false);
  first.release(); const next = await second; expect(admitted).toBe(true);
  next.release(); other.release(); expect(value.snapshot().active).toBe(0);
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

it('uses one machine slot when RAM is unknown and bypasses unowned operator commands', async () => {
  const value = pool(() => null); const first = await value.acquire(request()); let admitted = false;
  const second = value.acquire(request('another')).then(p => { admitted = true; return p; });
  const user = await value.acquire({ ...request(), missionId: undefined }); expect(user.id).toBe('');
  await Promise.resolve(); expect(admitted).toBe(false); first.release(); (await second).release();
});
