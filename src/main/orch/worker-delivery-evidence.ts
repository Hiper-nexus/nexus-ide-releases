/**
 * Evidência de entrega no cwd da missão (ideia ORCA `worker_done
 * --files-modified`, adaptada — não copiada).
 *
 * No done do worker, o Main colhe caminhos que mudaram sob o cwd desde o
 * snapshot de nascimento: git dirty novo / commits desde o HEAD do spawn,
 * ou mtime > observedAt (arquivos ignorados pelo git ainda contam).
 * Zero arquivos ≠ entrega, a menos que um handoff SUCCESS já tenha
 * fechado a task.
 */
import { listChangedMtimeFiles } from './worker-file-walk';
import { dirtyPathsFromPorcelainV2 } from '../context/git-binding';
import {
  AsyncProcessGitRunner,
  type AsyncGitRunner,
  type GitRunner,
} from '../runtime/git-command';

const MAX_FILES_MODIFIED = 500;
const MAX_MTIME_WALK_FILES = 4_000;
const MAX_MTIME_DEPTH = 10;

const SKIP_MTIME_DIRECTORIES = new Set([
  '.git',
  '.nexus',
  '.nexus-memory',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'out',
  '.cache',
]);

export type WorkerDeliveryBaseline = {
  readonly cwd: string;
  readonly headSha: string | null;
  readonly dirtyPaths: readonly string[];
  /** Epoch ms do snapshot de nascimento — mtime depois disto conta. */
  readonly observedAt: number;
};

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const value = raw.trim().replace(/\\/g, '/');
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_FILES_MODIFIED) break;
  }
  return out;
}

async function runGit(
  git: GitRunner | AsyncGitRunner,
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const result = await git.run(cwd, args, { allowFailure: true });
    if (result.status !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

export async function listDirtyPathsUnderCwd(
  cwd: string,
  git: GitRunner | AsyncGitRunner = new AsyncProcessGitRunner(),
): Promise<string[]> {
  const status = await runGit(git, cwd, [
    'status',
    '--porcelain=v2',
    '--untracked-files=all',
    '-z',
  ]);
  if (status === null) return [];
  return uniquePaths(dirtyPathsFromPorcelainV2(status));
}

export async function snapshotWorkerDeliveryBaseline(
  cwd: string,
  git: GitRunner | AsyncGitRunner = new AsyncProcessGitRunner(),
): Promise<WorkerDeliveryBaseline> {
  const head =
    (await runGit(git, cwd, ['rev-parse', '--verify', 'HEAD^{commit}']))
      ?.trim()
      .toLowerCase() ?? null;
  return Object.freeze({
    cwd,
    headSha: head && /^[a-f0-9]{40,64}$/.test(head) ? head : null,
    dirtyPaths: Object.freeze(await listDirtyPathsUnderCwd(cwd, git)),
    observedAt: Date.now(),
  });
}

/**
 * Arquivos regulares sob o cwd com mtime depois do snapshot. Não segue
 * symlink; pula `.git` / `node_modules` / artefactos. Baseline tardio
 * (observedAt ≈ agora) não varre o passado — só o que nasceu depois.
 */
export async function listMtimePathsSince(
  cwd: string,
  observedAt: number,
): Promise<string[]> {
  return uniquePaths(await listChangedMtimeFiles(cwd, observedAt, {
    maxFiles: MAX_FILES_MODIFIED, maxDepth: MAX_MTIME_DEPTH,
    maxEntries: MAX_MTIME_WALK_FILES, skipDirectories: SKIP_MTIME_DIRECTORIES,
  }));
}

async function listDiffNames(
  git: GitRunner | AsyncGitRunner,
  cwd: string,
  range: string,
): Promise<string[]> {
  const out = await runGit(git, cwd, [
    'diff',
    '--name-only',
    '--diff-filter=ACMRTUXB',
    '-z',
    range,
  ]);
  if (out === null) return [];
  return uniquePaths(out.split('\0'));
}

/**
 * Arquivos que apareceram ou avançaram desde o snapshot de spawn.
 * Sujos já presentes no nascimento não contam — WIP alheio não é entrega.
 * Git dirty novo / commits `spawnHead...HEAD` têm prioridade; se o git
 * não vir nada, mtime > observedAt ainda conta (ex.: ficheiro gitignored).
 */
export async function collectFilesModifiedSince(
  cwd: string,
  baseline: WorkerDeliveryBaseline,
  git: GitRunner | AsyncGitRunner = new AsyncProcessGitRunner(),
): Promise<string[]> {
  const currentDirty = await listDirtyPathsUnderCwd(cwd, git);
  const baselineDirty = new Set(baseline.dirtyPaths);
  const newlyDirty = currentDirty.filter((path) => !baselineDirty.has(path));
  const committed = baseline.headSha
    ? await listDiffNames(git, cwd, `${baseline.headSha}...HEAD`)
    : [];
  const fromGit = uniquePaths([...newlyDirty, ...committed]);
  if (fromGit.length > 0) return fromGit;
  return uniquePaths(
    (await listMtimePathsSince(cwd, baseline.observedAt)).filter(
      (filePath) => !baselineDirty.has(filePath),
    ),
  );
}
