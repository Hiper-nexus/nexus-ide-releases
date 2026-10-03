import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import {
  buildScopedExecPlan,
  createScopedSandboxHome,
} from '../runtime/process-sandbox';
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from '../orch/mcp-protocol';
import { canonicalJson } from './canonical-json';
import { removeTreeSync } from '../util/remove-tree';

const HASH_256 = /^[a-f0-9]{64}$/;
const COMMIT_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SENSOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

export interface AdvisoryNpmMetadata {
  readonly name: string;
  readonly version: string;
  readonly deprecated?: string;
}

export interface AdvisoryRegistryAuthority extends McpToolInvocation {
  readonly allowNetwork: () => boolean;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export function isAdvisoryNpmSelectorSafe(name: string, version: string): boolean {
  const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const semanticVersion = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (name.length > 214 || !packageName.test(name) || version.length > 80 ||
    (version !== 'latest' && !semanticVersion.test(version)) ||
    /(?:sk-|ghp_|github_pat_|npm_|xox[baprs]-)[A-Za-z0-9_-]{20,}/.test(`${name}:${version}`)) return false;
  return true;
}

/** Consultive metadata only. This never issues TrustedEvidence or changes
 * SensorDefinition.network=false, process sandbox policy, or project files. */
export async function readAdvisoryNpmMetadata(
  name: string,
  version: string,
  authority: AdvisoryRegistryAuthority,
): Promise<AdvisoryNpmMetadata | null> {
  if (!isAdvisoryNpmSelectorSafe(name, version)) return null;
  const semanticVersion = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const controller = new AbortController();
  const abort = () => controller.abort();
  authority.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, Math.max(1, Math.min(1500, authority.timeoutMs ?? 1500)));
  try {
    assertMcpInvocationCurrent(authority);
    if (!authority.allowNetwork()) return null;
    const response = await (authority.fetch ?? fetch)(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
      { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { accept: 'application/json' } },
    );
    assertMcpInvocationCurrent(authority);
    if (!authority.allowNetwork() || controller.signal.aborted || !response.ok || !response.body) return null;
    if (response.url && new URL(response.url).origin !== 'https://registry.npmjs.org') return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        assertMcpInvocationCurrent(authority);
        if (!authority.allowNetwork() || controller.signal.aborted) return null;
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 64 * 1024) { controller.abort(); return null; }
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const parsed = z.object({ name: z.string().max(214), version: z.string().max(80), deprecated: z.string().max(4096).optional() })
      .safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!parsed.success || parsed.data.name !== name || !semanticVersion.test(parsed.data.version) ||
      (version !== 'latest' && parsed.data.version !== version)) return null;
    return Object.freeze(parsed.data);
  } catch { return null; }
  finally { controller.abort(); clearTimeout(timeout); authority.signal?.removeEventListener('abort', abort); }
}

const sensorDefinitionSchema = z
  .object({
    id: z.string().regex(SENSOR_ID),
    command: z
      .array(z.string().min(1).max(65_536).refine((value) => !value.includes('\0')))
      .min(1)
      .max(1_024),
    timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
    network: z.literal(false).default(false),
    cwd: z.string().max(4_096).optional(),
  })
  .strict();

const runInputSchema = z
  .object({
    scope: projectExecutionScopeSchema,
    missionId: z.string().regex(SENSOR_ID),
    sensorId: z.string().regex(SENSOR_ID),
    baseSha: z.string().regex(COMMIT_HASH),
    contractHash: z.string().regex(HASH_256),
    contextHash: z.string().regex(HASH_256),
    cwd: z.string().max(4_096).optional(),
  })
  .strict();

export interface SensorDefinition {
  readonly id: string;
  readonly command: readonly string[];
  readonly timeoutMs?: number;
  readonly network?: false;
  readonly cwd?: string;
}

export interface SensorGitState {
  readonly baseSha: string;
  readonly headSha: string;
  readonly diffHash: string;
}

