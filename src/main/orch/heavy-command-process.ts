import type { ChildProcess } from 'node:child_process';
import type { HeavyCommandPermit } from './heavy-command-permit';

function groupExists(pid: number): boolean | null {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
}

/** Physical close releases a root; detached POSIX jobs also retain their group. */
export function retainHeavyCommandPermitForProcess(permit: HeavyCommandPermit, proc: ChildProcess, options: {
  readonly detached: boolean;
  readonly platform?: NodeJS.Platform;
  readonly groupExists?: (pid: number) => boolean | null;
  readonly pollMs?: number;
  readonly physicalExit?: Promise<void>;
}): void {
  if (!permit.id) return;
  const platform = options.platform ?? process.platform;
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    if (timer) clearTimeout(timer);
    proc.removeListener('close', closed);
    proc.removeListener('error', failed);
    permit.release();
  };
  const checkGroup = () => {
    if (released) return;
    let alive: boolean | null = null;
    try { alive = (options.groupExists ?? groupExists)(proc.pid!); } catch { /* unknown is not exit proof */ }
    if (alive === false) { release(); return; }
    timer = setTimeout(checkGroup, options.pollMs ?? 50);
    timer.unref?.();
  };
  const closed = () => {
    if (released) return;
    if (options.detached && platform !== 'win32' && proc.pid !== undefined) checkGroup();
    else release();
  };
  const failed = () => {
    // Node reports an unsuccessful fork without a PID. An error after a
    // successful fork does not prove that the process or its children exited.
    if (proc.pid === undefined) release();
  };
  if (options.physicalExit) {
    void options.physicalExit.then(release, () => {
      // The caller retains the command and its permit for physical retry.
    });
    return;
  }
  proc.once('close', closed);
  proc.on('error', failed);
}
