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
import { createHash } from 'node:crypto';
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
  /** F-908: método efetivo de cada diretório clonado. */
  cowMethods: Readonly<Record<string, HeavyDirCloneMethod>>;
  /** F-908: diretórios pulados sem clone APFS possível (o writer segue sem eles). */
  cowSkipped: readonly { readonly dir: string; readonly reason: string }[];
  /**
   * F-1535: fora do macOS não há clonefile — estes diretórios foram LINKADOS
   * (junction no Windows, symlink no POSIX) em vez de clonados.
   */
  linkedDirs: readonly string[];
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

/** `clonefile` = clonefile(2) do diretório; `cp-clone` = `cp -cR` no mesmo volume. */
export type HeavyDirCloneMethod = 'clonefile' | 'cp-clone' | 'link';
export type HeavyDirCloneOutcome =
  | { readonly method: HeavyDirCloneMethod }
  | { readonly skipped: string };
export type DeviceOf = (target: string) => Promise<number | bigint>;

const defaultDeviceOf: DeviceOf = async (target) => (await fs.promises.stat(target)).dev;

/**
 * macOS APFS clonefile via `cp -c` (copy-on-write when filesystem supports it).
 * Async — does not block the Electron main event loop.
 */
export async function tryClonefileCopy(
  source: string,
  dest: string,
  exec: ClonefileExecAsync = defaultClonefileExecAsync,
  osaExec: OsascriptExecAsync = defaultOsascriptExecAsync,
  deviceOf: DeviceOf = defaultDeviceOf,
): Promise<boolean> {
  return 'method' in await cloneHeavyDir(source, dest, exec, osaExec, deviceOf);
}

/** Como `tryClonefileCopy`, dizendo o método efetivo ou por que pulou. */
export async function cloneHeavyDir(
  source: string,
  dest: string,
  exec: ClonefileExecAsync = defaultClonefileExecAsync,
  osaExec: OsascriptExecAsync = defaultOsascriptExecAsync,
  deviceOf: DeviceOf = defaultDeviceOf,
): Promise<HeavyDirCloneOutcome> {
  if (process.platform !== 'darwin') return { skipped: 'not-darwin' };
  if (!fs.existsSync(source)) return { skipped: 'source-missing' };
  if (fs.existsSync(dest)) return { skipped: 'dest-exists' };
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
      return { method: 'clonefile' };
    }
    // -1 / falha / timeout: tira o que sobrou e cai no `cp -cR` de sempre.
    await removePartialCloneDestAsync(dest);
  }
  // F-908: sem clone possível, `cp -c` cai calado em copyfile(2) e copia o
  // node_modules byte a byte (GBs por worktree). clonefile exige o mesmo
  // volume: em outro volume, pula — o writer segue sem o diretório.
  if (!sourceIsSymlink) {
    let sameVolume = false;
    try {
      sameVolume = await deviceOf(source) === await deviceOf(parent);
    } catch {
      // Sem prova de mesmo volume, não copia.
    }
    if (!sameVolume) {
      console.warn(`[worktree-cow] ${source} não foi clonado: outro volume, sem clone APFS`);
      return { skipped: 'cross-volume' };
    }
  }
  const result = await exec('cp', ['-cR', source, dest], {
    encoding: 'utf8',
    timeout: CLONEFILE_TIMEOUT_MS,
  });
  if (result.status !== 0 || !fs.existsSync(dest)) {
    await removePartialCloneDestAsync(dest);
    return { skipped: 'cp-failed' };
  }
  return { method: 'cp-clone' };
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
  onOutcome?: (rel: string, outcome: HeavyDirCloneOutcome) => void,
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
    const outcome = await cloneHeavyDir(src, dest, exec, osaExec);
    onOutcome?.(rel.replaceAll('\\', '/'), outcome);
    if ('method' in outcome) copied.push(rel.replaceAll('\\', '/'));
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

