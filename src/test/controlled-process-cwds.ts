import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProcessCwdDeps } from '../main/runtime/process-cwds';

/** Only this runner and its declared children; cwd reads still reach the OS. */
export function controlledProcessCwds(children: readonly number[]): {
  deps: ProcessCwdDeps;
  dispose(): void;
} {
  const pids = [...new Set([process.pid, ...children])];
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('invalid fixture PID');
  if (process.platform === 'linux') {
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-controlled-proc-'));
    try {
      for (const pid of pids) fs.symlinkSync(`/proc/${pid}`, path.join(procRoot, String(pid)));
    } catch (error) {
      fs.rmSync(procRoot, { recursive: true, force: true });
      throw error;
    }
    return { deps: { procRoot }, dispose: () => fs.rmSync(procRoot, { recursive: true, force: true }) };
  }
  if (process.platform !== 'darwin') throw new Error('controlled cwd fixture requires POSIX');
  return {
    deps: { exec: (command, _args, timeoutMs) => new Promise(resolve => {
      const args = command === '/bin/ps'
        ? ['-p', pids.join(','), '-o', 'pid=,uid=,stat=']
        : ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'];
      execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => {
        const status = !error ? 0 : typeof error.code === 'number' && !error.killed ? error.code : null;
        resolve({ status, stdout });
      });
    }) },
    dispose: () => {},
  };
}
