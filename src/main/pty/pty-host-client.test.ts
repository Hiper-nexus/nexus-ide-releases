import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ child: null as EventEmitter & { kill: () => boolean } | null, stop: Promise.resolve() as Promise<void> }));
vi.mock('electron', () => ({ utilityProcess: { fork: () => h.child } }));
vi.mock('./pty-analysis-runtime', () => ({ startPtyAnalysis: () => {}, shutdownPtyAnalysis: () => h.stop }));
import { createRealPtyHost, shutdownPtyHost } from './pty-host-client';
function fixture() {
  const child = Object.assign(new EventEmitter(), { postMessage: () => {}, kill: () => true }); h.child = child;
  createRealPtyHost().spawn({ sessionId: 'finite', file: '/usr/bin/true', args: [], cwd: '/tmp', cols: 80, rows: 24, env: {} }, { onData: () => {}, onExit: () => {} });
  return child;
}
it('does not complete host shutdown until both actual exit and analysis termination settle', async () => {
  let release!: () => void; h.stop = new Promise<void>((resolve) => { release = resolve; }); const child = fixture();
  let finished = false; const stopped = shutdownPtyHost().then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false);
  child.emit('exit', 0); await Promise.resolve(); expect(finished).toBe(false);
  release(); await stopped; expect(finished).toBe(true);
});
it('surfaces unsignalled physical stop instead of fabricating a completed drain', async () => {
  h.stop = Promise.resolve(); const child = fixture(); child.kill = () => false;
  await expect(shutdownPtyHost()).rejects.toThrow('could not be signalled'); child.emit('exit', 0);
});
