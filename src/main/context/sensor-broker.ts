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
import { canonicalJson } from './canonical-json';

const HASH_256 = /^[a-f0-9]{64}$/;
const COMMIT_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SENSOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

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

export interface SensorBrokerDependencies {
  inspectGit?: (root: string, baseSha: string) => Promise<SensorGitState>;
  runProcess?: (
    definition: Readonly<Required<Pick<SensorDefinition, 'id' | 'command' | 'timeoutMs' | 'network'>> & Pick<SensorDefinition, 'cwd'>>,
    cwd: string,
    scope: ProjectExecutionScope,
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
): Promise<SensorProcessResult> {
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
    });
  } catch (error) {
    fs.rmSync(sandbox.dir, { recursive: true, force: true });
    throw error;
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      detached: plan.detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutHash = createHash('sha256');
    const stderrHash = createHash('sha256');
    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

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
      setTimeout(() => {
        if (proc.exitCode === null) killTree(proc, 'SIGKILL');
      }, 2_000).unref();
    }, definition.timeoutMs);
    timer.unref();
    proc.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk));
    proc.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk));
    proc.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      reject(error);
    });
    proc.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(proc, timedOut ? 'SIGKILL' : 'SIGTERM');
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
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

  async run(rawInput: SensorRunInput): Promise<TrustedEvidence> {
    const input = runInputSchema.parse(rawInput);
    const definition = this.#definitions.get(input.sensorId);
    if (!definition) throw new Error(`unknown sensor: ${input.sensorId}`);
    const cwd = resolveSensorCwd(input.scope, input.cwd ?? definition.cwd);
    const git = await this.#inspectGit(input.scope.rootRealPath, input.baseSha);
    if (git.baseSha.toLowerCase() !== input.baseSha.toLowerCase()) {
      throw new Error('sensor base SHA does not match the frozen contract');
    }
    if (!COMMIT_HASH.test(git.headSha) || !HASH_256.test(git.diffHash)) {
      throw new Error('Git inspector returned an invalid evidence binding');
    }
    const startedAt = this.#now();
    const result = await this.#runProcess(definition, cwd, input.scope);
    const finishedAt = this.#now();
    const sensorConfigHash = sha256(canonicalJson(definition));

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