// Git enumerates sibling registrations during `worktree add`; simultaneous
// adds can observe a directory before its commondir file has been written.
// Share the queue across managers/checkouts of the same physical repository.
const worktreeAddTails = new Map<string, Promise<void>>();

async function withWorktreeAddLock<T>(input: MaterializeWorktreeInput, add: () => Promise<T>): Promise<T> {
  const common = await input.git.run(input.repositoryRoot, [
    'rev-parse', '--path-format=absolute', '--git-common-dir',
  ]);
  const directory = common.stdout.trim();
  if (common.status !== 0 || !path.isAbsolute(directory)) {
    throw new Error('Git common directory is unavailable for worktree creation');
  }
  const key = fs.realpathSync(directory);
  const previous = worktreeAddTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  worktreeAddTails.set(key, tail);
  await previous;
  try {
    return await add();
  } finally {
    release();
    if (worktreeAddTails.get(key) === tail) worktreeAddTails.delete(key);
  }
}

// ---------------------------------------------------------------------------
// F-1386: gating de lockfile + caches de build (worktree nasce quente sem
// reutilizar node_modules de uma árvore de dependências diferente).
// ---------------------------------------------------------------------------

const LOCKFILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;

/** Teto de bytes de um lockfile — nunca GBs, e o hash lê o arquivo uma vez. */
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;
/** Teto de bytes por arquivo de cache de build (tsbuildinfo gigante é anômalo). */
const MAX_BUILD_CACHE_BYTES = 256 * 1024 * 1024;

function sha256File(filePath: string, maxBytes: number): string | null {
  try {
    if (fs.statSync(filePath).size > maxBytes) return null;
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

/** Primeiro lockfile presente no checkout (precedência npm > pnpm > yarn). */
export function findLockfile(root: string): string | null {
  for (const name of LOCKFILE_NAMES) {
    if (fs.existsSync(path.join(root, name))) return name;
  }
  return null;
}

export interface LockfileMatch {
  readonly lockfile: string | null;
  readonly matched: boolean;
  readonly reason: 'none' | 'match' | 'mismatch' | 'only-source';
}

/**
 * O node_modules da origem só vale para a worktree quando o lockfile dela
 * (checkout do HEAD) tem o MESMO hash. Lockfile diferente = deps diferentes =
 * node_modules não bate — não reutiliza (fail-closed quando não dá p/ ler).
 */
export function lockfilesMatch(sourceRoot: string, worktreeRoot: string): LockfileMatch {
  const lockfile = findLockfile(sourceRoot);
  if (!lockfile) return { lockfile: null, matched: false, reason: 'none' };
  const sourceHash = sha256File(path.join(sourceRoot, lockfile), MAX_LOCKFILE_BYTES);
  const worktreeHash = sha256File(path.join(worktreeRoot, lockfile), MAX_LOCKFILE_BYTES);
  if (sourceHash === null || worktreeHash === null) {
    return { lockfile, matched: false, reason: 'only-source' };
  }
  return {
    lockfile,
    matched: sourceHash === worktreeHash,
    reason: sourceHash === worktreeHash ? 'match' : 'mismatch',
  };
}

/** `*.tsbuildinfo` da raiz (declarado via tsBuildInfoFile ou o padrão). */
export function discoverTsbuildinfoFiles(repositoryRoot: string): string[] {
  const found = new Set<string>();
  try {
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, 'tsconfig.json'), 'utf8'),
    ) as { compilerOptions?: { tsBuildInfoFile?: string } };
    const configured = tsconfig.compilerOptions?.tsBuildInfoFile;
    if (typeof configured === 'string') {
      const rel = configured.replaceAll('\\', '/');
      if (!rel.includes('..') && !path.isAbsolute(rel) &&
        fs.existsSync(path.join(repositoryRoot, rel))) {
        found.add(rel);
      }
    }
  } catch {
    // tsconfig ausente/inválido: segue só com o padrão.
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(repositoryRoot, { withFileTypes: true });
  } catch {
    return [...found];
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) found.add(entry.name);
  }
  return [...found];
}

