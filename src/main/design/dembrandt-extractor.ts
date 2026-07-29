import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessBrowserUrl,
  type BrowserUrlDecision,
} from '../browser/url-policy';

/**
 * Governed Dembrandt CLI wrapper.
 *
 * Extracts a live site's design system into DESIGN.md markdown. Callers must
 * feed the result into ContextDraft propose() — never write DESIGN.md at the
 * workspace root from this module.
 *
 * Security notes:
 * - v0.25.1 follows redirects and subresources without exposing a per-request
 *   route hook. URL assessment is defense in depth, not an SSRF boundary.
 * - MCP extraction therefore requires an explicitly injected runner whose
 *   browser layer enforces every request; the bundled CLI is manual-only.
 * - Child env is an allowlist (no process.env passthrough of secrets).
 * - Chromium runs with its default sandbox (no --no-sandbox).
 * - Timeout/abort terminates the whole CLI/browser process tree before reject.
 */

export const DEMBRANDT_PACKAGE = 'dembrandt@0.25.1';
export const DEMBRANDT_TIMEOUT_MS = 120_000;
export const DEMBRANDT_MAX_OUTPUT_BYTES = 2_000_000;
export const DEMBRANDT_TERMINATION_GRACE_MS = 2_000;

/** Env keys forwarded to the Dembrandt child (everything else is dropped). */
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NODE_OPTIONS',
  'npm_config_cache',
  'npm_config_prefix',
  'npm_config_registry',
  'npm_config_user_agent',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
] as const;

export class DembrandtExtractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DembrandtExtractError';
    this.code = code;
  }
}

export interface DembrandtExtractInput {
  readonly url: string;
  readonly paths?: readonly string[];
  readonly darkMode?: boolean;
  readonly mobile?: boolean;
  readonly wcag?: boolean;
  readonly signal?: AbortSignal;
  /** Defense-in-depth URL assessment; not a redirect/subresource guard. */
  readonly assessUrl?: (
    raw: string,
  ) => Promise<BrowserUrlDecision>;
  /**
   * Explicitly injected guarded runner. Its browser implementation must
   * enforce URL policy on every request, including redirects/subresources.
   * The unguarded v0.25.1 CLI is intentionally never selected by default.
   */
  readonly routeGuardedRunner?: DembrandtCliRunner;
}

export interface DembrandtExtractResult {
  readonly designMd: string;
  readonly sourceUrl: string;
  readonly normalizedUrl: string;
}

export interface DembrandtCliRunRequest {
  readonly normalizedUrl: string;
  readonly paths: readonly string[];
  readonly darkMode: boolean;
  readonly mobile: boolean;
  readonly wcag: boolean;
  readonly workDir: string;
  readonly signal?: AbortSignal;
}

export type DembrandtCliRunner = (
  request: DembrandtCliRunRequest,
) => Promise<{ designMd: string }>;

interface DembrandtReadable {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

interface DembrandtChildProcess {
  readonly pid?: number;
  readonly stdout?: DembrandtReadable | null;
  readonly stderr?: DembrandtReadable | null;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'close', listener: (code: number | null) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}

interface DembrandtSpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio: ['ignore', 'pipe', 'pipe'] | 'ignore';
  readonly detached?: boolean;
  readonly shell?: false;
  readonly windowsHide?: boolean;
}

type DembrandtSpawnProcess = (
  command: string,
  args: string[],
  options: DembrandtSpawnOptions,
) => DembrandtChildProcess;