export interface SensorProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutHash?: string;
  readonly stderrHash?: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface TrustedEvidence extends SensorGitState {
  readonly id: string;
  readonly producer: 'nexus';
  readonly projectId: string;
  readonly checkoutId: string;
  readonly missionId: string;
  readonly sensorId: string;
  readonly contextHash: string;
  readonly contractHash: string;
  readonly sensorConfigHash: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly stdoutHash: string;
  readonly stderrHash: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
}

const trustedEvidenceSchema = z
  .object({
    id: z.string().regex(SENSOR_ID),
    producer: z.literal('nexus'),
    projectId: z.string().regex(SENSOR_ID),
    checkoutId: z.string().regex(SENSOR_ID),
    missionId: z.string().regex(SENSOR_ID),
    sensorId: z.string().regex(SENSOR_ID),
    baseSha: z.string().regex(COMMIT_HASH),
    headSha: z.string().regex(COMMIT_HASH),
    diffHash: z.string().regex(HASH_256),
    contextHash: z.string().regex(HASH_256),
    contractHash: z.string().regex(HASH_256),
    sensorConfigHash: z.string().regex(HASH_256),
    command: z.array(z.string().min(1).max(65_536)).min(1).max(1_024),
    exitCode: z.number().int().nullable(),
    stdoutHash: z.string().regex(HASH_256),
    stderrHash: z.string().regex(HASH_256),
    timedOut: z.boolean(),
    truncated: z.boolean(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
  })
  .strict();

export function parseTrustedEvidence(raw: unknown): TrustedEvidence {
  const parsed = trustedEvidenceSchema.parse(raw);
  return Object.freeze({
    ...parsed,
    command: Object.freeze([...parsed.command]),
  });
}

export interface SensorRunInput {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly sensorId: string;
  readonly baseSha: string;
  readonly contractHash: string;
  readonly contextHash: string;
  readonly cwd?: string;
}

export type SensorRunAuthority = McpToolInvocation;

export interface SensorBrokerDependencies {
  inspectGit?: (root: string, baseSha: string) => Promise<SensorGitState>;
  runProcess?: (
    definition: Readonly<Required<Pick<SensorDefinition, 'id' | 'command' | 'timeoutMs' | 'network'>> & Pick<SensorDefinition, 'cwd'>>,
    cwd: string,
    scope: ProjectExecutionScope,
    authority?: SensorRunAuthority,
  ) => Promise<SensorProcessResult>;
  now?: () => number;
  makeId?: () => string;
}

type NormalizedSensorDefinition = Readonly<
  Required<Pick<SensorDefinition, 'id' | 'command' | 'timeoutMs' | 'network'>> &
    Pick<SensorDefinition, 'cwd'>
>;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function resolveSensorCwd(
  scope: ProjectExecutionScope,
  requested: string | undefined,
): string {
  const root = fs.realpathSync(scope.rootRealPath);
  const candidate = requested
    ? path.resolve(root, requested)
    : root;
  const resolved = fs.realpathSync(candidate);
  if (!isWithin(root, resolved)) throw new Error('sensor cwd escapes project scope');
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error('sensor cwd is not a directory');
  }
  return resolved;
}

function execGit(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { timeout: 30_000, maxBuffer: 20 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(Buffer.from(stderr).toString('utf8').trim() || error.message));
          return;
        }
        resolve(Buffer.from(stdout).toString('utf8'));
      },
    );
  });
}

