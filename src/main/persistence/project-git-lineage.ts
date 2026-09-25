import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  GitRepositoryLineage,
  ProjectManifest,
} from '../../shared/types';

const MAX_GIT_OUTPUT_BYTES = 128 * 1024;
/** Slow disks / a loaded Mac used to ETIMEDOUT at 5s and quarantine a valid repo. */
export const GIT_TIMEOUT_MS = 30_000;
/**
 * Não é `os.devNull`: no Windows ele vale `\\.\nul`, que o Git para Windows
 * 2.55 recusa ("unable to access '\\.\nul': Invalid argument") — toda prova
 * de linhagem falhava e o workspace com manifesto não abria. `/dev/null` é o
 * idioma do próprio Git, que o Git para Windows mapeia para `nul`.
 */
const EMPTY_GIT_CONFIG = '/dev/null';

export function projectGitResultFromSpawn(result: {
  readonly error?: Error | null;
  readonly status?: number | null;
  readonly stdout?: string | null;
  readonly stderr?: string | null;
}): ProjectGitResult {
  if (result.error) {
    return {
      status: 1,
      stdout: result.stdout ?? '',
      stderr: result.error.message || result.stderr || '',
    };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export interface ProjectGitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProjectGitRunner {
  run(
    cwd: string,
    args: readonly string[],
    options?: { readonly allowFailure?: boolean },
  ): ProjectGitResult;
}

export interface AsyncProjectGitRunner {
  run(
    cwd: string,
    args: readonly string[],
    options?: { readonly allowFailure?: boolean },
  ): Promise<ProjectGitResult>;
}

export interface GitRepositoryProof {
  readonly isShallow: boolean;
  readonly originHashes: readonly string[];
  readonly rootCommits: readonly string[];
  readonly headCommit: string | null;
}

export interface GitRepositoryContext {
  readonly proof: GitRepositoryProof;
  readonly topLevelRealPath: string;
  readonly gitDirRealPath: string;
  readonly commonDirRealPath: string;
}

export type LineageCompatibility =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'mismatch' | 'unverifiable';
      readonly detail: string;
    };

export const processGitRunner: ProjectGitRunner = Object.freeze({
  run(cwd: string, args: readonly string[]): ProjectGitResult {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(?:GIT_|LD_|DYLD_)/.test(key)) continue;
      env[key] = value;
    }
    const result = spawnSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: {
        ...env,
        GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return projectGitResultFromSpawn(result);
  },
});

function requiredGit(
  runner: ProjectGitRunner,
  cwd: string,
  args: readonly string[],
): string {
  const result = runner.run(cwd, ['--no-replace-objects', ...args]);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 512);
    throw new Error(
      `git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout.trim();
}

function optionalGitLines(
  runner: ProjectGitRunner,
  cwd: string,
  args: readonly string[],
): string[] {
  const result = runner.run(
    cwd,
    ['--no-replace-objects', ...args],
    { allowFailure: true },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function requiredGitAsync(
  runner: AsyncProjectGitRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runner.run(cwd, ['--no-replace-objects', ...args]);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 512);
    throw new Error(
      `git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout.trim();
}

async function optionalGitLinesAsync(
  runner: AsyncProjectGitRunner,
  cwd: string,
  args: readonly string[],
): Promise<string[]> {
  const result = await runner.run(
    cwd,
    ['--no-replace-objects', ...args],
    { allowFailure: true },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function canonicalRemoteIdentity(remote: string): string | null {
  const value = remote.trim();
  if (!value || path.isAbsolute(value) || value.startsWith('file:')) return null;

  let host = '';
  let repositoryPath = '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) {
      return null;
    }
    host = parsed.hostname.toLowerCase();
    const isDefaultPort =
      (parsed.protocol === 'ssh:' && parsed.port === '22') ||
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443');
    if (parsed.port && !isDefaultPort) host += `:${parsed.port}`;
    repositoryPath = parsed.pathname;
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
    if (!scp || /^[a-z]:/i.test(value)) return null;
    host = scp[1].toLowerCase();
    repositoryPath = scp[2];
  }

  repositoryPath = repositoryPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!host || !repositoryPath || repositoryPath.includes('\0')) return null;
  return `${host}/${repositoryPath}`;
}

