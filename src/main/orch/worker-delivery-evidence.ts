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
import fs from 'node:fs';
import path from 'node:path';
import { dirtyPathsFromPorcelainV2 } from '../context/git-binding';
import {
  ProcessGitRunner,
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

function runGit(
  git: GitRunner,
  cwd: string,
  args: readonly string[],
): string | null {
  try {
    const result = git.run(cwd, args, { allowFailure: true });
    if (result.status !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

export function listDirtyPathsUnderCwd(
  cwd: string,
  git: GitRunner = new ProcessGitRunner(),
): string[] {
  const status = runGit(git, cwd, [
    'status',
    '--porcelain=v2',
    '--untracked-files=all',
    '-z',
  ]);
  if (status === null) return [];
  return uniquePaths(dirtyPathsFromPorcelainV2(status));
}

export function snapshotWorkerDeliveryBaseline(
  cwd: string,
  git: GitRunner = new ProcessGitRunner(),
): WorkerDeliveryBaseline {
  const head =
    runGit(git, cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
      ?.trim()
      .toLowerCase() ?? null;
  return Object.freeze({
    cwd,
    headSha: head && /^[a-f0-9]{40,64}$/.test(head) ? head : null,
    dirtyPaths: Object.freeze(listDirtyPathsUnderCwd(cwd, git)),
    observedAt: Date.now(),
  });
}

/**
 * Arquivos regulares sob o cwd com mtime depois do snapshot. Não segue
 * symlink; pula `.git` / `node_modules` / artefactos. Baseline tardio
 * (observedAt ≈ agora) não varre o passado — só o que nasceu depois.
 */
export function listMtimePathsSince(
  cwd: string,
  observedAt: number,
): string[] {
  const root = cwd.trim();
  if (!root || !Number.isFinite(observedAt)) return [];
  const found: string[] = [];
  const stack: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: root, rel: '', depth: 0 },
  ];
  let visited = 0;
  while (
    stack.length > 0 &&
    found.length < MAX_FILES_MODIFIED &&
    visited < MAX_MTIME_WALK_FILES
  ) {
    const current = stack.pop();
    if (!current) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES_MODIFIED) break;
      if (visited >= MAX_MTIME_WALK_FILES) break;
      if (entry.name === '.' || entry.name === '..') continue;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(current.abs, entry.name);
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_MTIME_DIRECTORIES.has(entry.name)) continue;
        if (current.depth + 1 > MAX_MTIME_DEPTH) continue;
        stack.push({ abs, rel, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      try {
        if (fs.statSync(abs).mtimeMs > observedAt) found.push(rel);
      } catch {
        // Arquivo sumiu no meio da varredura — ignora.
      }
    }
  }
  return uniquePaths(found);
}

function listDiffNames(
  git: GitRunner,
  cwd: string,
  range: string,
): string[] {
  const out = runGit(git, cwd, [
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
export function collectFilesModifiedSince(
  cwd: string,
  baseline: WorkerDeliveryBaseline,
  git: GitRunner = new ProcessGitRunner(),
): string[] {
  const currentDirty = listDirtyPathsUnderCwd(cwd, git);
  const baselineDirty = new Set(baseline.dirtyPaths);
  const newlyDirty = currentDirty.filter((path) => !baselineDirty.has(path));
  const committed = baseline.headSha
    ? listDiffNames(git, cwd, `${baseline.headSha}...HEAD`)
    : [];
  const fromGit = uniquePaths([...newlyDirty, ...committed]);
  if (fromGit.length > 0) return fromGit;
  return uniquePaths(
    listMtimePathsSince(cwd, baseline.observedAt).filter(
      (filePath) => !baselineDirty.has(filePath),
    ),
  );
}
