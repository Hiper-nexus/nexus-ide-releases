/**
 * CoW / fast worktree materialization — grok-build xai-fast-worktree idea,
 * reimplemented for Nexus:
 * 1. Always create a correct linked worktree via `git worktree add`
 * 2. On macOS APFS (when NEXUS_COW_WORKTREE≠0), clonefile bulky dirs
 *    (node_modules, etc.) from the main checkout into the new worktree
 *
 * Pure helpers + injectable runners for tests. CoW copy is async so the
 * Electron main process is not blocked on `cp -cR`.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AsyncGitRunner } from './git-command';
import { GitCommandError } from './git-command';
import { removeTree, removeTreeSync } from '../util/remove-tree';

export type WorktreeMaterializeMethod = 'clonefile' | 'git-worktree';

export interface MaterializeWorktreeInput {
  repositoryRoot: string;
  worktreePath: string;
  /** Full ref e.g. refs/heads/nexus/... */
  branchRef: string;
  headSha: string;
  git: AsyncGitRunner;
  /** Heavy dirs to CoW-copy after git worktree add (default: node_modules). */
  cowDirs?: readonly string[];
}

export interface MaterializeWorktreeResult {
  method: WorktreeMaterializeMethod;
  worktreePath: string;
  /** Which relative dirs were clonefile-copied (empty when pure git). */
  cowCopied: readonly string[];
  /** `git worktree add` wall time — surfaced on pane-spawn-timing (F-215). */
  gitWorktreeMs: number;
  /** CoW copy of heavy dirs — the dominant step before the JXA clonefile. */
  cowMs: number;
}

/** Default bulky trees that git worktree does not share but CoW can. */
export const DEFAULT_COW_DIRS = ['node_modules'] as const;

/**
 * F-215: `cp -cR` paga ~32 s num node_modules de 331k entradas porque copia
 * arquivo a arquivo; `clonefile(2)` no DIRETÓRIO clona a árvore inteira em
 * uma chamada (~4-6 s via osascript). O binário é absoluto e src/dest vão
 * como argv separados — nunca interpolados no script.
 */
const OSASCRIPT_BIN = '/usr/bin/osascript';
const CLONEFILE_JXA_SCRIPT =
  'ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "unsigned int"]]);' +
  'function run(argv) { return String($.clonefile(argv[0], argv[1], 0)); }';
const CLONEFILE_TIMEOUT_MS = 120_000;
/** Teto de node_modules aninhados clonados por worktree. */
const NESTED_COW_MAX_DIRS = 8;
/** Nomes que nunca entram na varredura de pacotes aninhados. */
const NESTED_COW_SKIP_DIRS = new Set(['node_modules', '.worktrees']);

/**
 * F-215 revisão: aninhados só entram na cópia quando `git check-ignore` prova
 * que são descartáveis — um node_modules rastreável clonado vira centenas de
 * milhares de untracked na worktree e reprova as checagens de limpeza.
 */
export type CowIgnorePredicate = (rel: string) => boolean;
type AsyncCowIgnorePredicate = (rel: string) => boolean | Promise<boolean>;

export type ClonefileExecSync = typeof spawnSync;
export type ClonefileExecAsync = (
  command: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number },
) => Promise<{ readonly status: number | null }>;

/** Exec do osascript: o contrato exige o stdout ("0" = clonefile ok). */
export type OsascriptExecAsync = (
  command: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number },
) => Promise<{ readonly status: number | null; readonly stdout: string }>;

export type OsascriptExecSync = (
  command: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number },
) => { readonly status: number | null; readonly stdout: string };

function branchNameFromRef(branchRef: string): string {
  return branchRef.startsWith('refs/heads/')
    ? branchRef.slice('refs/heads/'.length)
    : branchRef;
}

async function defaultClonefileExecAsync(
  command: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number },
): Promise<{ readonly status: number | null }> {
  return await new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ status: null });
    }, options.timeout);
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: code });
    });
  });
}

