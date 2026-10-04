import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
vi.mock('../pty/pty-manager', () => ({ prepareHeavyCommandSupervisor: vi.fn() }));
import { prepareOwnedCommandLaunch } from './owned-command-launch';
const plan = { file: '/usr/bin/sandbox-exec', args: ['-p', 'fixed', '/bin/sh', '-c', 'make'],
  cwd: '/project', env: { HOME: '/private/home' }, detached: true };
function processFixture(pid: number | undefined = 123) {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, kill: vi.fn() }) as unknown as ChildProcess;
}
it('retains the sandbox and requires the signed cohort receipt, not root exit', async () => {
  const prepare = vi.fn(async () => ({ file: '/usr/bin/perl', args: ['trusted-job'] }));
  const job = await prepareOwnedCommandLaunch(plan, { platform: 'darwin', prepareDarwin: prepare });
  expect(prepare).toHaveBeenCalledWith(plan.file, plan.args);
  expect(job.plan.env).toEqual(plan.env); expect(job.plan.cwd).toBe(plan.cwd);
  const proc = processFixture(); let done = false;
  const proof = job.waitForExit(proc).then(() => { done = true; });
  proc.emit('exit', 0); await Promise.resolve(); expect(done).toBe(false);
  job.stop(proc, 'SIGKILL'); expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  proc.emit('close', 0, null); await proof; expect(done).toBe(true);
});
it('refuses a signal-killed authority and missing supervisor before execution', async () => {
  await expect(prepareOwnedCommandLaunch(plan, { platform: 'darwin', prepareDarwin: async () => null })).rejects.toThrow('unavailable');
  const job = await prepareOwnedCommandLaunch(plan, { platform: 'darwin', prepareDarwin: async () => ({ file: '/usr/bin/perl', args: [] }) });
  const proc = processFixture(); const proof = job.waitForExit(proc);
  proc.emit('close', null, 'SIGKILL'); await expect(proof).rejects.toThrow('unproven');
});
it('holds OCI physical proof after attach client closes', async () => {
  let exited!: () => void; const physical = new Promise<void>(resolve => { exited = resolve; });
  const stop = vi.fn(async () => {}); const dispose = vi.fn(async () => {});
  const job = await prepareOwnedCommandLaunch(plan, { platform: 'win32', prepareOci: async () => ({ plan,
    waitForExit: () => physical, stop, dispose }) });
  const proc = processFixture(); let done = false; const proof = job.waitForExit(proc).then(() => { done = true; });
  proc.emit('close', 0); await Promise.resolve(); expect(done).toBe(false);
  job.stop(proc, 'SIGTERM'); expect(stop).toHaveBeenCalledOnce();
  exited(); await proof; await job.dispose(); expect(dispose).toHaveBeenCalledOnce();
});
