import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { ScopedShellPlan } from '../runtime/process-sandbox';
export interface LinuxCommandIo {
  mainPid: number; uid: number; resolve(file: string): Promise<string>; open(pid: number): Promise<number>;
  read(fd: number, name: 'stat' | 'status'): Promise<string>; link(fd: number, name: 'exe' | 'ns/pid'): Promise<string>;
  close(fd: number): Promise<void>; signalGroup(pid: number): void;
}
const INFO_LIMIT = 16_384;
const PROC_LIMIT = 32_768;
const privateFds = ['--info-fd', '3', '--block-fd', '4', '--sync-fd', '5'];
const pidNumber = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 1;
const handles = new Map<number, FileHandle>();
const defaultIo: LinuxCommandIo = {
  mainPid: process.pid, uid: process.getuid?.() ?? -1,
  resolve: file => fs.realpath(file),
  open: async pid => {
    const handle = await fs.open(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.set(handle.fd, handle); return handle.fd;
  },
  read: async (fd, name) => {
    const file = await fs.open(`/proc/self/fd/${fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(PROC_LIMIT + 1); let used = 0;
      while (used < bytes.length) {
        const chunk = await file.read(bytes, used, bytes.length - used, null);
        if (!chunk.bytesRead) break; used += chunk.bytesRead;
      }
      if (used > PROC_LIMIT) throw new Error('proc identity too large');
      return bytes.subarray(0, used).toString('utf8');
    } finally { await file.close(); }
  },
  link: (fd, name) => fs.readlink(`/proc/self/fd/${fd}/${name}`),
  close: async fd => { const handle = handles.get(fd); if (!handle) throw new Error('unowned proc descriptor'); handles.delete(fd); await handle.close(); },
  signalGroup: pid => { process.kill(pid, 'SIGKILL'); },
};

function canonicalDelimiter(plan: ScopedShellPlan): number {
  const at = plan.args.indexOf('--'); const pre = plan.args.slice(0, at);
  const prefix = ['--die-with-parent', '--new-session', '--unshare-all'];
  if (!path.isAbsolute(plan.file) || path.basename(plan.file) !== 'bwrap' || !plan.detached || !path.isAbsolute(plan.cwd) ||
      at < 0 || !plan.args[at + 1] || !prefix.every((arg, index) => pre[index] === arg)) throw new Error('requires canonical Main Bubblewrap plan');
  let index = 3; if (pre[index] === '--share-net') index++;
  const base = ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev'];
  if (!base.every((arg, offset) => pre[index + offset] === arg)) throw new Error('noncanonical Bubblewrap confinement');
  index += base.length;
  const arity: Record<string, number> = { '--bind': 2, '--ro-bind': 2, '--dir': 1, '--tmpfs': 1 };
  while (index < pre.length - 4) {
    const count = arity[pre[index]];
    if (!count || index + count >= pre.length - 4 || pre.slice(index + 1, index + count + 1).some(arg => !path.isAbsolute(arg) || arg.includes('\0'))) throw new Error('unexpected Bubblewrap option');
    index += count + 1;
  }
  if (pre.slice(index).join('\0') !== ['--chdir', plan.cwd, '--cap-drop', 'ALL'].join('\0')) throw new Error('noncanonical Bubblewrap command boundary');
  return at;
}
interface Birth { pid: number; parent: number; group: number; session: number; start: string; state: string }
function birth(text: string): Birth {
  const end = text.lastIndexOf(')'); const match = /^(\d+) \(/.exec(text);
  const fields = text.slice(end + 2).trim().split(/\s+/u);
  if (!match || end < 3 || fields.length < 20 || !/^[A-Zt]$/u.test(fields[0]) || !/^[1-9]\d{0,23}$/u.test(fields[19])) throw new Error('invalid proc birth');
  const row = { pid: Number(match[1]), parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: fields[19], state: fields[0] };
  if (![row.pid, row.parent, row.group, row.session].every(Number.isSafeInteger)) throw new Error('invalid proc pid');
  return row;
}
function status(text: string, pid: number, uid: number, init: boolean): void {
  const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/mu.exec(text);
  const ns = /^NSpid:\s+([\d\t ]+)$/mu.exec(text)?.[1].trim().split(/\s+/u).map(Number);
  if (!ids || !ids.slice(1).every(value => Number(value) === uid) || !ns || ns.length > 32 || ns[0] !== pid ||
      !ns.every(value => Number.isSafeInteger(value) && value > 0) || (init && (ns.length < 2 || ns.at(-1) !== 1))) throw new Error('unproved proc owner or PID1 namespace');
}

/** Main-only canonical bwrap lifetime. Preparation performs no I/O/spawn.
 * Upstream info is emitted before --block-fd; the reaper owns --sync-fd, but
 * EOF can precede kernel namespace zap. Only pinned PID1 + close release. */
export function prepareOwnedLinuxCommand(input: ScopedShellPlan, options: { io?: LinuxCommandIo; pollMs?: number } = {}): {
  plan: ScopedShellPlan; stdio: StdioOptions; waitForExit(proc: ChildProcess): Promise<void>; stop(): Promise<void>; dispose(): void;
} {
  const at = canonicalDelimiter(input); const io = options.io ?? defaultIo;
  const providerFile = input.file;
  const plan = { ...input, args: [...input.args.slice(0, at), ...privateFds, ...input.args.slice(at)], env: { ...input.env } };
  const pollMs = options.pollMs ?? 25;
  if (!Number.isFinite(pollMs) || pollMs < 1 || pollMs > 1_000) throw new Error('invalid namespace poll interval');
  let proc: ChildProcess | null = null; let outerClosed = false; let outerExited = false;
  let outerPid: number | null = null;
  let stopped = false; let gateReleased = false; let settled = false; let ambiguous = false; let initGone = false;
  let outerFd: number | null = null; let initFd: number | null = null; let expected: Birth | null = null;
  let candidate: Birth | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let block: Writable | null = null;
  let resolveProof!: () => void;
  const proof = new Promise<void>(resolve => { resolveProof = resolve; });
  const closePins = async () => {
    const owned = [outerFd, initFd];
    outerFd = null; initFd = null;
    for (const fd of owned) if (fd !== null) await io.close(fd).catch(() => {});
  };
  const complete = () => {
    if (settled || !outerClosed || !initGone || ambiguous) return;
    settled = true; if (timer) clearTimeout(timer);
    void closePins().then(resolveProof);
  };
  const aliveOuter = () => proc !== null && !outerClosed && !outerExited && proc.exitCode == null && proc.signalCode == null;
  const cancel = () => {
    if (!stopped || !expected || !aliveOuter()) return;
    try {
      if (!gateReleased) io.signalGroup(-outerPid!); // owned, unreaped detached leader; bootstrap still shares this group
      else proc!.kill('SIGKILL'); // exact ChildProcess handle, never numeric namespace PID1
    } catch { /* Unknown never releases the lifetime proof. */ }
  };
  const poll = async () => {
    if (settled || ambiguous || initFd === null || !expected) return;
    try {
      const current = birth(await io.read(initFd, 'stat'));
      if (current.pid !== expected.pid || current.start !== expected.start) { ambiguous = true; return; }
      initGone = current.state === 'Z';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') initGone = true;
    }
    complete();
    if (!settled && !initGone) { timer = setTimeout(() => { void poll(); }, pollMs); timer.unref?.(); }
  };
  const capture = async (text: string) => {
    try {
      const info = JSON.parse(text) as Record<string, unknown>;
      if (!pidNumber(info['child-pid']) || !Number.isSafeInteger(info['pid-namespace']) || Number(info['pid-namespace']) < 1 || !pidNumber(outerPid)) return;
      outerFd ??= await io.open(outerPid);
      const outer = birth(await io.read(outerFd, 'stat'));
      status(await io.read(outerFd, 'status'), outerPid, io.uid, false);
      const parentNamespace = /^pid:\[([1-9]\d*)\]$/u.exec(await io.link(outerFd, 'ns/pid'));
      if (outer.pid !== outerPid || outer.parent !== io.mainPid || outer.group !== outerPid || outer.session !== outerPid ||
          await io.link(outerFd, 'exe') !== await io.resolve(providerFile) || !parentNamespace || Number(parentNamespace[1]) === info['pid-namespace']) return;
      initFd ??= await io.open(info['child-pid']);
      const init = birth(await io.read(initFd, 'stat'));
      if (candidate && (candidate.pid !== init.pid || candidate.start !== init.start)) { ambiguous = true; return; }
      candidate ??= init;
      try { status(await io.read(initFd, 'status'), info['child-pid'], io.uid, true); }
      catch {
        // info-fd precedes UID-map/setup completion; never reopen by numeric PID.
        timer = setTimeout(() => { void capture(text); }, pollMs); timer.unref?.(); return;
      }
      const recheck = birth(await io.read(outerFd, 'stat'));
      if (init.pid !== info['child-pid'] || init.parent !== outerPid || init.group !== outerPid || init.session !== outerPid ||
          init.state === 'Z' || recheck.start !== outer.start || recheck.pid !== outer.pid || !aliveOuter()) return;
      expected = init;
      if (stopped) cancel();
      else { gateReleased = true; block!.write('1', () => {}); }
      void poll();
    } catch { /* Capture errors keep exec blocked and ownership unknown. */ }
  };
  return {
    plan, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    waitForExit(child) {
      if (proc) { if (proc !== child) throw new Error('Linux command already bound'); return proof; }
      proc = child; outerPid = pidNumber(child.pid) ? child.pid : null;
      child.once('exit', () => { outerExited = true; });
      child.once('close', () => { outerClosed = true; complete(); });
      child.on('error', () => { if (child.pid === undefined) { initGone = true; complete(); } });
      const pipes: ReadonlyArray<Readable | Writable | null | undefined> = child.stdio;
      const info = pipes[3] as Readable | null;
      block = pipes[4] as Writable | null;
      const sync = pipes[5] as Readable | null;
      if (!info || !block || !sync) return proof;
      let bytes = 0; let text = ''; let invalid = false;
      info.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > INFO_LIMIT) { invalid = true; text = ''; return; }
        if (!invalid) text += chunk.toString('utf8');
      });
      info.once('end', () => { if (!invalid) void capture(text); });
      info.on('error', () => { invalid = true; });
      block.on('error', () => { if (!expected) ambiguous = true; });
      sync.on('error', () => {}); sync.resume(); // EOF is deliberately no exit proof.
      return proof;
    },
    stop() { stopped = true; cancel(); return proof; },
    dispose() {
      // In particular, never close block-fd on ambiguity: bwrap treats EOF as
      // gate release. Authority/FDs stay retained until the pinned proof passes.
      if (!proc || settled) { if (timer) clearTimeout(timer); void closePins(); }
    },
  };
}
