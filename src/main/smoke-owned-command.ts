import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectExecutionScope } from '../shared/types';
import { buildScopedExecPlan } from './runtime/process-sandbox';
import { execOwnedCheck } from './orch/owned-check-exec';
import { currentDarwinPtySupervisorRuntime, DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
  NEXUS_APPLE_TEAM_ID, resolvePackagedDarwinPtySmokeProviderSeal } from './pty/darwin-pty-supervisor';

export interface MainOwnedCommandSmokeProof {
  status: 'passed'; densePathFiles: 768; profileBytes: number; exitCode: 0; physicalExitProven: true;
}
type UnavailableProof = { status: 'unavailable'; reason: 'ad-hoc' | 'non-darwin' };

/** Extends the existing packaged smoke; never grants smoke trust to commands. */
export async function proveMainOwnedCommandForSmoke(input: {
  userData: string; scope: ProjectExecutionScope; assertCurrent(): void; signal: AbortSignal;
}, ports: {
  platform?: NodeJS.Platform;
  seal?: () => { teamIdentifier: string | null };
  execute?: typeof execOwnedCheck;
} = {}): Promise<MainOwnedCommandSmokeProof | UnavailableProof> {
  if ((ports.platform ?? process.platform) !== 'darwin') return { status: 'unavailable', reason: 'non-darwin' };
  const seal = (ports.seal ?? (() => resolvePackagedDarwinPtySmokeProviderSeal(
    currentDarwinPtySupervisorRuntime(__dirname, DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE))))();
  if (seal.teamIdentifier === null) return { status: 'unavailable', reason: 'ad-hoc' };
  if (seal.teamIdentifier !== NEXUS_APPLE_TEAM_ID) throw new Error('owned-smoke-signature');
  input.assertCurrent();
  const runtime = await fs.mkdtemp(path.join(input.userData, 'owned-command-smoke-'));
  const cleanup = () => fs.rm(runtime, { recursive: true, force: true }).catch(() => {});
  let launchRequested = false;
  let physicalExit: Promise<void> | undefined;
  try {
    const bin = path.join(runtime, 'dense-bin');
    await fs.mkdir(bin, { mode: 0o700 });
    for (let index = 0; index < 768; index++) {
      await fs.writeFile(path.join(bin, `tool-${index}-${'x'.repeat(64)}`), '', { mode: 0o600 });
    }
    input.assertCurrent();
    const nonce = randomUUID();
    const plan = buildScopedExecPlan({ platform: 'darwin', executable: '/bin/sh',
      args: ['-c', 'printf "%s\\n" "$1"', 'nexus-owned-smoke', nonce],
      cwd: input.scope.rootRealPath, rootRealPath: input.scope.rootRealPath, sandboxDir: runtime,
      env: { PATH: `${bin}:/usr/bin:/bin` }, readOnlyRoot: true, sandboxProfile: 'workspace-only' });
    const profileBytes = Buffer.byteLength(plan.args[1] ?? '');
    launchRequested = true;
    const result = await (ports.execute ?? execOwnedCheck)({ plan, timeoutMs: 15_000,
      request: { scope: input.scope, kind: 'tests', signal: input.signal, isCurrent: () => {
        try { input.assertCurrent(); return !input.signal.aborted; } catch { return false; }
      } } });
    physicalExit = result.physicalExit;
    if (!physicalExit) throw new Error('owned-smoke-no-physical-proof');
    await physicalExit;
    input.assertCurrent();
    if (input.signal.aborted || result.exitCode !== 0 || result.timedOut || result.aborted ||
      result.outputTruncated || result.stdout.trim() !== nonce || profileBytes > 65536) {
      throw new Error(`owned-smoke-command-failed: exit=${String(result.exitCode)} timedOut=${result.timedOut} ` +
        `aborted=${result.aborted} truncated=${Boolean(result.outputTruncated)} nonce=${result.stdout.trim() === nonce} ` +
        // F-1010: o motivo do supervisor (ex.: exit 76 = identidade/autorização) vem no stderr.
        `stderr=${JSON.stringify(result.stderr.trim().replace(/\s+/g, ' ').slice(-400))}`);
    }
    return { status: 'passed', densePathFiles: 768, profileBytes, exitCode: 0, physicalExitProven: true };
  } finally {
    if (!launchRequested) await cleanup();
    else if (physicalExit) void physicalExit.then(cleanup, () => {});
  }
}