export interface BuildCacheResult {
  readonly copied: string[];
  readonly skipped: { readonly rel: string; readonly reason: string }[];
}

/**
 * Cache TypeScript portátil da origem → worktree: `*.tsbuildinfo` (TS ≥5
 * grava caminhos relativos, arquivo único limitado por MAX_BUILD_CACHE_BYTES).
 * O cache do Vitest é regenerado sob demanda: semear `.nexus-cache/vitest`
 * copiava GBs e dezenas de milhares de arquivos antes de liberar o pane.
 */
export function copyBuildCaches(
  repositoryRoot: string,
  worktreeRoot: string,
  deps?: {
    readonly copyFile?: (source: string, dest: string) => void;
    readonly statSize?: (filePath: string) => number | null;
  },
): BuildCacheResult {
  const copyFile = deps?.copyFile ?? ((src, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  });
  const statSize = deps?.statSize ?? ((filePath) => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return null;
    }
  });
  const copied: string[] = [];
  const skipped: { rel: string; reason: string }[] = [];
  for (const rel of discoverTsbuildinfoFiles(repositoryRoot)) {
    const src = path.join(repositoryRoot, rel);
    const dest = path.join(worktreeRoot, rel);
    if (fs.existsSync(dest)) continue;
    const size = statSize(src);
    if (size === null) {
      skipped.push({ rel, reason: 'unreadable' });
      continue;
    }
    if (size > MAX_BUILD_CACHE_BYTES) {
      skipped.push({ rel, reason: 'too-large' });
      continue;
    }
    try {
      copyFile(src, dest);
      copied.push(rel);
    } catch {
      skipped.push({ rel, reason: 'copy-failed' });
    }
  }
  return { copied, skipped };
}

/**
 * Materialize a linked git worktree, then optionally CoW heavy content.
 */
/**
 * F-1535: fora do macOS não existe clonefile, e a worktree nascia sem
 * `node_modules` — o worker tinha de criar o link à mão (e, sem ele, o `npx`
 * baixava um runner alheio do cache do npx em vez de usar o do projeto).
 * Mesmo padrão já em produção no F-246 (comparação com a base): resolve o
 * realpath da origem e linka; junction no Windows, symlink no POSIX (o Node
 * ignora o `type` fora do Windows). Melhor esforço: nunca bloqueia o spawn.
 *
 * Segurança de remoção, medida no Windows: `git worktree remove --force` NÃO
 * segue o junction (a árvore real de dependências sobreviveu com canário), e o
 * Main remove árvores por `removeTree`, que tira os links antes (F-663).
 * `node_modules` é o único diretório linkável de propósito: o tsbuildinfo
 * segue copiado por {@link copyBuildCaches}; caches de teste ficam por worktree
 * e são regenerados sob demanda, sem compartilhar `.vite`/`.turbo`.
 */
export function linkHeavyDirs(
  repositoryRoot: string,
  worktreePath: string,
  dirs: readonly string[],
): string[] {
  const linked: string[] = [];
  for (const rel of dirs) {
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
    const dest = path.join(worktreePath, rel);
    if (fs.existsSync(dest)) continue;
    let source: string;
    try {
      source = fs.realpathSync(path.join(repositoryRoot, rel));
      if (!fs.statSync(source).isDirectory()) continue;
    } catch {
      continue; // origem inexistente ou ilegível: o writer segue sem ela
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(source, dest, 'junction');
      excludeLinkedDir(worktreePath, rel);
      linked.push(rel.replaceAll('\\', '/'));
    } catch {
      // Sem privilégio de link nem junction possível: não é fatal.
    }
  }
  return linked;
}