function originHash(remote: string): string | null {
  const identity = canonicalRemoteIdentity(remote);
  if (!identity) return null;
  return `origin-sha256-${createHash('sha256').update(identity).digest('hex')}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function collectGitRepositoryProof(
  rootRealPath: string,
  runner: ProjectGitRunner = processGitRunner,
): GitRepositoryProof {
  const inside = requiredGit(runner, rootRealPath, [
    'rev-parse',
    '--is-inside-work-tree',
  ]);
  if (inside !== 'true') throw new Error('workspace is not a Git worktree');
  const shallow =
    requiredGit(runner, rootRealPath, [
      'rev-parse',
      '--is-shallow-repository',
    ]) === 'true';
  const origins = optionalGitLines(runner, rootRealPath, [
    'config',
    '--local',
    '--no-includes',
    '--get-all',
    'remote.origin.url',
  ]);
  const roots = optionalGitLines(runner, rootRealPath, [
    'rev-list',
    '--max-parents=0',
    'HEAD',
  ]).filter((value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value));
  const head = optionalGitLines(runner, rootRealPath, ['rev-parse', 'HEAD'])[0];
  return Object.freeze({
    isShallow: shallow,
    originHashes: Object.freeze(
      uniqueSorted(origins.map(originHash).filter((value): value is string => Boolean(value))),
    ),
    rootCommits: Object.freeze(uniqueSorted(roots)),
    headCommit:
      head && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ? head : null,
  });
}

export async function collectGitRepositoryProofAsync(
  rootRealPath: string,
  runner: AsyncProjectGitRunner,
): Promise<GitRepositoryProof> {
  const inside = await requiredGitAsync(runner, rootRealPath, [
    'rev-parse',
    '--is-inside-work-tree',
  ]);
  if (inside !== 'true') throw new Error('workspace is not a Git worktree');
  const shallow =
    (await requiredGitAsync(runner, rootRealPath, [
      'rev-parse',
      '--is-shallow-repository',
    ])) === 'true';
  const [origins, roots, heads] = await Promise.all([
    optionalGitLinesAsync(runner, rootRealPath, [
      'config',
      '--local',
      '--no-includes',
      '--get-all',
      'remote.origin.url',
    ]),
    optionalGitLinesAsync(runner, rootRealPath, [
      'rev-list',
      '--max-parents=0',
      'HEAD',
    ]),
    optionalGitLinesAsync(runner, rootRealPath, ['rev-parse', 'HEAD']),
  ]);
  const rootCommits = roots.filter((value) =>
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value),
  );
  const head = heads[0];
  return Object.freeze({
    isShallow: shallow,
    originHashes: Object.freeze(
      uniqueSorted(
        origins
          .map(originHash)
          .filter((value): value is string => Boolean(value)),
      ),
    ),
    rootCommits: Object.freeze(uniqueSorted(rootCommits)),
    headCommit:
      head && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)
        ? head
        : null,
  });
}

function resolveGitDirectory(rootRealPath: string, rawPath: string): string {
  const absolute = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(rootRealPath, rawPath);
  const resolved = fs.realpathSync(absolute);
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Git administrative path is not a directory: ${absolute}`);
  }
  return resolved;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

