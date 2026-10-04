import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareOwnedLinuxCommand, type LinuxCommandIo } from './owned-linux-command';
import { buildLinuxBubblewrapPlan, type ScopedShellPlan } from '../runtime/process-sandbox';

const canonical = (): ScopedShellPlan => ({ file: '/usr/bin/bwrap', detached: true, cwd: '/project', env: {}, args: ['--die-with-parent', '--new-session', '--unshare-all', '--share-net', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--bind', '/project', '/project', '--chdir', '/project', '--cap-drop', 'ALL', '--', '/bin/sh', '-c', 'true'] });
function stat(pid: number, parent: number, group: number, state = 'S', birth = '12345') {
  return `${pid} (bwrap with ) name) ${[state, parent, group, group, ...Array(15).fill(0), birth, 0].join(' ')}\n`;
}
function fixture() {
  const info = new PassThrough(), block = new PassThrough(), sync = new PassThrough();
  const writes: string[] = []; block.on('data', bytes => writes.push(String(bytes)));
  const proc = Object.assign(new EventEmitter(), { pid: 100, exitCode: null as number | null, signalCode: null as string | null,
    stdio: [null, null, null, info, block, sync], kill: vi.fn(() => true) });
  let state = 'S'; let birth = '12345'; let error: string | null = null; let initUid = 501;
  const paths: string[] = []; const signals: number[] = []; const closed: number[] = [];
  const io: LinuxCommandIo = {
    mainPid: 50, uid: 501,
    resolve: async () => '/usr/bin/bwrap',
    open: async pid => { paths.push(`open:${pid}`); return pid; },
    read: async (fd, name) => {
      paths.push(`${fd}:${name}`);
      if (fd === 101 && error) throw Object.assign(new Error(error), { code: error });
      if (name === 'stat') return fd === 100 ? stat(100, 50, 100) : stat(101, 100, 100, state, birth);
      const uid = fd === 101 ? initUid : 501;
      return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nNSpid:\t${fd}${fd === 101 ? '\t1' : ''}\n`;
    },
    link: async (_fd, name) => name === 'exe' ? '/usr/bin/bwrap' : 'pid:[4000]',
    close: async fd => { closed.push(fd); },
    signalGroup: pid => { signals.push(pid); },
  };
  return { proc, info, block, sync, io, writes, paths, signals, closed,
    state: (value: string) => { state = value; }, birth: (value: string) => { birth = value; }, error: (value: string | null) => { error = value; }, initUid: (value: number) => { initUid = value; } };
}
async function ticks() { await new Promise(resolve => setTimeout(resolve, 10)); }
const controllers: ReturnType<typeof prepareOwnedLinuxCommand>[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); });
function prepare(f: ReturnType<typeof fixture>) { const c = prepareOwnedLinuxCommand(canonical(), { io: f.io, pollMs: 5 }); controllers.push(c); return c; }
function report(f: ReturnType<typeof fixture>, payload = '{"child-pid":101,"pid-namespace":4001}') { f.info.end(payload); }

describe('owned Bubblewrap namespace lifetime', () => {
  it('settles a matched PID1 already zombie during capture without opening its gate', async () => {
    const f = fixture(); f.state('Z'); const c = prepare(f);
    const proof = c.waitForExit(f.proc as unknown as ChildProcess);
    report(f); await ticks(); expect(f.paths).toContain('101:status'); expect(f.writes).toEqual([]);
    f.proc.exitCode = 1; f.proc.emit('close', 1, null);
    const result = await Promise.race([proof.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 20))]);
    expect(result).toBe('settled'); expect(f.closed).toEqual([100, 101]);
  });
  it('detaches pinned descriptors before asynchronous close so concurrent dispose cannot close a reused fd', async () => {
    const f = fixture(); let finishClose!: () => void;
    const closing = new Promise<void>(resolve => { finishClose = resolve; });
    f.io.close = async fd => { f.closed.push(fd); if (fd === 100) await closing; };
    const c = prepare(f); const proof = c.waitForExit(f.proc as unknown as ChildProcess);
    report(f); await ticks(); f.state('Z'); f.proc.emit('close', 0, null); await ticks();
    c.dispose(); await ticks(); expect(f.closed).toEqual([100]);
    finishClose(); await proof; expect(f.closed).toEqual([100, 101]);
  });
  it('rejects oversized info and binds only one ChildProcess', async () => {
    const f = fixture(); const c = prepare(f);
    void c.waitForExit(f.proc as unknown as ChildProcess);
    expect(() => c.waitForExit(fixture().proc as unknown as ChildProcess)).toThrow(/already bound/);
    report(f, 'x'.repeat(16_385)); await ticks(); expect(f.paths).toEqual([]); expect(f.writes).toEqual([]);
  });

  it('never signals an exited owning child even if its numeric PID is later reused', async () => {
    const f = fixture(); const c = prepare(f); const proof = c.waitForExit(f.proc as unknown as ChildProcess);
    report(f); await ticks(); f.proc.exitCode = 0; f.proc.emit('exit', 0, null); void c.stop();
    expect(f.proc.kill).not.toHaveBeenCalled(); expect(f.signals).toEqual([]);
    f.error('ESRCH'); f.proc.emit('close', 0, null); await proof;
  });

  it('requires close even when pinned PID1 already disappeared', async () => {
    const f = fixture(); const c = prepare(f); let done = false;
    const proof = c.waitForExit(f.proc as unknown as ChildProcess).then(() => { done = true; }); report(f); await ticks();
    f.error('ENOENT'); await ticks(); expect(done).toBe(false);
    f.proc.emit('close', 0, null); await proof;
  });

  it('resolves a failed fork only with no child PID and actual close', async () => {
    const f = fixture(); Object.assign(f.proc, { pid: undefined }); const c = prepare(f);
    let done = false; const proof = c.waitForExit(f.proc as unknown as ChildProcess).then(() => { done = true; });
    f.proc.emit('error', Object.assign(new Error('missing binary'), { code: 'ENOENT' })); await ticks(); expect(done).toBe(false);
    f.proc.emit('close', -2, null); await proof; expect(done).toBe(true);
  });
  it('waits through UID-map setup while keeping the gate and pinned birth intact', async () => {
    const f = fixture(); f.initUid(65534); const c = prepare(f);
    const proof = c.waitForExit(f.proc as unknown as ChildProcess); report(f);
    await ticks(); expect(f.writes).toEqual([]);
    f.initUid(501); await ticks(); expect(f.writes).toEqual(['1']);
    expect(f.paths.filter(value => value === 'open:101')).toHaveLength(1);
    f.state('Z'); f.proc.emit('close', 0, null); await proof;
  });
  it('prepares pure private FD options and preserves the canonical confinement', () => {
    const f = fixture(); const original = canonical(); const c = prepareOwnedLinuxCommand(original, { io: f.io }); controllers.push(c);
    expect(f.paths).toEqual([]);
    expect(c.plan.args).toEqual([...original.args.slice(0, -4), '--info-fd', '3', '--block-fd', '4', '--sync-fd', '5', ...original.args.slice(-4)]);
    expect(c.stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']);
  });

  it.each(['--as-pid-1', '--pidns', '--info-fd', '--block-fd', '--sync-fd', '--args'])('rejects ambiguous caller wrapper options %s', option => {
    const plan = canonical(); plan.args.splice(3, 0, option, '9'); expect(() => prepareOwnedLinuxCommand(plan)).toThrow();
  });

  it('opens owned proc identities before gate release and needs pinned init death plus actual close', async () => {
    const f = fixture(); const c = prepare(f); let done = false;
    const proof = c.waitForExit(f.proc as unknown as ChildProcess).then(() => { done = true; });
    report(f); await ticks(); expect(f.writes).toEqual(['1']);
    expect(f.paths).toContain('101:stat'); expect(f.paths).toContain('101:status');
    f.sync.end(); f.proc.emit('close', 0, null); await ticks(); expect(done).toBe(false);
    f.state('Z'); await proof; expect(done).toBe(true);
  });

  it('cancels before handshake only after pinning, killing the unreaped owned group without releasing the gate', async () => {
    const f = fixture(); const c = prepare(f); void c.stop();
    const proof = c.waitForExit(f.proc as unknown as ChildProcess);
    expect(f.signals).toEqual([]); report(f); await ticks();
    expect(f.signals).toEqual([-100]); expect(f.writes).toEqual([]); expect(f.proc.kill).not.toHaveBeenCalled();
    f.error('ESRCH'); f.proc.emit('close', 0, null); await proof;
  });

  it('stops after gate through the exact ChildProcess handle and never signals numeric init PID', async () => {
    const f = fixture(); const c = prepare(f); const proof = c.waitForExit(f.proc as unknown as ChildProcess);
    report(f); await ticks(); void c.stop(); expect(f.proc.kill).toHaveBeenCalledWith('SIGKILL'); expect(f.signals).toEqual([]);
    f.state('Z'); f.proc.emit('close', 0, null); await proof;
  });

  it('retains unknown identity and never releases exec or disposes the gate on malformed trusted info', async () => {
    const f = fixture(); const c = prepare(f); let done = false;
    void c.waitForExit(f.proc as unknown as ChildProcess).then(() => { done = true; });
    report(f, '{"child-pid":101,"pid-namespace":4000}'); await ticks(); c.dispose();
    expect(f.writes).toEqual([]); expect(f.block.destroyed).toBe(false); f.proc.emit('close', 0, null); await ticks(); expect(done).toBe(false);
  });

  it('does not reinterpret a replaced birth or permission error as disappearance', async () => {
    const f = fixture(); const c = prepare(f); let done = false;
    void c.waitForExit(f.proc as unknown as ChildProcess).then(() => { done = true; }); report(f); await ticks();
    f.birth('99999'); f.proc.emit('close', 0, null); await ticks(); expect(done).toBe(false);
    f.error('EACCES'); await ticks(); expect(done).toBe(false);
    f.error('ESRCH'); await ticks(); expect(done).toBe(false);
  });
});

// Explicit Linux CI fixture; macOS injected tests never claim real bwrap proof.
it.runIf(process.platform === 'linux' && process.env.NEXUS_LINUX_OWNED_COMMAND_TEST === '1')('captures real namespace PID1 before exec and proves reparented setsid teardown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-f869-linux-'));
  const sandbox = path.join(root, 'sandbox'); await fs.mkdir(sandbox, { mode: 0o700 });
  const plan = buildLinuxBubblewrapPlan({ platform: 'linux', executable: '/bin/sh',
    args: ['-c', "setsid sh -c 'sleep 5' >/dev/null 2>&1 & printf 'fixture-started\\n'; exit 0"],
    rootRealPath: root, cwd: root, sandboxDir: sandbox, env: { PATH: '/usr/bin:/bin' }, sandboxProfile: 'workspace-net',
  }, '/usr/bin/bwrap');
  const owned = prepareOwnedLinuxCommand(plan);
  const proc = spawn(owned.plan.file, owned.plan.args, { cwd: owned.plan.cwd, env: owned.plan.env, detached: true, stdio: owned.stdio });
  const proof = owned.waitForExit(proc); let output = ''; proc.stdout?.on('data', chunk => { output += String(chunk); });
  try { await proof; expect(output).toContain('fixture-started'); }
  finally { void owned.stop(); owned.dispose(); await fs.rm(root, { recursive: true, force: true }); }
}, 15_000);