/**
 * Um link não é diretório para o git: o padrão `node_modules/` (com barra) do
 * .gitignore não o casa, e o `git add -A` do writer commitaria o link com o
 * caminho absoluto do host. Por isso o link entra no `info/exclude`, ancorado e
 * sem barra final (casa link e diretório). Falha aqui nunca derruba o spawn.
 */
function excludeLinkedDir(worktreePath: string, rel: string): void {
  try {
    const dotGit = path.join(worktreePath, '.git');
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!match) return;
      gitDir = path.resolve(worktreePath, match[1]!.trim());
    }
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      // checkout comum: o git dir já é o comum
    }
    const line = `/${rel.replaceAll('\\', '/').replace(/\/+$/, '')}`;
    const excludePath = path.join(commonDir, 'info', 'exclude');
    let current = '';
    try {
      current = fs.readFileSync(excludePath, 'utf8');
    } catch {
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    }
    if (current.split(/\r?\n/).includes(line)) return;
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(excludePath, `${prefix}${line}\n`);
  } catch {
    // sem o exclude o risco é o do estado anterior: não é fatal
  }
}

export async function materializeGitWorktree(
  input: MaterializeWorktreeInput,
): Promise<MaterializeWorktreeResult> {
  const branch = branchNameFromRef(input.branchRef);
  if (fs.existsSync(input.worktreePath)) {
    throw new Error('derived worktree path already exists');
  }

  const gitStart = Date.now();
  const result = await withWorktreeAddLock(input, () => input.git.run(input.repositoryRoot, [
    'worktree',
    'add',
    '-b',
    branch,
    input.worktreePath,
    input.headSha,
  ]));
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
  const cowMethods: Record<string, HeavyDirCloneMethod> = {};
  const cowSkipped: { dir: string; reason: string }[] = [];
  // F-1386: node_modules da origem só entra com o MESMO lockfile da worktree.
  const lockfile = lockfilesMatch(input.repositoryRoot, input.worktreePath);
  const lockfileBlocksNodeModules = lockfile.lockfile !== null && !lockfile.matched;
  const effectiveDirs = input.cowDirs ?? [
    ...DEFAULT_COW_DIRS,
    ...(await discoverNestedCowDirsAsync(input.repositoryRoot, input.worktreePath, isIgnored)),
  ];
  const cowDirs = lockfileBlocksNodeModules
    ? effectiveDirs.filter((rel) => rel !== 'node_modules')
    : effectiveDirs;
  if (lockfileBlocksNodeModules && effectiveDirs.includes('node_modules')) {
    cowSkipped.push({ dir: 'node_modules', reason: `lockfile-${lockfile.reason}` });
  }
  const cowCopied = await cowCopyHeavyDirs(
    input.repositoryRoot,
    input.worktreePath,
    cowDirs,
    undefined,
    undefined,
    undefined,
    (dir, outcome) => {
      if ('method' in outcome) cowMethods[dir] = outcome.method;
      else cowSkipped.push({ dir, reason: outcome.skipped });
    },
  );
  // F-1535: sem CoW (Windows/Linux) os mesmos diretórios — já barrados pelo
  // gate de lockfile acima — entram por link, para a worktree nascer pronta.
  const linkedDirs = cowWorktreeAvailable() ? [] : linkHeavyDirs(input.repositoryRoot, input.worktreePath, cowDirs);
  for (const dir of linkedDirs) cowMethods[dir] = 'link';
  const cowMs = Date.now() - cowStart;

  // F-1386: caches de build portáteis — melhor esforço, nunca bloqueia o spawn.
  const buildCaches = await copyBuildCaches(input.repositoryRoot, input.worktreePath);
  if (buildCaches.copied.length > 0) {
    console.info(
      `[worktree-cow] caches de build copiados: ${buildCaches.copied.join(', ')}`,
    );
  }

  return {
    method: cowCopied.length > 0 ? 'clonefile' : 'git-worktree',
    worktreePath: input.worktreePath,
    cowCopied,
    cowMethods,
    cowSkipped,
    linkedDirs,
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