async function inspectGit(root: string, baseSha: string): Promise<SensorGitState> {
  const status = await execGit(root, ['status', '--porcelain=v2', '--untracked-files=all']);
  if (status.trim().length > 0) {
    throw new Error('sensor execution requires a clean committed worktree');
  }
  const headSha = (await execGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const verifiedBase = (
    await execGit(root, ['rev-parse', '--verify', `${baseSha}^{commit}`])
  ).trim();
  await execGit(root, ['merge-base', '--is-ancestor', verifiedBase, headSha]);
  const diff = await execGit(root, [
    'diff',
    '--binary',
    '--full-index',
    '--no-ext-diff',
    `${verifiedBase}...${headSha}`,
    '--',
  ]);
  return {
    baseSha: verifiedBase.toLowerCase(),
    headSha: headSha.toLowerCase(),
    diffHash: sha256(diff),
  };
}

function resolveExecutable(executable: string, envPath: string): string {
  if (path.isAbsolute(executable)) {
    const real = fs.realpathSync(executable);
    fs.accessSync(real, fs.constants.X_OK);
    if (!fs.statSync(real).isFile()) throw new Error('sensor executable is not a file');
    return real;
  }
  if (executable.includes('/') || executable.includes('\\') || executable.startsWith('-')) {
    throw new Error('sensor executable must be an absolute path or PATH command');
  }
  for (const directory of envPath.split(path.delimiter).slice(0, 128)) {
    if (!directory) continue;
    try {
      const candidate = fs.realpathSync(path.join(directory, executable));
      const stat = fs.statSync(candidate);
      fs.accessSync(candidate, fs.constants.X_OK);
      if (stat.isFile()) return candidate;
    } catch {
      // Continue through the trusted PATH snapshot.
    }
  }
  throw new Error(`sensor executable not found: ${executable}`);
}

function killTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  try {
    if (process.platform === 'win32') proc.kill(signal);
    else process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

async function runSensorProcess(
  definition: NormalizedSensorDefinition,
  cwd: string,
  scope: ProjectExecutionScope,
  authority: SensorRunAuthority = {},
): Promise<SensorProcessResult> {
  assertMcpInvocationCurrent(authority);
  const envPath = process.env.PATH ?? '/usr/bin:/bin';
  const sandbox = createScopedSandboxHome(scope);
  let plan;
  try {
    plan = buildScopedExecPlan({
      platform: process.platform,
      executable: resolveExecutable(definition.command[0], envPath),
      args: definition.command.slice(1),
      cwd,
      rootRealPath: scope.rootRealPath,
      sandboxDir: sandbox.dir,
      env: {
        PATH: envPath,
        LANG: process.env.LANG ?? 'C.UTF-8',
        CI: 'true',
        NO_COLOR: '1',
      },
      readOnlyRoot: true,
    });
  } catch (error) {
    removeTreeSync(sandbox.dir, { recursive: true, force: true });
    throw error;
  }

  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      assertMcpInvocationCurrent(authority);
      proc = spawn(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        detached: plan.detached,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      removeTreeSync(sandbox.dir, { recursive: true, force: true });
      reject(error);
      return;
    }
    const stdoutHash = createHash('sha256');
    const stderrHash = createHash('sha256');
    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let authorityError: Error | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      authority.signal?.removeEventListener('abort', onAbort);
      removeTreeSync(sandbox.dir, { recursive: true, force: true });
    };

    const scheduleForceKill = () => {
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        if (proc.exitCode === null) killTree(proc, 'SIGKILL');
      }, 2_000);
      forceKillTimer.unref();
    };

    const onAbort = () => {
      if (settled || authorityError) return;
      authorityError =
        authority.signal?.reason instanceof Error
          ? authority.signal.reason
          : new Error('session_authority_revoked');
      killTree(proc, 'SIGTERM');
      scheduleForceKill();
    };

    function capture(stream: 'stdout' | 'stderr', chunk: Buffer): void {
      (stream === 'stdout' ? stdoutHash : stderrHash).update(chunk);
      const remaining = OUTPUT_LIMIT_BYTES - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const captured = chunk.subarray(0, remaining);
      if (stream === 'stdout') stdout += captured.toString('utf8');
      else stderr += captured.toString('utf8');
      capturedBytes += captured.length;
      if (captured.length < chunk.length) truncated = true;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc, 'SIGTERM');
      scheduleForceKill();
    }, definition.timeoutMs);
    timer.unref();
    proc.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk));
    proc.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk));
    proc.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(authorityError ?? error);
    });
    proc.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      killTree(proc, timedOut ? 'SIGKILL' : 'SIGTERM');
      cleanup();
      if (authorityError) {
        reject(authorityError);
        return;
      }
      resolve({
        exitCode,
        stdout,
        stderr,
        stdoutHash: stdoutHash.digest('hex'),
        stderrHash: stderrHash.digest('hex'),
        timedOut,
        truncated,
      });
    });
    authority.signal?.addEventListener('abort', onAbort, { once: true });
    if (authority.signal?.aborted) onAbort();
  });
}

