import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { watchDarwinHeavyCommand } from './darwin-heavy-command';
let child: EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn> };
vi.mock('node:child_process', () => ({ spawn: (..._args: unknown[]) => child, execFile: vi.fn() }));
vi.mock('./darwin-pty-supervisor', () => ({ heavyJobWatchCommand: () => ({ file: '/finite/sealed-watcher', args: ['watch-heavy-job'] }), resolveDarwinPtySupervisor: () => '/finite/sealed-helper' }));
const runtime = { platform: 'darwin' as const, packaged: false, cwd: '/finite', moduleDir: '/finite' };
beforeEach(() => { child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() }); });
it('only a matching canonical receipt plus normal watcher close proves whole job exit', async () => {
 const pending = watchDarwinHeavyCommand(runtime, 42);
 child.stdout.write('NEXUS_HEAVY_JOB_READY_V1 42 17 2\n'); const claim = (await pending)!;
 expect(claim.state()).toBe('live');
 child.stdout.write('NEXUS_HEAVY_JOB_PROVED_V1 42 17 2\n'); expect(claim.state()).toBe('live');
 child.emit('close', 0, null); expect(claim.state()).toBe('gone');
});
it.each([
 ['EOF without proof', '', 0, null],
 ['watcher signal death', 'NEXUS_HEAVY_JOB_PROVED_V1 42 17 2\n', null, 'SIGKILL'],
 ['unproved helper signal receipt', '', 74, null],
 ['mismatched identity', 'NEXUS_HEAVY_JOB_PROVED_V1 42 18 2\n', 0, null],
])('%s remains unknown even when the job PID is absent', async (_name, receipt, code, signal) => {
 const pending = watchDarwinHeavyCommand(runtime, 42); child.stdout.write('NEXUS_HEAVY_JOB_READY_V1 42 17 2\n'); const claim = (await pending)!;
 if (receipt) child.stdout.write(receipt); child.emit('close', code, signal); expect(claim.state()).toBe('unknown');
});
it('a watcher that closes before installing its read-only observation never authorizes admission', async () => {
 const pending = watchDarwinHeavyCommand(runtime, 42); child.emit('close', 76, null); expect(await pending).toBeNull();
});
