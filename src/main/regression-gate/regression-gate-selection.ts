/**
 * Seleção barata de testes para o portão de regressão: não depende do mapa de
 * imports (que pode estourar o prazo). Tudo aqui usa `git grep -l -F` sobre
 * arquivos de teste, nunca varre o repositório em JS.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { GitRunner } from '../runtime/git-command';

/** Teto de testes achados por literal removido/alterado no diff. */
export const MAX_LITERAL_TESTS = 20;
/** Teto de literais distintos usados na busca. */
const MAX_LITERALS = 12;
/** Teto de testes achados por basename de um arquivo tocado. */
const MAX_BASENAME_TESTS_PER_FILE = 25;
/** Teto de arquivos tocados que entram na busca por basename. */
const MAX_BASENAME_FILES = 40;
const MAX_DIFF_CHARS = 400_000;
const MIN_LITERAL_LENGTH = 6;
const MAX_LITERAL_LENGTH = 120;

/** Pathspecs de arquivos de teste (git grep não traz fonte de produção). */
const TEST_PATHSPECS = [
  ':(glob)**/*.test.*',
  ':(glob)**/*.spec.*',
  ':(glob)**/__tests__/**',
] as const;
const TEST_FILE_RE = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[^/]+$)/iu;
const LITERAL_RE = /(['"`])((?:\\.|(?!\1)[^\\\n]){6,120}?)\1/gu;
const IMPORT_LINE_RE = /^\s*(?:import\b|export\b[^'"`]*\bfrom\b|(?:const|let|var)\b[^=]*=\s*require\()/u;

function literalsOf(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(LITERAL_RE)) {
    const value = match[2]!;
    if (value.length < MIN_LITERAL_LENGTH || value.length > MAX_LITERAL_LENGTH) continue;
    if (match[1] === '`' && value.includes('${')) continue;
    if (!value.trim()) continue;
    // Especificador de módulo/caminho relativo: coberto pelo grafo, não é "dado".
    if (/^(?:\.{1,2}\/|@\/|node:)/u.test(value)) continue;
    out.push(value);
  }
  return out;
}

/**
 * Literais de string removidos ou alterados num diff unificado (-U0): os que
 * aparecem em linhas `-` e não reaparecem inalterados em linhas `+` do mesmo
 * arquivo. Arquivos de teste e linhas de import ficam de fora.
 */
export function extractRemovedLiterals(diff: string, max = MAX_LITERALS): string[] {
  const text = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  const result: string[] = [];
  const seen = new Set<string>();
  let file = '';
  let skipFile = false;
  let removed: string[] = [];
  let added = new Set<string>();
  const flush = () => {
    if (!skipFile) {
      for (const literal of removed) {
        if (added.has(literal) || seen.has(literal)) continue;
        seen.add(literal);
        result.push(literal);
      }
    }
    removed = [];
    added = new Set();
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      file = '';
      skipFile = false;
    } else if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//u, '');
      skipFile = TEST_FILE_RE.test(file) || !/\.(?:[cm]?[jt]sx?|py)$/u.test(file);
    } else if (line.startsWith('--- ')) {
      continue;
    } else if (line.startsWith('-')) {
      const body = line.slice(1);
      if (!IMPORT_LINE_RE.test(body)) removed.push(...literalsOf(body));
    } else if (line.startsWith('+')) {
      for (const literal of literalsOf(line.slice(1))) added.add(literal);
    }
  }
  flush();
  return result.slice(0, max);
}

function grepTests(git: GitRunner, root: string, needles: readonly string[], limit: number): string[] {
  if (needles.length === 0 || limit <= 0) return [];
  try {
    const args = ['grep', '-l', '-F', '--untracked'];
    for (const needle of needles) args.push('-e', needle);
    args.push('--', ...TEST_PATHSPECS);
    const result = git.run(root, args, { allowFailure: true, timeoutMs: 10_000 });
    if (result.status !== 0) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && TEST_FILE_RE.test(line))
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Testes que contêm um literal removido/alterado no diff, limitado a `limit`.
 * `baseSha` nulo compara com o HEAD (só o working tree).
 */
export function testsByRemovedLiterals(
  git: GitRunner,
  root: string,
  baseSha: string | null,
  limit = MAX_LITERAL_TESTS,
): string[] {
  try {
    const result = git.run(
      root,
      ['diff', '-U0', '--no-color', '--no-ext-diff', baseSha ?? 'HEAD', '--'],
      { allowFailure: true, timeoutMs: 15_000 },
    );
    if (result.status !== 0) return [];
    return grepTests(git, root, extractRemovedLiterals(result.stdout), limit);
  } catch {
    return [];
  }
}

/**
 * Fallback quando o mapa de imports estoura: testes que importam o arquivo
 * pelo basename (`/foo'`, `/foo.js`...). Por arquivo tocado, para manter a
 * autoria de cada teste.
 */
export function testsImportingBasename(
  git: GitRunner,
  root: string,
  changedFiles: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  let searched = 0;
  for (const file of changedFiles) {
    if (searched >= MAX_BASENAME_FILES) break;
    if (TEST_FILE_RE.test(file) || !/\.(?:[cm]?[jt]sx?)$/u.test(file)) continue;
    let stem = path.posix.basename(file).replace(/\.[^./]+$/u, '');
    if (stem === 'index') stem = path.posix.basename(path.posix.dirname(file));
    if (!stem || stem === '.') continue;
    searched += 1;
    const needles = [`/${stem}'`, `/${stem}"`, `/${stem}\``, `/${stem}.js`, `/${stem}.mjs`, `/${stem}.ts`];
    const found = grepTests(git, root, needles, MAX_BASENAME_TESTS_PER_FILE);
    if (found.length > 0) out.set(file, found);
  }
  return out;
}

function commonDirOf(git: GitRunner, dir: string): string | null {
  try {
    const result = git.run(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      allowFailure: true,
      timeoutMs: 5_000,
    });
    const text = result.status === 0 ? result.stdout.trim() : '';
    return text ? fs.realpathSync(text) : null;
  } catch {
    return null;
  }
}

/**
 * `realTarget` (destino real de um `node_modules` symlinkado) é o
 * `node_modules` de outra worktree do MESMO repositório? Vale o git common-dir
 * igual ao da raiz; destino fora de repositório ou de outro repositório não vale.
 */
export function isSameRepoNodeModules(git: GitRunner, root: string, realTarget: string): boolean {
  if (path.basename(realTarget) !== 'node_modules') return false;
  const parent = path.dirname(realTarget);
  const ours = commonDirOf(git, root);
  if (!ours) return false;
  return commonDirOf(git, parent) === ours;
}