export class SensorBroker {
  readonly #definitions: ReadonlyMap<string, NormalizedSensorDefinition>;
  readonly #inspectGit: NonNullable<SensorBrokerDependencies['inspectGit']>;
  readonly #runProcess: NonNullable<SensorBrokerDependencies['runProcess']>;
  readonly #now: () => number;
  readonly #makeId: () => string;

  constructor(
    definitions: readonly SensorDefinition[],
    dependencies: SensorBrokerDependencies = {},
  ) {
    const byId = new Map<string, NormalizedSensorDefinition>();
    for (const raw of definitions) {
      const parsed = sensorDefinitionSchema.parse(raw);
      if (byId.has(parsed.id)) throw new Error(`duplicate sensor: ${parsed.id}`);
      byId.set(
        parsed.id,
        Object.freeze({
          ...parsed,
          command: Object.freeze([...parsed.command]),
        }),
      );
    }
    this.#definitions = byId;
    this.#inspectGit = dependencies.inspectGit ?? inspectGit;
    this.#runProcess = dependencies.runProcess ?? runSensorProcess;
    this.#now = dependencies.now ?? Date.now;
    this.#makeId = dependencies.makeId ?? randomUUID;
  }

  listDefinitions(): readonly NormalizedSensorDefinition[] {
    return Object.freeze([...this.#definitions.values()]);
  }

  async run(
    rawInput: SensorRunInput,
    authority: SensorRunAuthority = {},
  ): Promise<TrustedEvidence> {
    assertMcpInvocationCurrent(authority);
    const input = runInputSchema.parse(rawInput);
    const definition = this.#definitions.get(input.sensorId);
    if (!definition) throw new Error(`unknown sensor: ${input.sensorId}`);
    const cwd = resolveSensorCwd(input.scope, input.cwd ?? definition.cwd);
    const git = await this.#inspectGit(input.scope.rootRealPath, input.baseSha);
    assertMcpInvocationCurrent(authority);
    if (git.baseSha.toLowerCase() !== input.baseSha.toLowerCase()) {
      throw new Error('sensor base SHA does not match the frozen contract');
    }
    if (!COMMIT_HASH.test(git.headSha) || !HASH_256.test(git.diffHash)) {
      throw new Error('Git inspector returned an invalid evidence binding');
    }
    const startedAt = this.#now();
    assertMcpInvocationCurrent(authority);
    const result = await this.#runProcess(
      definition,
      cwd,
      input.scope,
      authority,
    );
    assertMcpInvocationCurrent(authority);
    const finishedAt = this.#now();
    const sensorConfigHash = sha256(canonicalJson(definition));

    assertMcpInvocationCurrent(authority);
    return Object.freeze({
      id: this.#makeId(),
      producer: 'nexus',
      projectId: input.scope.projectId,
      checkoutId: input.scope.checkoutId,
      missionId: input.missionId,
      sensorId: input.sensorId,
      baseSha: git.baseSha.toLowerCase(),
      headSha: git.headSha.toLowerCase(),
      diffHash: git.diffHash,
      contextHash: input.contextHash,
      contractHash: input.contractHash,
      sensorConfigHash,
      command: Object.freeze([...definition.command]),
      exitCode: result.exitCode,
      stdoutHash: result.stdoutHash ?? sha256(result.stdout),
      stderrHash: result.stderrHash ?? sha256(result.stderr),
      timedOut: result.timedOut,
      truncated: result.truncated,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
    });
  }
}
