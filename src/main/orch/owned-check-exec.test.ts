import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import { execOwnedCheck } from './owned-check-exec';
import type { OwnedCommandLaunch } from './owned-command-launch';
import type { ProjectExecutionScope } from '../../shared/types';

const scope: ProjectExecutionScope = { version: 1, identitySource: 'manifest', installationId: 'install', projectId: 'project', checkoutId: 'checkout', rootRealPath: '/project' };
const plan = { file: '/node', args: ['check.js'], cwd: '/project', env: {}, detached: true };
const pools: HeavyCommandPermitPool[] = [];
afterEach(() => { for (const pool of pools.splice(0)) pool.close(); vi.useRealTimers(); });
function fixture() {
  const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 20_000, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 1000, maxSwapUsedMB: 0 }), refreshMemory: async () => {} });
  pools.push(pool);
  const proc = new ChildProcess(); Object.defineProperty(proc, 'pid', { value: 54321 });
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  let exited!: () => void; const physical = new Promise<void>(resolve => { exited = resolve; });
  const owned: OwnedCommandLaunch = { plan, waitForExit: () => physical, stop: vi.fn(), dispose: vi.fn(async () => {}) };
  const spawn = vi.fn(() => proc);
  const ports = { acquire: pool.acquire.bind(pool), prepare: vi.fn(async () => owned), spawn };
  return { pool, proc, exited, owned, ports };
}
const request = { scope, kind: 'tests' as const };

it('serializes checks with native validators until physical descendants exit', async () => {
  const f = fixture(); const running = execOwnedCheck({ plan, request, timeoutMs: 10_000 }, f.ports);
  await vi.waitFor(() => expect(f.ports.spawn).toHaveBeenCalledOnce());
  let admitted = false; const next = f.pool.acquire({ ...request, kind: 'typescript' }).then(p => { admitted = true; return p; });
  f.proc.emit('close', 0, null); await Promise.resolve(); expect(admitted).toBe(false);
  expect(f.pool.snapshot().active).toBe(1);
  f.exited(); expect(await running).toMatchObject({ exitCode: 0, timedOut: false });
  (await next).release(); expect(admitted).toBe(true);
});

it('abort returns promptly but does not release before physical proof', async () => {
  const f = fixture(); const controller = new AbortController(); let finished = false;
  const running = execOwnedCheck({ plan, request: { ...request, signal: controller.signal }, timeoutMs: 10_000 }, f.ports).then(r => { finished = true; return r; });
  await vi.waitFor(() => expect(f.ports.spawn).toHaveBeenCalledOnce());
  controller.abort(); f.proc.emit('error', new Error('AbortError')); f.proc.emit('close', null, 'SIGTERM');
  const result = await running; expect(f.owned.stop).toHaveBeenCalled(); expect(f.pool.snapshot().active).toBe(1); expect(finished).toBe(true);
  expect(result).toMatchObject({ exitCode: null, aborted: true }); f.exited(); await result.physicalExit; await Promise.resolve(); expect(f.pool.snapshot().active).toBe(0);
});

it('cancellation queued behind another command never spawns or consumes its permit', async () => {
  const f = fixture(); const active = await f.pool.acquire(request); const controller = new AbortController();
  const running = execOwnedCheck({ plan, request: { ...request, signal: controller.signal }, timeoutMs: 10_000 }, f.ports);
  controller.abort(); expect(await running).toMatchObject({ exitCode: null, aborted: true });
  expect(f.ports.spawn).not.toHaveBeenCalled(); expect(f.pool.snapshot().active).toBe(1); active.release();
});

it('revalidates authority after async preparation and releases only after no-spawn disposal', async () => {
  const f = fixture(); let current = true; f.ports.prepare.mockImplementation(async () => { current = false; return f.owned; });
  expect(await execOwnedCheck({ plan, request: { ...request, isCurrent: () => current }, timeoutMs: 10_000 }, f.ports)).toMatchObject({ exitCode: null });
  expect(f.ports.spawn).not.toHaveBeenCalled(); expect(f.owned.dispose).toHaveBeenCalledOnce(); expect(f.pool.snapshot().active).toBe(0);
});

it('synchronous spawn failure disposes ownership and frees the unused slot', async () => {
  const f = fixture(); f.ports.spawn.mockImplementation(() => { throw new Error('fork failed'); });
  expect(await execOwnedCheck({ plan, request, timeoutMs: 10_000 }, f.ports)).toMatchObject({ exitCode: null, stderr: expect.stringContaining('fork failed') });
  expect(f.owned.dispose).toHaveBeenCalledOnce(); expect(f.pool.snapshot().active).toBe(0);
});

it('timeout includes queue admission and cannot launch after its deadline', async () => {
  vi.useFakeTimers(); const f = fixture(); const active = await f.pool.acquire(request);
  const running = execOwnedCheck({ plan, request, timeoutMs: 100 }, f.ports);
  await vi.advanceTimersByTimeAsync(101); expect(await running).toMatchObject({ timedOut: true, exitCode: null });
  expect(f.ports.spawn).not.toHaveBeenCalled(); active.release();
});

it('unproved cohort exit retains reservation and exposes no successful cleanup proof', async () => {
  const f = fixture(); let reject!: (error: Error) => void;
  const proof = new Promise<void>((_, fail) => { reject = fail; }); f.owned.waitForExit = () => proof;
  const running = execOwnedCheck({ plan, request, timeoutMs: 10_000 }, f.ports);
  await vi.waitFor(() => expect(f.ports.spawn).toHaveBeenCalledOnce());
  f.proc.emit('close', 0, null); reject(new Error('physical state unknown'));
  const result = await running; expect(result.exitCode).toBeNull(); expect(result.physicalExit).toBeInstanceOf(Promise);
  expect(f.pool.snapshot().active).toBe(1); expect(f.owned.dispose).not.toHaveBeenCalled();
});

it('times out during preparation but disposes its late owner before releasing', async () => {
  vi.useFakeTimers(); const f = fixture(); let prepared!: (value: OwnedCommandLaunch) => void;
  f.ports.prepare.mockImplementation(() => new Promise(resolve => { prepared = resolve; }));
  const running = execOwnedCheck({ plan, request, timeoutMs: 100 }, f.ports);
  await vi.advanceTimersByTimeAsync(101); const result = await running;
  expect(result.timedOut).toBe(true); expect(f.pool.snapshot().active).toBe(1); expect(f.ports.spawn).not.toHaveBeenCalled();
  prepared(f.owned); await result.physicalExit; await Promise.resolve();
  expect(f.owned.dispose).toHaveBeenCalledOnce(); expect(f.pool.snapshot().active).toBe(0);
});

it('queued mission authority revocation prevents preparation and spawn', async () => {
  const f = fixture(); const active = await f.pool.acquire(request); let current = true;
  const running = execOwnedCheck({ plan, request: { ...request, isCurrent: () => current }, timeoutMs: 10_000 }, f.ports);
  current = false; active.release();
  expect(await running).toMatchObject({ exitCode: null, retryable: true });
  expect(f.ports.prepare).not.toHaveBeenCalled(); expect(f.ports.spawn).not.toHaveBeenCalled();
});

it('marks output truncation so native parsers cannot approve a complete-looking prefix', async () => {
  const f = fixture(); const running = execOwnedCheck({ plan, request, timeoutMs: 10_000 }, f.ports);
  await vi.waitFor(() => expect(f.ports.spawn).toHaveBeenCalledOnce());
  f.proc.stdout!.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1, 'a'));
  f.proc.emit('close', 0, null); f.exited();
  expect(await running).toMatchObject({ exitCode: 0, outputTruncated: true });
});