async function defaultOsascriptExecAsync(
  command: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number },
): Promise<{ readonly status: number | null; readonly stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    let settled = false;
    const settle = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      settle(null);
    }, options.timeout);
    child.on('error', () => settle(null));
    child.on('close', (code) => settle(code));
  });
}

function defaultOsascriptExecSync(
  command: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number },
): { readonly status: number | null; readonly stdout: string } {
  const result = spawnSync(command, [...args], options);
  return { status: result.status, stdout: result.stdout ?? '' };
}

/** NEXUS_COW_DIRECTORY_CLONE=0 força o caminho antigo do `cp -cR`. */
function cowDirectoryCloneEnabled(): boolean {
  return process.env.NEXUS_COW_DIRECTORY_CLONE !== '0';
}

function removePartialCloneDest(dest: string): void {
  try {
    removeTreeSync(dest, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

async function removePartialCloneDestAsync(dest: string): Promise<void> {
  try {
    await removeTree(dest, { recursive: true, force: true });
  } catch {
    // best-effort cleanup, preserving the same no-follow policy as the sync path
  }
}

/**
 * macOS APFS clonefile via `cp -c` (copy-on-write when filesystem supports it).
 * Async — does not block the Electron main event loop.
 */
export async function tryClonefileCopy(
  source: string,
  dest: string,
  exec: ClonefileExecAsync = defaultClonefileExecAsync,
  osaExec: OsascriptExecAsync = defaultOsascriptExecAsync,
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  if (!fs.existsSync(source)) return false;
  if (fs.existsSync(dest)) return false;
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  // clonefile(2) com flags 0 segue uma origem symlink; o `cp -cR` copia o
  // link em si — symlink vai direto para o caminho antigo.
  const sourceIsSymlink = fs.lstatSync(source).isSymbolicLink();
  if (cowDirectoryCloneEnabled() && !sourceIsSymlink) {
    const fast = await osaExec(
      OSASCRIPT_BIN,
      ['-l', 'JavaScript', '-e', CLONEFILE_JXA_SCRIPT, source, dest],
      { encoding: 'utf8', timeout: CLONEFILE_TIMEOUT_MS },
    );
    if (fast.status === 0 && fast.stdout.trim() === '0' && fs.existsSync(dest)) {
      return true;
    }
    // -1 / falha / timeout: tira o que sobrou e cai no `cp -cR` de sempre.
    await removePartialCloneDestAsync(dest);
  }
  const result = await exec('cp', ['-cR', source, dest], {
    encoding: 'utf8',
    timeout: CLONEFILE_TIMEOUT_MS,
  });
  if (result.status !== 0 || !fs.existsSync(dest)) {
    await removePartialCloneDestAsync(dest);
    return false;
  }
  return true;
}

/**
 * Sync clonefile for unit tests that inject spawnSync. Prefer tryClonefileCopy.
 */
export function tryClonefileCopySync(
  source: string,
  dest: string,
  exec: ClonefileExecSync = spawnSync,
  osaExec: OsascriptExecSync = defaultOsascriptExecSync,
): boolean {
  if (process.platform !== 'darwin') return false;
  if (!fs.existsSync(source)) return false;
  if (fs.existsSync(dest)) return false;
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const sourceIsSymlink = fs.lstatSync(source).isSymbolicLink();
  if (cowDirectoryCloneEnabled() && !sourceIsSymlink) {
    const fast = osaExec(
      OSASCRIPT_BIN,
      ['-l', 'JavaScript', '-e', CLONEFILE_JXA_SCRIPT, source, dest],
      { encoding: 'utf8', timeout: CLONEFILE_TIMEOUT_MS },
    );
    if (fast.status === 0 && fast.stdout.trim() === '0' && fs.existsSync(dest)) {
      return true;
    }
    removePartialCloneDest(dest);
  }
  const result = exec('cp', ['-cR', source, dest], {
    encoding: 'utf8',
    timeout: CLONEFILE_TIMEOUT_MS,
  });
  if (result.status !== 0 || !fs.existsSync(dest)) {
    removePartialCloneDest(dest);
    return false;
  }
  return true;
}

function listCowSubdirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        // Dirent.isDirectory() é falso em symlink — entram só pastas reais.
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !NESTED_COW_SKIP_DIRS.has(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

function isNestedPackageDir(dir: string): boolean {
  const nodeModules = path.join(dir, 'node_modules');
  // lstat: um node_modules linkado não é candidato — clonefile(2) seguiria o
  // link e clonaria o alvo como diretório real, quebrando o layout esperado.
  return (
    fs.existsSync(path.join(dir, 'package.json')) &&
    fs.existsSync(nodeModules) &&
    fs.lstatSync(nodeModules).isDirectory()
  );
}

/**
 * node_modules de pacotes aninhados do checkout principal (apps/mobile,
 * packages/ui, …): diretórios a profundidade 1 ou 2 com package.json +
 * node_modules. Pula dot-dirs, árvores node_modules, .worktrees e symlinks;
 * teto de NESTED_COW_MAX_DIRS; nunca repete um dest já presente na worktree.
 */
export function discoverNestedCowDirs(
  repositoryRoot: string,
  worktreePath?: string,
  isIgnored?: CowIgnorePredicate,
): string[] {
  if (!isIgnored) return [];
  const ignored = isIgnored;
  const found: string[] = [];
  const push = (rel: string): boolean => {
    if (
      worktreePath !== undefined &&
      fs.existsSync(path.join(worktreePath, rel))
    ) {
      return false;
    }
    if (!ignored(rel)) return false;
    found.push(rel);
    return found.length >= NESTED_COW_MAX_DIRS;
  };
  for (const level1 of listCowSubdirs(repositoryRoot)) {
    const dir1 = path.join(repositoryRoot, level1);
    if (isNestedPackageDir(dir1) && push(`${level1}/node_modules`)) {
      return found;
    }
    for (const level2 of listCowSubdirs(dir1)) {
      const dir2 = path.join(dir1, level2);
      if (
        isNestedPackageDir(dir2) &&
        push(`${level1}/${level2}/node_modules`)
      ) {
        return found;
      }
    }
  }
  return found;
}

function cowDirsEffective(
  repositoryRoot: string,
  worktreePath: string,
  dirs: readonly string[] | undefined,
  isIgnored?: CowIgnorePredicate,
): readonly string[] {
  return (
    dirs ?? [
      ...DEFAULT_COW_DIRS,
      ...discoverNestedCowDirs(repositoryRoot, worktreePath, isIgnored),
    ]
  );
}

/** F-764: discovery and each Git ignore probe yield on the creation path. */
async function discoverNestedCowDirsAsync(
  repositoryRoot: string,
  worktreePath: string,
  isIgnored: AsyncCowIgnorePredicate,
): Promise<string[]> {
  const found: string[] = [];
  async function visit(parent: string, depth: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(repositoryRoot, parent), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || NESTED_COW_SKIP_DIRS.has(entry.name)) continue;
      const rel = parent ? `${parent}/${entry.name}` : entry.name;
      const modules = `${rel}/node_modules`;
      const dir = path.join(repositoryRoot, rel);
      const packageExists = await fs.promises.stat(path.join(dir, 'package.json')).then(() => true, () => false);
      const modulesStat = await fs.promises.lstat(path.join(repositoryRoot, modules)).catch(() => null);
      if (packageExists && modulesStat?.isDirectory() &&
          !fs.existsSync(path.join(worktreePath, modules)) && await isIgnored(modules)) {
        found.push(modules);
        if (found.length >= NESTED_COW_MAX_DIRS) return;
      }
      if (depth < 2) await visit(rel, depth + 1);
      if (found.length >= NESTED_COW_MAX_DIRS) return;
    }
  }
  await visit('', 1);
  return found;
}

/**
 * After a correct `git worktree add`, optionally CoW-copy heavy sibling dirs
 * from the main repository working tree (e.g. node_modules) so workers start
 * warm without a full npm install.
 */
export async function cowCopyHeavyDirs(
  repositoryRoot: string,
  worktreePath: string,
  dirs?: readonly string[],
  exec: ClonefileExecAsync = defaultClonefileExecAsync,
  osaExec: OsascriptExecAsync = defaultOsascriptExecAsync,
  isIgnored?: AsyncCowIgnorePredicate,
): Promise<string[]> {
  if (!cowWorktreeAvailable()) return [];
  const copied: string[] = [];
  const effectiveDirs = dirs ?? [
    ...DEFAULT_COW_DIRS,
    ...(isIgnored ? await discoverNestedCowDirsAsync(repositoryRoot, worktreePath, isIgnored) : []),
  ];
  for (const rel of effectiveDirs) {
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
    const src = path.join(repositoryRoot, rel);
    const dest = path.join(worktreePath, rel);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    if (await tryClonefileCopy(src, dest, exec, osaExec)) {
      copied.push(rel.replaceAll('\\', '/'));
    }
  }
  return copied;
}

/** Sync variant for tests that disable CoW or inject sync runners. */
export function cowCopyHeavyDirsSync(
  repositoryRoot: string,
  worktreePath: string,
  dirs?: readonly string[],
  exec: ClonefileExecSync = spawnSync,
  osaExec: OsascriptExecSync = defaultOsascriptExecSync,
  isIgnored?: CowIgnorePredicate,
): string[] {
  if (!cowWorktreeAvailable()) return [];
  const copied: string[] = [];
  for (const rel of cowDirsEffective(
    repositoryRoot,
    worktreePath,
    dirs,
    isIgnored,
  )) {
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
    const src = path.join(repositoryRoot, rel);
    const dest = path.join(worktreePath, rel);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    if (tryClonefileCopySync(src, dest, exec, osaExec)) {
      copied.push(rel.replaceAll('\\', '/'));
    }
  }
  return copied;
}

/**
 * Materialize a linked git worktree, then optionally CoW heavy content.
 */
export async function materializeGitWorktree(
  input: MaterializeWorktreeInput,
): Promise<MaterializeWorktreeResult> {
  const branch = branchNameFromRef(input.branchRef);
  if (fs.existsSync(input.worktreePath)) {
    throw new Error('derived worktree path already exists');
  }

  const gitStart = Date.now();
  const result = await input.git.run(input.repositoryRoot, [
    'worktree',
    'add',
    '-b',
    branch,
    input.worktreePath,
    input.headSha,
  ]);
  if (result.status !== 0) {
    throw new GitCommandError(
      'Git could not create the task worktree',
      ['worktree', 'add', '-b', branch, input.worktreePath, input.headSha],
      result,
    );
  }
  const gitWorktreeMs = Date.now() - gitStart;

  const cowStart = Date.now();
  const isIgnored: AsyncCowIgnorePredicate = async (rel) =>
    (await input.git.run(
      input.repositoryRoot,
      ['check-ignore', '--quiet', rel],
      { allowFailure: true },
    )).status === 0;
  const cowCopied = await cowCopyHeavyDirs(
    input.repositoryRoot,
    input.worktreePath,
    input.cowDirs,
    undefined,
    undefined,
    isIgnored,
  );
  const cowMs = Date.now() - cowStart;

  return {
    method: cowCopied.length > 0 ? 'clonefile' : 'git-worktree',
    worktreePath: input.worktreePath,
    cowCopied,
    gitWorktreeMs,
    cowMs,
  };
}

/**
 * Pure detection: whether CoW clonefile is worth trying on this host.
 * Set NEXUS_COW_WORKTREE=0 to force-disable; default on when darwin.
 */
export function cowWorktreeAvailable(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' && process.env.NEXUS_COW_WORKTREE !== '0';
}
