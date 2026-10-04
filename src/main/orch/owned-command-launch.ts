import type { ChildProcess, StdioOptions } from 'node:child_process';
import type { ScopedShellPlan } from '../runtime/process-sandbox';
import { prepareHeavyCommandSupervisor } from '../pty/pty-manager';
import { isProvenDarwinPtySupervisorExit, type SupervisedPtyCommand } from '../pty/darwin-pty-supervisor';
import { prepareOwnedOciCommand, type OwnedOciCommand } from './owned-oci-command';

export interface OwnedCommandLaunch {
  readonly plan: ScopedShellPlan;
  readonly stdio?: StdioOptions;
  waitForExit(proc: ChildProcess): Promise<void>;
  stop(proc: ChildProcess, signal: NodeJS.Signals): void;
  dispose(): Promise<void>;
}

interface LaunchPorts {
  platform?: NodeJS.Platform;
  prepareDarwin?: (file: string, args: readonly string[]) => Promise<SupervisedPtyCommand | null>;
  prepareOci?: (plan: ScopedShellPlan) => Promise<OwnedOciCommand>;
}

/** Bind synchronously after spawn: exit alone does not prove pipes closed. */
function darwinJobExit(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const error = () => { if (proc.pid === undefined) resolve(); };
    proc.on('error', error);
    proc.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      proc.removeListener('error', error);
      if (proc.pid === undefined || isProvenDarwinPtySupervisorExit({ exitCode, signal })) resolve();
      else reject(new Error('command_descendant_exit_unproven'));
    });
  });
}

/** Main-owned MCP launch only. The existing sandbox remains inside the job. */
export async function prepareOwnedCommandLaunch(input: ScopedShellPlan, ports: LaunchPorts = {}): Promise<OwnedCommandLaunch> {
  const plan = { ...input, args: [...input.args], env: { ...input.env } };
  const platform = ports.platform ?? process.platform;
  if (platform === 'darwin') {
    const command = await (ports.prepareDarwin ?? prepareHeavyCommandSupervisor)(plan.file, plan.args);
    if (!command || command.file !== '/usr/bin/perl') throw new Error('command_supervisor_unavailable');
    return {
      plan: { ...plan, file: command.file, args: [...command.args] },
      waitForExit: darwinJobExit,
      // SIGKILL would remove the only cohort proof authority. Stage zero
      // forwards TERM and waits for the native fixed-point teardown receipt.
      stop: (proc) => { if (proc.exitCode == null && proc.signalCode == null) { try { proc.kill('SIGTERM'); } catch {} } },
      dispose: async () => {},
    };
  }
  if (platform === 'win32') {
    const owned = await (ports.prepareOci ?? prepareOwnedOciCommand)(plan);
    return { plan: owned.plan, waitForExit: proc => owned.waitForExit(proc),
      stop: () => { void owned.stop().catch(() => {}); }, dispose: async () => { await owned.dispose(); } };
  }
  if (platform === 'linux') {
    const { prepareOwnedLinuxCommand } = await import('./owned-linux-command');
    const owned = await prepareOwnedLinuxCommand(plan);
    return { plan: owned.plan, stdio: owned.stdio, waitForExit: proc => owned.waitForExit(proc),
      stop: () => { void owned.stop().catch(() => {}); }, dispose: async () => { owned.dispose(); } };
  }
  throw new Error('command_physical_lifetime_unavailable');
}
