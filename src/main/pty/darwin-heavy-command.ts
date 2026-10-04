import { execFile, spawn } from 'node:child_process';
import { heavyJobWatchCommand, resolveDarwinPtySupervisor, type DarwinPtySupervisorRuntime } from './darwin-pty-supervisor';
import type { CommandProcessState } from './owned-command-process';
export interface PhysicalCommandClaim {
  state(): CommandProcessState;
  borrow(pid: number): Promise<boolean>;
  stop?(): Promise<void>;
}
/** Host-only observation. The target is launched in its caller's existing
 * sandbox; this process only authenticates/observes the native authority. */
export async function watchDarwinHeavyCommand(runtime: DarwinPtySupervisorRuntime, pid: number): Promise<PhysicalCommandClaim | null> {
  const plan = heavyJobWatchCommand(runtime, pid);
  const watcher = spawn(plan.file, plan.args, { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['pipe', 'pipe', 'ignore'] });
  let identity: string | null = null, proved = false, state: CommandProcessState = 'unknown', raw = '';
  let settle!: (value: PhysicalCommandClaim | null) => void;
  let closed!: () => void; const completion = new Promise<void>((resolve) => closed = resolve);
  const ready = new Promise<PhysicalCommandClaim | null>((resolve) => settle = resolve);
  const timer = setTimeout(() => { settle(null); watcher.kill('SIGTERM'); }, 1_500); timer.unref?.();
  const claim: PhysicalCommandClaim = {
    state: () => state,
    async stop() {
      if (state === 'gone') return;
      if (state !== 'live') throw new Error('native_heavy_authority_exit_unproved');
      watcher.stdin.write('stop\n'); await completion;
      if (claim.state() !== 'gone') throw new Error('native_heavy_authority_exit_unproved');
    },
    async borrow(target) {
      if (state !== 'live' || !identity || !Number.isSafeInteger(target) || target <= 0) return false;
      const expected = identity.split(' ');
      const inventory = await new Promise<string | null>((resolve) => execFile(resolveDarwinPtySupervisor(runtime),
        ['inventory', '--responsible-pid', expected[0], '--responsible-unique-id', expected[1]],
        { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 1_500, maxBuffer: 8 * 1024 * 1024 }, (error, output) => resolve(error ? null : output)));
      if (state !== 'live' || !inventory) return false;
      try {
        const value = JSON.parse(inventory) as { complete: boolean; processes: Array<{ pid: number; processUniqueId: string; processIdVersion: number; responsiblePid: number; responsibleUniqueId: string; status: { name: string } }> };
        const anchor = value.processes.filter((row) => String(row.pid) === expected[0]);
        const targetRows = value.processes.filter((row) => row.pid === target);
        return value.complete === true && anchor.length === 1 && anchor[0].processUniqueId === expected[1] && String(anchor[0].processIdVersion) === expected[2] &&
          targetRows.length === 1 && String(targetRows[0].responsiblePid) === expected[0] && targetRows[0].responsibleUniqueId === expected[1] && targetRows[0].status.name !== 'zombie';
      } catch { return false; }
    },
  };
  watcher.stdout.on('data', (part: Buffer) => {
    raw += part.toString('utf8');
    if (raw.length > 1024) { state = 'unknown'; settle(null); watcher.kill('SIGTERM'); return; }
    for (;;) {
      const boundary = raw.indexOf('\n'); if (boundary < 0) return;
      const line = raw.slice(0, boundary); raw = raw.slice(boundary + 1);
      const readyLine = /^NEXUS_HEAVY_JOB_READY_V1 ([1-9]\d{0,9} [1-9]\d{0,19} [1-9]\d{0,9})$/.exec(line);
      if (readyLine && identity === null) { identity = readyLine[1]; state = 'live'; clearTimeout(timer); settle(claim); continue; }
      if (identity && line === `NEXUS_HEAVY_JOB_PROVED_V1 ${identity}`) { proved = true; continue; }
      state = 'unknown'; settle(null); watcher.kill('SIGTERM');
    }
  });
  watcher.stdin.on('error', () => { state = 'unknown'; });
  watcher.once('error', () => { clearTimeout(timer); state = 'unknown'; settle(null); });
  watcher.once('close', (code, signal) => { clearTimeout(timer); state = code === 0 && signal === null && proved && raw === '' ? 'gone' : 'unknown'; settle(null); closed(); });
  return ready;
}