interface DembrandtCliRunnerDependencies {
  readonly platform: NodeJS.Platform;
  readonly spawnProcess: DembrandtSpawnProcess;
  readonly signalProcessGroup: (
    processGroupId: number,
    signal: NodeJS.Signals,
  ) => void;
  readonly terminateWindowsTree: (pid: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
}

const spawnProcess: DembrandtSpawnProcess = (command, args, options) =>
  spawn(command, args, options as SpawnOptions) as DembrandtChildProcess;

const DEFAULT_RUNNER_DEPENDENCIES: DembrandtCliRunnerDependencies = {
  platform: process.platform,
  spawnProcess,
  signalProcessGroup: (processGroupId, signal) => {
    process.kill(processGroupId, signal);
  },
  terminateWindowsTree: (pid) => terminateWindowsProcessTree(pid),
};

function defaultAssessUrl(raw: string): Promise<BrowserUrlDecision> {
  return assessBrowserUrl(raw, { allowPrivateNetwork: false });
}

export function buildDembrandtChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { npm_config_yes: 'true' };
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

function buildCliArgs(request: DembrandtCliRunRequest): string[] {
  const args = [
    '-y',
    DEMBRANDT_PACKAGE,
    request.normalizedUrl,
    '--design-md',
  ];
  for (const pagePath of request.paths) {
    const trimmed = pagePath.trim();
    if (!trimmed) continue;
    args.push(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
  }
  if (request.darkMode) args.push('--dark-mode');
  if (request.mobile) args.push('--mobile');
  if (request.wcag) args.push('--wcag');
  return args;
}

function findDesignMd(workDir: string): string | null {
  const outputRoot = path.join(workDir, 'output');
  if (!fs.existsSync(outputRoot)) return null;
  const stack = [outputRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase() === 'design.md') {
        return full;
      }
    }
  }
  return null;
}

function abortedError(): DembrandtExtractError {
  return new DembrandtExtractError(
    'ABORTED',
    'dembrandt extraction aborted',
  );
}

function isAlreadyGoneError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function terminateWindowsProcessTree(
  pid: number,
  spawnTaskkill: DembrandtSpawnProcess = spawnProcess,
  systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
): Promise<void> {
  const taskkillPath = path.win32.join(
    systemRoot,
    'System32',
    'taskkill.exe',
  );
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const killer = spawnTaskkill(
      taskkillPath,
      ['/pid', String(pid), '/T', '/F'],
      {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      },
    );
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      killer.removeListener('close', onClose);
      killer.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => {
      finish(
        new DembrandtExtractError(
          'TEARDOWN_FAILED',
          `failed to launch Windows process-tree teardown: ${error.message}`,
        ),
      );
    };
    const onClose = (code: number | null): void => {
      // taskkill returns 128 when the target already exited. In both cases
      // there is no live tree left for that PID.
      if (code === 0 || code === 128) {
        finish();
        return;
      }
      finish(
        new DembrandtExtractError(
          'TEARDOWN_FAILED',
          `Windows process-tree teardown exited with code ${code ?? 'unknown'}`,
        ),
      );
    };
    killer.once('error', onError);
    killer.once('close', onClose);
  });
}

function signalPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  signalProcessGroup: DembrandtCliRunnerDependencies['signalProcessGroup'],
): void {
  try {
    signalProcessGroup(-pid, signal);
  } catch (error) {
    if (!isAlreadyGoneError(error)) throw error;
  }
}

async function terminateDembrandtProcessTree(
  child: DembrandtChildProcess,
  dependencies: DembrandtCliRunnerDependencies,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    throw new DembrandtExtractError(
      'TEARDOWN_FAILED',
      'dembrandt process-tree teardown cannot prove a process without a PID',
    );
  }

  const graceMs =
    dependencies.terminationGraceMs ?? DEMBRANDT_TERMINATION_GRACE_MS;
  if (dependencies.platform === 'win32') {
    try {
      child.kill('SIGTERM');
    } catch {
      // taskkill below is the authoritative Windows tree teardown.
    }
    await delay(graceMs);
    await dependencies.terminateWindowsTree(pid);
    return;
  }

  try {
    signalPosixProcessGroup(
      pid,
      'SIGTERM',
      dependencies.signalProcessGroup,
    );
  } catch {
    // Escalation below is authoritative. A failed graceful signal must never
    // skip the hard stop and leave Node/Chromium descendants running.
  }
  await delay(graceMs);
  // Always escalate the original detached group even if npx already closed:
  // Chromium/Node descendants may still be alive in that process group.
  signalPosixProcessGroup(
    pid,
    'SIGKILL',
    dependencies.signalProcessGroup,
  );
}

