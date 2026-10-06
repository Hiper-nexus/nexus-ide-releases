import path from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { ScopedShellPlan } from '../runtime/process-sandbox';
import { acquireHeavyCommandPermit, type HeavyCommandRequest } from './heavy-command-permit';
import { retainHeavyCommandPermitForProcess } from './heavy-command-process';
import type { OwnedCommandLaunch } from './owned-command-launch';

/** Windows OCI mounts only these two roots. Never pass a host drive path to
 * the Linux runner or claim an external dependency root is mounted. */
export function containerCheckArgs(args: readonly string[], root: string, sandbox: string): string[] {
  const map = (value: string): string => {
    if (!path.win32.isAbsolute(value)) return value.replaceAll('\\', '/');
    for (const [base, mounted] of [[root, '/workspace'], [sandbox, '/nexus-runtime']]) {
      const relative = path.win32.relative(base, value);
      if (relative === '') return mounted;
      if (relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative)) return `${mounted}/${relative.replaceAll('\\', '/')}`;
    }
    throw new Error('Verificação indisponível: arquivo fora dos mounts do sandbox; instale as dependências no checkout da execução.');
  };
  return args.map(arg => {
    const equal = arg.startsWith('-') ? arg.indexOf('=') : -1;
    return equal < 0 ? map(arg) : `${arg.slice(0, equal + 1)}${map(arg.slice(equal + 1))}`;
  });
}
interface Ports {
  acquire: typeof acquireHeavyCommandPermit;
  prepare: (plan: ScopedShellPlan) => Promise<OwnedCommandLaunch>;
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}
const production: Ports = {
  acquire: acquireHeavyCommandPermit,
  prepare: async plan => (await import('./owned-command-launch')).prepareOwnedCommandLaunch(plan),
  spawn,
};
export interface OwnedCheckResult {
  outputTruncated?: boolean;
  physicalExit?: Promise<void>;
  retryable?: boolean;
  exitCode: number | null; timedOut: boolean; aborted: boolean; stdout: string; stderr: string;
}

/** Per-child admission. Logical timeout returns promptly, while the Main-owned
 * lifetime retains the reservation and private HOME until physical proof. */
export async function execOwnedCheck(input: {
  plan: ScopedShellPlan; request: HeavyCommandRequest; timeoutMs: number;
}, ports: Ports = production): Promise<OwnedCheckResult> {
  const controller = new AbortController();
  let timedOut = false;
  let proveExit!: () => void;
  const physicalExit = new Promise<void>(resolve => { proveExit = resolve; });
  const result: OwnedCheckResult = { physicalExit, exitCode: null, timedOut: false, aborted: false, stdout: '', stderr: '' };
  let resolveCancellation!: (result: OwnedCheckResult) => void;
  const cancellation = new Promise<OwnedCheckResult>(resolve => { resolveCancellation = resolve; });
  const cancel = () => {
    controller.abort();
    resolveCancellation({ ...result, exitCode: null, timedOut, aborted: !timedOut, retryable: true,
      stderr: result.stderr + (timedOut ? '\nVerificação excedeu o prazo; aguardando encerramento físico antes de liberar recursos.' : '\nVerificação cancelada; recursos retidos até encerramento físico.') });
  };
  input.request.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(1, input.timeoutMs));
  timer.unref?.();
  const assertCurrent = () => {
    if (controller.signal.aborted || input.request.isCurrent?.() === false) throw new Error('check_authority_expired');
  };
  const work = (async (): Promise<OwnedCheckResult> => {
    let owned: OwnedCommandLaunch | undefined; let proc: ChildProcess | undefined;
    let stop: (() => void) | undefined;
    try {
      const permit = await ports.acquire({ ...input.request, signal: controller.signal });
      try {
        assertCurrent(); owned = await ports.prepare(input.plan); assertCurrent();
        proc = ports.spawn(owned.plan.file, owned.plan.args, {
          cwd: owned.plan.cwd, env: owned.plan.env, detached: owned.plan.detached,
          stdio: owned.stdio ?? ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch (error) {
        // Preparation can outlive cancellation. A created OCI container must
        // be physically disposed before no-spawn releases its reservation.
        if (owned) await owned.dispose();
        proveExit(); permit.release(); throw error;
      }
      const cohortExit = owned.waitForExit(proc);
      retainHeavyCommandPermitForProcess(permit, proc, { detached: owned.plan.detached, physicalExit });
      let bytes = 0;
      const capture = (field: 'stdout' | 'stderr', data: Buffer) => {
        const room = 4 * 1024 * 1024 - bytes;
        if (data.length > room) result.outputTruncated = true;
        if (room <= 0) return;
        const chunk = Buffer.from(data).subarray(0, room); bytes += chunk.length; result[field] += chunk.toString('utf8');
      };
      proc.stdout?.on('data', chunk => capture('stdout', chunk));
      proc.stderr?.on('data', chunk => capture('stderr', chunk));
      proc.on('error', error => { result.stderr += `\n${error.message}`; });
      proc.once('close', code => { result.exitCode = code; });
      stop = () => owned!.stop(proc!, 'SIGTERM');
      controller.signal.addEventListener('abort', stop, { once: true });
      if (controller.signal.aborted) stop();
      await cohortExit; await owned.dispose(); proveExit();
      assertCurrent();
    } catch (error) {
      // No admission/owner means no child exists. Unknown owner state keeps
      // physicalExit pending; the timeout result never authorizes cleanup.
      if (!owned && !proc) proveExit();
      result.retryable = Boolean(owned) || controller.signal.aborted || error instanceof Error && /^(?:heavy_command_|check_authority_expired)/.test(error.message);
      result.exitCode = null; result.stderr += `\n${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearTimeout(timer); input.request.signal?.removeEventListener('abort', cancel);
      if (stop) controller.signal.removeEventListener('abort', stop);
      result.timedOut = timedOut; result.aborted = !timedOut && Boolean(input.request.signal?.aborted);
    }
    return { ...result };
  })();
  if (input.request.signal?.aborted) cancel();
  return Promise.race([work, cancellation]);
}
