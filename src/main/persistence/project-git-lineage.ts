import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { smallFileToken, statToken } from '../git/proof-fingerprint';
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

/**
 * O mesmo ambiente endurecido para o runner síncrono e para o assíncrono de
 * aquecimento: a prova cacheada só vale se os dois lados observarem o git da
 * MESMA forma (config global neutralizada, replace objects desligado). O
 * AsyncProcessGitRunner de runtime não serve aqui: ele mantém a config global
 * para credenciais (F-580) e provaria linhagem com regras diferentes.
 *
 * GIT_GRAFT_FILE: o git honra .git/info/grafts MESMO com
 * --no-replace-objects — um repo hostil fabrica a ancestralidade de
 * `merge-base --is-ancestor` e forja a âncora do F-107. Arquivo vazio = sem
 * grafts (o mesmo dispositivo nulo da config global).
 */
function hardenedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:GIT_|LD_|DYLD_)/.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_GRAFT_FILE: EMPTY_GIT_CONFIG,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export const processGitRunner: ProjectGitRunner = Object.freeze({
  run(cwd: string, args: readonly string[]): ProjectGitResult {
    const result = spawnSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: hardenedGitEnvironment(),
    });
    return projectGitResultFromSpawn(result);
  },
});

/** Mesma prova, sem spawnSync: aquece o cache fora do caminho quente do Main. */
export const asyncProcessGitRunner: AsyncProjectGitRunner = Object.freeze({
  run(
    cwd: string,
    args: readonly string[],
  ): Promise<ProjectGitResult> {
    return new Promise((resolve) => {
      const child = spawn('git', [...args], {
        cwd,
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        env: hardenedGitEnvironment(),
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_GIT_OUTPUT_BYTES) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_GIT_OUTPUT_BYTES) stderr += chunk.toString('utf8');
      });
      const finish = (result: {
        error?: Error;
        status?: number | null;
      }): void => {
        if (settled) return;
        settled = true;
        resolve(
          projectGitResultFromSpawn({
            error: result.error ?? null,
            status: result.status ?? null,
            stdout,
            stderr,
          }),
        );
      };
      child.on('error', (error) => finish({ error }));
      child.on('close', (status) => finish({ status }));
    });
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
  // Canônico do sistema: `--absolute-git-dir` vem na grafia do disco e
  // `--git-common-dir` relativo à raiz recebida — só assim os dois se comparam.
  const resolved = fs.realpathSync.native(absolute);
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

/**
 * O mesmo diretório pode chegar escrito de outro jeito: no Windows o git
 * devolve a grafia do disco (caixa real, nome longo) e a pasta pode vir como
 * `c:\users\…` ou `ADMINI~1`. Compara a forma canônica do sistema, que resolve
 * caixa e nome curto, em vez da string.
 */
export function isSameDirectory(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return fs.realpathSync.native(left) === fs.realpathSync.native(right);
  } catch {
    return false;
  }
}

