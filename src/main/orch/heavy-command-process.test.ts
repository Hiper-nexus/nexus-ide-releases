import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { retainHeavyCommandPermitForProcess } from './heavy-command-process';

afterEach(() => vi.useRealTimers());
function child(pid?: number): ChildProcess & EventEmitter {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }) as ChildProcess & EventEmitter;
}
it('releases a failed spawn without a PID but retains a live process after an error', () => {
  const failed = child(undefined); const release = vi.fn();
  retainHeavyCommandPermitForProcess({ id: 'heavy', release }, failed, { detached: true });
  failed.emit('error', new Error('spawn failed')); expect(release).toHaveBeenCalledOnce();
  const live = child(123); const physical = vi.fn();
  retainHeavyCommandPermitForProcess({ id: 'other', release: physical }, live, { detached: false });
  live.emit('error', new Error('transport failed')); expect(physical).not.toHaveBeenCalled();
  live.emit('close', 0); expect(physical).toHaveBeenCalledOnce();
});
it('holds a POSIX group through root close and through unknown liveness until absence is proved', async () => {
  vi.useFakeTimers(); const process = child(123); const release = vi.fn(); let alive: boolean | null = true;
  retainHeavyCommandPermitForProcess({ id: 'heavy', release }, process,
    { detached: true, platform: 'darwin', groupExists: () => alive, pollMs: 10 });
  process.emit('close', 0); expect(release).not.toHaveBeenCalled();
  alive = null; await vi.advanceTimersByTimeAsync(20); expect(release).not.toHaveBeenCalled();
  alive = false; await vi.advanceTimersByTimeAsync(10); expect(release).toHaveBeenCalledOnce();
  process.emit('close', 0); expect(release).toHaveBeenCalledOnce();
});
