import { ChildProcess } from 'node:child_process';
import type { ScopedShellPlan } from '../../runtime/process-sandbox';
import type { OwnedCommandLaunch } from '../owned-command-launch';

/** Scheduler/authority fixtures use finite, self-owned processes. Platform
 * supervisor coverage lives in its own real native/namespace suites. */
export async function groupFixtureLaunch(plan: ScopedShellPlan): Promise<OwnedCommandLaunch> {
  return { plan,
    waitForExit: proc => new Promise(resolve => {
      proc.once('close', () => {
        if (!(proc instanceof ChildProcess) || !plan.detached || !proc.pid || process.platform === 'win32') { resolve(); return; }
        const check = () => {
          try { process.kill(-proc.pid!, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { resolve(); return; } }
          setTimeout(check, 10);
        };
        check();
      });
    }),
    stop: (proc, signal) => {
      if (proc instanceof ChildProcess && proc.pid && plan.detached && process.platform !== 'win32') {
        try { process.kill(-proc.pid, signal); return; } catch {}
      }
      try { proc.kill(signal); } catch {}
    }, dispose: async () => {},
  };
}
