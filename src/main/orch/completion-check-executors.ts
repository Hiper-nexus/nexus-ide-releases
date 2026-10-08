import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { runTypecheckSensor, runDependencyAuditSensor, type MechanicalExec, type MechanicalCheckResult } from '../context/mechanical-sensors';
import { sanitizedTestEnv, type RegressionExec } from '../regression-gate/regression-gate';
import { buildScopedExecPlan, createScopedSandboxHome } from '../runtime/process-sandbox';
import { removeTreeSync } from '../util/remove-tree';
import { assertMcpInvocationCurrent } from './mcp-protocol';
import { execOwnedCheck, containerCheckArgs, type OwnedCheckResult } from './owned-check-exec';

export { containerCheckArgs } from './owned-check-exec';
function executable(file: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(file)) return fs.realpathSync(file);
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const directory of (env.PATH ?? '').split(path.delimiter).slice(0, 128)) {
    for (const extension of extensions) {
      try {
        const candidate = fs.realpathSync(path.join(directory, `${file}${extension}`));
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* next PATH candidate */ }
    }
  }
  throw new Error(`Verificação indisponível: instale ${file} e disponibilize-o no PATH do Nexus.`);
}
const unavailable = (error: unknown): OwnedCheckResult => ({ exitCode: null, timedOut: false, aborted: false, stdout: '',
  stderr: `Verificação indisponível: ${error instanceof Error ? error.message : String(error)}. Restaure o supervisor do Nexus no macOS ou configure o sandbox de validação (Bubblewrap no Linux; runtime e imagem OCI fixada no Windows) e tente novamente.` });

/** Used only by strict Main completion. Fast sensors keep their existing API. */
export function createCompletionCheckExecutors(input: {
  scope: ProjectExecutionScope; executionScope: ProjectExecutionScope; missionId: string;
  signal?: AbortSignal; assertCurrent(): void;
}) {
  const run = async (file: string, args: readonly string[], options: Parameters<RegressionExec>[2], kind: 'typescript' | 'tests' | 'install') => {
    try {
      input.assertCurrent(); assertMcpInvocationCurrent(options.authority);
      const plan = buildScopedExecPlan({ platform: process.platform, executable: executable(file, options.env),
        args: process.platform === 'win32' ? containerCheckArgs(args, options.scope.rootRealPath, options.sandboxDir) : args,
        cwd: options.cwd, rootRealPath: options.scope.rootRealPath, sandboxDir: options.sandboxDir,
        env: options.env, sandboxProfile: 'workspace-net', extraReadPaths: options.extraReadPaths });
      const result = await execOwnedCheck({ plan, timeoutMs: options.timeoutMs, request: {
        scope: input.scope, missionId: input.missionId, kind, signal: options.signal ?? input.signal,
        isCurrent: () => { input.assertCurrent(); assertMcpInvocationCurrent(options.authority); return true; },
      } });
      return result.exitCode === null && !result.retryable ? { ...result, stderr: unavailable(result.stderr).stderr } : result;
    } catch (error) { return unavailable(error); }
  };
  const sensor = async (root: string, kind: 'typescript' | 'install', invoke: typeof runTypecheckSensor): Promise<MechanicalCheckResult> => {
    let infrastructure: string | undefined; let retryable = false;
    const exec: MechanicalExec = async (file, args, options) => {
      const sandbox = createScopedSandboxHome(input.executionScope);
      let physicalExit: Promise<void> | undefined;
      try {
        const result = await run(file, args, { cwd: options.cwd, scope: input.executionScope,
          sandboxDir: sandbox.dir, timeoutMs: options.timeout, env: sanitizedTestEnv(root),
          extraReadPaths: [], signal: input.signal }, kind);
        physicalExit = result.physicalExit; retryable = result.retryable === true;
        if (result.exitCode === null || result.timedOut || result.aborted) infrastructure = result.stderr || 'Verificação cancelada; tente novamente.';
        if (result.exitCode !== 0) throw Object.assign(new Error(result.stderr), { code: result.exitCode ?? 'NEXUS_CHECK_UNAVAILABLE', stdout: result.stdout, stderr: result.stderr, killed: result.timedOut });
        return result;
      } finally {
        const cleanup = () => { try { removeTreeSync(sandbox.dir, { recursive: true, force: true }); } catch { /* Retain an undeletable private directory; never reject Main cleanup. */ } };
        if (physicalExit) void physicalExit.then(cleanup, () => {}); else cleanup();
      }
    };
    const result = await invoke(root, { exec, signal: input.signal });
    return infrastructure ? { ...result, status: 'unavailable', summary: infrastructure, retryable, findings: [] } : result;
  };
  return {
    typecheck: (root: string) => sensor(root, 'typescript', runTypecheckSensor),
    audit: (root: string) => sensor(root, 'install', runDependencyAuditSensor),
    regression: ((file, args, options) => run(file, args, options, 'tests')) satisfies RegressionExec,
  };
}