async function runDembrandtCliRunner(
  request: DembrandtCliRunRequest,
  dependencies: DembrandtCliRunnerDependencies = DEFAULT_RUNNER_DEPENDENCIES,
): Promise<{ designMd: string }> {
  if (request.signal?.aborted) throw abortedError();

  const args = buildCliArgs(request);
  const env = buildDembrandtChildEnv();

  return await new Promise((resolve, reject) => {
    let child: DembrandtChildProcess;
    try {
      child = dependencies.spawnProcess('npx', args, {
        cwd: request.workDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: dependencies.platform !== 'win32',
        shell: false,
        windowsHide: dependencies.platform === 'win32',
      });
    } catch (error) {
      reject(
        new DembrandtExtractError(
          'SPAWN_FAILED',
          `failed to spawn dembrandt: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let settled = false;
    let teardownStarted = false;
    let closeObserved = false;
    let resolveCloseProof: (() => void) | undefined;
    const closeProof = new Promise<void>((closeResolve) => {
      resolveCloseProof = closeResolve;
    });
    const timeoutMs = dependencies.timeoutMs ?? DEMBRANDT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | null = null;

    const removeOutputListeners = (): void => {
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
    };
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      request.signal?.removeEventListener('abort', onAbort);
      removeOutputListeners();
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
    };
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishResolve = (designMd: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ designMd });
    };
    const failAfterTeardown = (error: DembrandtExtractError): void => {
      if (settled || teardownStarted) return;
      teardownStarted = true;
      if (timer) clearTimeout(timer);
      timer = null;
      request.signal?.removeEventListener('abort', onAbort);
      removeOutputListeners();
      void terminateDembrandtProcessTree(child, dependencies)
        .then(async () => {
          // Reap npx only after the entire detached group/taskkill operation
          // completed. This keeps the temp cwd alive until physical teardown.
          if (!closeObserved) await closeProof;
          finishReject(error);
        })
        .catch(async (teardownError: unknown) => {
          if (!closeObserved) await closeProof;
          const detail =
            teardownError instanceof Error
              ? teardownError.message
              : String(teardownError);
          finishReject(
            new DembrandtExtractError(
              'TEARDOWN_FAILED',
              `${error.message}; process-tree teardown failed: ${detail}`,
            ),
          );
        });
    };
    const onAbort = (): void => failAfterTeardown(abortedError());

    const accumulate = (chunk: Buffer, target: 'out' | 'err') => {
      totalBytes += chunk.length;
      if (totalBytes > DEMBRANDT_MAX_OUTPUT_BYTES) {
        failAfterTeardown(
          new DembrandtExtractError(
            'OUTPUT_TOO_LARGE',
            `dembrandt output exceeded ${DEMBRANDT_MAX_OUTPUT_BYTES} bytes`,
          ),
        );
        return;
      }
      const text = chunk.toString('utf8');
      if (target === 'out') stdout += text;
      else stderr += text;
    };
    const onStdout = (chunk: Buffer): void => accumulate(chunk, 'out');
    const onStderr = (chunk: Buffer): void => accumulate(chunk, 'err');

    const onError = (error: Error): void => {
      if (teardownStarted) return;
      if (child.pid !== undefined) {
        failAfterTeardown(
          new DembrandtExtractError(
            'SPAWN_FAILED',
            `dembrandt process failed: ${error.message}`,
          ),
        );
        return;
      }
      finishReject(
        new DembrandtExtractError(
          'SPAWN_FAILED',
          `failed to spawn dembrandt: ${error.message}. Ensure Node/npx are available; browser binary may need \`npx dembrandt@0.25.1 install-browser\`.`,
        ),
      );
    };

    const onClose = (code: number | null): void => {
      closeObserved = true;
      resolveCloseProof?.();
      if (settled || teardownStarted) return;
      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(0, 800);
        const browserHint =
          /Executable doesn't exist|browser|chromium|playwright/i.test(detail)
            ? ' Run `npx dembrandt@0.25.1 install-browser` once, then retry.'
            : '';
        finishReject(
          new DembrandtExtractError(
            'EXTRACTION_FAILED',
            `dembrandt exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}.${browserHint}`,
          ),
        );
        return;
      }

      const designPath = findDesignMd(request.workDir);
      if (!designPath) {
        finishReject(
          new DembrandtExtractError(
            'NO_DESIGN_MD',
            'dembrandt completed but DESIGN.md was not found under output/',
          ),
        );
        return;
      }
      let designMd: string;
      try {
        designMd = fs.readFileSync(designPath, 'utf8');
      } catch (error) {
        finishReject(
          new DembrandtExtractError(
            'READ_FAILED',
            `failed to read DESIGN.md: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      if (!designMd.trim()) {
        finishReject(
          new DembrandtExtractError(
            'EMPTY_DESIGN_MD',
            'dembrandt produced an empty DESIGN.md',
          ),
        );
        return;
      }
      if (Buffer.byteLength(designMd, 'utf8') > DEMBRANDT_MAX_OUTPUT_BYTES) {
        finishReject(
          new DembrandtExtractError(
            'OUTPUT_TOO_LARGE',
            `DESIGN.md exceeded ${DEMBRANDT_MAX_OUTPUT_BYTES} bytes`,
          ),
        );
        return;
      }
      finishResolve(designMd);
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);

    timer = setTimeout(() => {
      failAfterTeardown(
        new DembrandtExtractError(
          'TIMEOUT',
          `dembrandt timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
  });
}

/**
 * Manual CLI runner. It intentionally is not the default for MCP URL
 * extraction because Dembrandt v0.25.1 cannot guard redirect/subresource
 * requests. Kept for explicit operator/manual flows and future guarded use.
 */
export async function defaultDembrandtCliRunner(
  request: DembrandtCliRunRequest,
): Promise<{ designMd: string }> {
  return runDembrandtCliRunner(request);
}

/**
 * Assess URL policy, run Dembrandt in an isolated temp cwd, return DESIGN.md.
 */
export async function extractDesignSystemFromUrl(
  input: DembrandtExtractInput,
): Promise<DembrandtExtractResult> {
  if (!input.routeGuardedRunner) {
    throw new DembrandtExtractError(
      'NETWORK_GUARD_UNAVAILABLE',
      'Dembrandt v0.25.1 has no per-request network guard for redirects and subresources; MCP extraction is disabled until a route-guarded runner is injected',
    );
  }
  if (input.signal?.aborted) throw abortedError();

  const assess = input.assessUrl ?? defaultAssessUrl;
  const decision = await assess(input.url);
  if (!decision.allowed) {
    const kind = decision.kind;
    if (kind === 'private-network' || kind === 'forbidden-network') {
      throw new DembrandtExtractError(
        'URL_BLOCKED',
        `dembrandt extraction blocked (${kind}): ${decision.reason}`,
      );
    }
    throw new DembrandtExtractError(
      'URL_INVALID',
      `dembrandt extraction blocked (${kind}): ${decision.reason}`,
    );
  }

  // Defense in depth: refuse literal private/forbidden address classes that
  // somehow passed a custom assessUrl injection.
  if (
    decision.addressClasses?.some(
      (cls) =>
        cls === 'loopback' ||
        cls === 'private' ||
        cls === 'link-local' ||
        cls === 'metadata' ||
        cls === 'carrier-grade-nat',
    )
  ) {
    throw new DembrandtExtractError(
      'URL_BLOCKED',
      'dembrandt extraction blocked: resolved address is not public',
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dembrandt-'));
  try {
    const { designMd } = await input.routeGuardedRunner({
      normalizedUrl: decision.normalizedUrl,
      paths: input.paths ?? [],
      darkMode: input.darkMode === true,
      mobile: input.mobile === true,
      wcag: input.wcag === true,
      workDir,
      signal: input.signal,
    });
    return {
      designMd,
      sourceUrl: input.url.trim(),
      normalizedUrl: decision.normalizedUrl,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** @internal exported for unit tests */
export const __test = {
  buildCliArgs,
  findDesignMd,
  buildDembrandtChildEnv,
  CHILD_ENV_ALLOWLIST,
  runDembrandtCliRunner,
  terminateWindowsProcessTree,
};