export function collectGitRepositoryContext(
  rootRealPath: string,
  runner: ProjectGitRunner = processGitRunner,
): GitRepositoryContext {
  const proof = collectGitRepositoryProof(rootRealPath, runner);
  const topLevelRealPath = fs.realpathSync(
    requiredGit(runner, rootRealPath, ['rev-parse', '--show-toplevel']),
  );
  if (topLevelRealPath !== rootRealPath) {
    throw new Error('project manifest must live at the Git worktree root');
  }
  const gitDirRealPath = resolveGitDirectory(
    rootRealPath,
    requiredGit(runner, rootRealPath, ['rev-parse', '--absolute-git-dir']),
  );
  const commonDirRealPath = resolveGitDirectory(
    rootRealPath,
    requiredGit(runner, rootRealPath, ['rev-parse', '--git-common-dir']),
  );
  if (!isInside(commonDirRealPath, gitDirRealPath)) {
    throw new Error('Git worktree directory is outside its common directory');
  }
  return Object.freeze({
    proof,
    topLevelRealPath,
    gitDirRealPath,
    commonDirRealPath,
  });
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

export function compareRepositoryLineage(
  expected: GitRepositoryLineage,
  actual: GitRepositoryProof,
  isCommitReachable?: (commit: string) => boolean,
): LineageCompatibility {
  const hasExpectedOrigin = expected.originHashes.length > 0;
  const hasActualOrigin = actual.originHashes.length > 0;
  const hasMatchingOrigin = intersects(
    expected.originHashes,
    actual.originHashes,
  );
  // Anchors decidem antes do origin: a história é prova de conteúdo, o origin
  // é só a URL. Um rename de repo/org muda a URL preservando a história; um
  // manifesto copiado para repo alheio nunca tem o anchor alcançável.
  if (!actual.isShallow && expected.anchorCommits.length > 0) {
    if (!isCommitReachable) {
      return {
        ok: false,
        reason: 'unverifiable',
        detail: 'repository anchor reachability was not checked',
      };
    }
    return expected.anchorCommits.some(isCommitReachable)
      ? { ok: true }
      : {
          ok: false,
          reason: 'mismatch',
          detail: 'repository does not contain a manifest lineage anchor',
        };
  }
  if (hasExpectedOrigin && hasActualOrigin && !hasMatchingOrigin) {
    return {
      ok: false,
      reason: 'mismatch',
      detail: 'repository origin does not match the manifest',
    };
  }

  if (actual.originHashes.length === 0) {
    return {
      ok: false,
      reason: 'unverifiable',
      detail: actual.isShallow
        ? 'shallow repository has no portable origin proof'
        : 'manifest requires origin proof but repository has no portable origin',
      };
  }
  if (!hasExpectedOrigin) {
    return {
      ok: false,
      reason: 'unverifiable',
      detail: 'manifest has no origin proof for this repository',
    };
  }
  return hasMatchingOrigin
    ? { ok: true }
    : {
        ok: false,
        reason: 'mismatch',
        detail: 'repository origin does not match the manifest',
      };
}

export function isGitCommitReachable(
  rootRealPath: string,
  commit: string,
  runner: ProjectGitRunner = processGitRunner,
): boolean {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return false;
  const result = runner.run(
    rootRealPath,
    ['--no-replace-objects', 'merge-base', '--is-ancestor', commit, 'HEAD'],
    { allowFailure: true },
  );
  if (result.status === 0) return true;
  return false;
}

export async function isGitCommitReachableAsync(
  rootRealPath: string,
  commit: string,
  runner: AsyncProjectGitRunner,
): Promise<boolean> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) return false;
  const result = await runner.run(
    rootRealPath,
    ['--no-replace-objects', 'merge-base', '--is-ancestor', commit, 'HEAD'],
    { allowFailure: true },
  );
  return result.status === 0;
}

export function repositoryLineageId(manifest: ProjectManifest): string {
  const repository = manifest.repository;
  const canonical = JSON.stringify({
    vcs: repository.vcs,
    originHashes: uniqueSorted(repository.originHashes),
    rootCommits: uniqueSorted(repository.rootCommits),
    anchorCommits: uniqueSorted(repository.anchorCommits),
  });
  return `lineage-${createHash('sha256').update(canonical).digest('hex')}`;
}