export function collectGitRepositoryContext(
  rootRealPath: string,
  runner: ProjectGitRunner = processGitRunner,
): GitRepositoryContext {
  // Cache só para o runner padrão: runners de teste injetados não devem ler
  // (nem aquecer) provas de outras execuções.
  const cacheable = runner === processGitRunner;
  if (cacheable) {
    const cached = getCachedGitRepositoryContext(rootRealPath);
    if (cached) {
      proofStats.contextHits += 1;
      return cached;
    }
    proofStats.contextSyncRuns += 1;
  }
  // TOCTOU (H1): o fingerprint lido ANTES da prova é o único que pode
  // casar com ela. Se o disco muda no meio dos spawns (ex.: origin
  // trocado por fora), gravar {fingerprint novo, prova antiga} serviria a
  // prova velha por até o TTL — então grava só se nada mudou.
  const before = cacheable ? gitRepositoryFingerprint(rootRealPath) : null;
  const proof = collectGitRepositoryProof(rootRealPath, runner);
  const topLevelRealPath = fs.realpathSync(
    requiredGit(runner, rootRealPath, ['rev-parse', '--show-toplevel']),
  );
  if (!isSameDirectory(topLevelRealPath, rootRealPath)) {
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
  const context = Object.freeze({
    proof,
    topLevelRealPath,
    gitDirRealPath,
    commonDirRealPath,
  });
  if (
    cacheable &&
    before !== null &&
    gitRepositoryFingerprint(rootRealPath) === before
  ) {
    storeGitRepositoryContext(rootRealPath, before, context);
  }
  return context;
}

export async function collectGitRepositoryContextAsync(
  rootRealPath: string,
  runner: AsyncProjectGitRunner = asyncProcessGitRunner,
): Promise<GitRepositoryContext> {
  const proof = await collectGitRepositoryProofAsync(rootRealPath, runner);
  const topLevelRealPath = fs.realpathSync(
    await requiredGitAsync(runner, rootRealPath, ['rev-parse', '--show-toplevel']),
  );
  if (!isSameDirectory(topLevelRealPath, rootRealPath)) {
    throw new Error('project manifest must live at the Git worktree root');
  }
  const gitDirRealPath = resolveGitDirectory(
    rootRealPath,
    await requiredGitAsync(runner, rootRealPath, ['rev-parse', '--absolute-git-dir']),
  );
  const commonDirRealPath = resolveGitDirectory(
    rootRealPath,
    await requiredGitAsync(runner, rootRealPath, ['rev-parse', '--git-common-dir']),
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

// ─── Cache da prova (fail-closed) ───────────────────────────────────────────
//
// A resolução de identidade rodava 8–10 spawnSync('git') por chamada. A prova
// agora é cacheada por fingerprint do estado do repositório que ela lê: raiz,
// entrada .git, gitdir/commondir, HEAD (+ref resolvida), configs locais,
// packed-refs, shallow e alternates. TTL de 5 min limita deriva temporal
// (ex.: troca do binário git); watchers em gitdir/commondir revalidam por
// evento. Qualquer token ilegível → fingerprint null → recomputa pelo caminho
// síncrono normal e quarentena quando for o caso.

export const GIT_PROOF_CACHE_TTL_MS = 5 * 60_000;

interface ContextCacheEntry {
  readonly fingerprint: string;
  readonly context: GitRepositoryContext;
  readonly at: number;
  readonly gitDirRealPath: string;
  readonly commonDirRealPath: string;
}

const contextCache = new Map<string, ContextCacheEntry>();
const proofWatchers = new Map<string, fs.FSWatcher>();
const proofStats = {
  contextSyncRuns: 0,
  contextHits: 0,
  warmRuns: 0,
  invalidations: 0,
};

export function gitProofStats(): {
  readonly contextSyncRuns: number;
  readonly contextHits: number;
  readonly warmRuns: number;
  readonly invalidations: number;
} {
  return { ...proofStats };
}

export function clearGitRepositoryContextCache(): void {
  contextCache.clear();
  for (const watcher of proofWatchers.values()) {
    try {
      watcher.close();
    } catch {
      // watcher já morto (diretório sumiu): só esquece
    }
  }
  proofWatchers.clear();
}

/**
 * Descobre o gitdir exatamente como o git o faria a partir da entrada `.git`
 * da raiz — arquivo `gitdir: <path>` (worktree vinculada) ou o próprio
 * diretório. Fs puro; null quando a cadeia não pode ser seguida.
 */
function gitDirectoryFromEntry(rootRealPath: string): string | null {
  try {
    const entry = path.join(rootRealPath, '.git');
    const stat = fs.statSync(entry);
    if (stat.isFile()) {
      const content = fs.readFileSync(entry, 'utf8').trim();
      if (!content.startsWith('gitdir:')) return null;
      const target = content.slice('gitdir:'.length).trim();
      if (!target) return null;
      return fs.realpathSync.native(
        path.isAbsolute(target) ? target : path.resolve(rootRealPath, target),
      );
    }
    if (stat.isDirectory()) return fs.realpathSync.native(entry);
    return null;
  } catch {
    return null;
  }
}

function resolvedRefToken(gitDir: string, commonDir: string): string {
  try {
    let current = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const stats: string[] = [];
    // Segue a cadeia de symrefs (HEAD → alias → main…): statar só o primeiro
    // ref é cego a update-ref no destino do symref. Cada salto entra com seu
    // próprio stat; cadeia maior que 5 saltos é ilegível → fingerprint único
    // → o cache nunca serve (fail-closed).
    for (let hop = 0; hop < 5; hop += 1) {
      const ref = /^ref:\s*(\S+)$/u.exec(current);
      if (!ref) {
        return stats.length === 0 ? 'detached' : `d:${stats.join('>')}`;
      }
      const name = ref[1] as string;
      const gitDirStat = statToken(path.join(gitDir, name));
      const refFile = gitDirStat !== null
        ? path.join(gitDir, name)
        : path.join(commonDir, name);
      const stat = gitDirStat ?? statToken(refFile);
      if (stat === null) return `unborn:${stats.join('>')}`;
      stats.push(stat);
      current = fs.readFileSync(refFile, 'utf8').trim();
    }
    return 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/**
 * Fingerprint de TODA a entrada que decide a prova. Se ela não mudou, a prova
 * cacheada é tão boa quanto recomputar; se mudou (ou não dá para ler),
 * recomputa. Cobertura: conteúdo do HEAD e stat da cadeia de refs resolvida
 * — symrefs seguidos até o destino (commit novo, troca de branch, update-ref
 * no fim da cadeia) —, configs locais (origin), packed-refs (fetch/gc),
 * reftable, shallow e info/grafts do COMMON dir (uma edição numa worktree
 * vinculada mexe no common, não no gitdir particular), alternates e a
 * própria cadeia de ponteiros .git → gitdir → commondir.
 */
export function gitRepositoryFingerprint(rootRealPath: string): string | null {
  const rootToken = statToken(rootRealPath);
  if (rootToken === null) return null;
  const gitDir = gitDirectoryFromEntry(rootRealPath);
  if (gitDir === null) return null;
  const headToken = smallFileToken(path.join(gitDir, 'HEAD'));
  if (headToken === null) return null;
  const commonDirToken = smallFileToken(path.join(gitDir, 'commondir'));
  let commonDir = gitDir;
  if (commonDirToken !== null) {
    try {
      const raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
      commonDir = fs.realpathSync.native(
        path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw),
      );
    } catch {
      return null;
    }
  }
  return [
    rootToken,
    'e', statToken(path.join(rootRealPath, '.git')) ?? 'absent',
    'g', statToken(gitDir) ?? 'absent',
    'h', headToken,
    'cd', commonDirToken ?? 'absent',
    'd', statToken(commonDir) ?? 'absent',
    'cfg', statToken(path.join(gitDir, 'config')) ?? 'absent',
    'cfgC', statToken(path.join(commonDir, 'config')) ?? 'absent',
    'cw', statToken(path.join(gitDir, 'config.worktree')) ?? 'absent',
    'pr', statToken(path.join(commonDir, 'packed-refs')) ?? 'absent',
    'rt', smallFileToken(path.join(commonDir, 'reftable', 'tables.list')) ?? 'absent',
    'sh', statToken(path.join(commonDir, 'shallow')) ?? 'absent',
    'gr', statToken(path.join(commonDir, 'info', 'grafts')) ?? 'absent',
    'alt', statToken(path.join(commonDir, 'objects', 'info', 'alternates')) ?? 'absent',
    'r', resolvedRefToken(gitDir, commonDir),
  ].join('|');
}

function getCachedGitRepositoryContext(
  rootRealPath: string,
): GitRepositoryContext | null {
  const entry = contextCache.get(rootRealPath);
  if (!entry) return null;
  if (Date.now() - entry.at >= GIT_PROOF_CACHE_TTL_MS) {
    contextCache.delete(rootRealPath);
    return null;
  }
  const fingerprint = gitRepositoryFingerprint(rootRealPath);
  if (fingerprint === null || fingerprint !== entry.fingerprint) {
    proofStats.invalidations += 1;
    contextCache.delete(rootRealPath);
    return null;
  }
  return entry.context;
}

function dropEntriesTouching(directory: string): void {
  for (const [key, entry] of contextCache) {
    if (
      entry.gitDirRealPath === directory ||
      entry.commonDirRealPath === directory
    ) {
      proofStats.invalidations += 1;
      contextCache.delete(key);
    }
  }
}

function watchProofDirectories(context: GitRepositoryContext): void {
  for (const directory of new Set([
    context.gitDirRealPath,
    context.commonDirRealPath,
  ])) {
    if (proofWatchers.has(directory)) continue;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(directory, { recursive: true }, () => {
        // Evento NÃO derruba às cegas: escrever o index não invalida uma prova
        // que não depende do index. Revalida por fingerprint e descarta só o
        // que de fato mudou.
        for (const [key, entry] of contextCache) {
          if (
            entry.gitDirRealPath !== directory &&
            entry.commonDirRealPath !== directory
          ) {
            continue;
          }
          const fingerprint = gitRepositoryFingerprint(key);
          if (fingerprint === null || fingerprint !== entry.fingerprint) {
            proofStats.invalidations += 1;
            contextCache.delete(key);
          }
        }
      });
    } catch {
      // Sem watcher o cache segue correto: a leitura revalida por
      // fingerprint e o TTL limita a janela.
      return;
    }
    // O watcher não pode segurar o event loop do Main na saída.
    watcher.unref();
    watcher.on('error', () => {
      if (proofWatchers.get(directory) === watcher) {
        proofWatchers.delete(directory);
      }
      try {
        watcher.close();
      } catch {
        // já fechado
      }
      dropEntriesTouching(directory);
    });
    proofWatchers.set(directory, watcher);
  }
}

function storeGitRepositoryContext(
  rootRealPath: string,
  fingerprint: string,
  context: GitRepositoryContext,
): void {
  contextCache.set(rootRealPath, {
    fingerprint,
    context,
    at: Date.now(),
    gitDirRealPath: context.gitDirRealPath,
    commonDirRealPath: context.commonDirRealPath,
  });
  watchProofDirectories(context);
}

const warmInFlight = new Map<string, Promise<void>>();

/**
 * Aquece o cache da prova de forma assíncrona (spawn, não spawnSync) para que
 * a próxima resolução síncrona não pague os 8 spawns de git. Falha em
 * silêncio: quem decide é sempre o caminho síncrono fail-closed.
 */
export function warmGitRepositoryContext(rootRealPath: string): Promise<void> {
  const existing = warmInFlight.get(rootRealPath);
  if (existing) return existing;
  const task = (async () => {
    proofStats.warmRuns += 1;
    const before = gitRepositoryFingerprint(rootRealPath);
    if (before === null) return;
    try {
      const context = await collectGitRepositoryContextAsync(rootRealPath);
      // Prova só entra no cache se a entrada não mudou durante o aquecimento.
      if (gitRepositoryFingerprint(rootRealPath) === before) {
        storeGitRepositoryContext(rootRealPath, before, context);
      }
    } catch {
      // silencioso: o caminho síncrono recompute e quarentena quando for o caso
    }
  })();
  const settled = task.then(
    () => undefined,
    () => undefined,
  );
  warmInFlight.set(rootRealPath, settled);
  void settled.then(() => {
    if (warmInFlight.get(rootRealPath) === settled) {
      warmInFlight.delete(rootRealPath);
    }
  });
  return task;
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
