import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProcessGitRunner, type GitRunner } from '../runtime/worktree-manager';
import type { EvidenceBinding } from './prevc-engine';

const SHA_PATTERN = /^[a-f0-9]{40,64}$/;

export interface GitBindingSnapshot {
  readonly baseSha: string;
  readonly headSha: string;
  readonly diffHash: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalRoot(scope: ProjectExecutionScope): string {
  const root = fs.realpathSync(scope.rootRealPath);
  if (root !== scope.rootRealPath || !fs.statSync(root).isDirectory()) {
    throw new Error('project checkout identity changed');
  }
  return root;
}

/**
 * Superfície de evidência do binding: os únicos caminhos que a ingestão de
 * contexto lê do disco (ver ingestProjectContext — `.context/**` + docs de
 * raiz). Só AQUI o disco precisa ser idêntico ao HEAD para o corpus congelado
 * ser honesto. Exigir o checkout INTEIRO limpo criava o deadlock de campo:
 * WIP alheio em qualquer arquivo → freeze nunca fecha → pane_spawn travado →
 * limite de workers esgota → missão morta ("círculo que só o terminal do
 * usuário resolve"). baseSha/headSha/diffHash são todos dados de COMMIT e não
 * dependem da árvore de trabalho.
 */
export const EVIDENCE_PATH_PREFIXES: readonly string[] = Object.freeze([
  '.context/',
  'AGENTS.md',
  'CLAUDE.md',
  'DESIGN.md',
  'GEMINI.md',
]);

function pathAfterSpaces(line: string, spaces: number): string {
  let index = 0;
  for (let found = 0; found < spaces; found += 1) {
    index = line.indexOf(' ', index);
    if (index === -1) return '';
    index += 1;
  }
  return line.slice(index);
}

/**
 * Extrai os caminhos sujos de `git status --porcelain=v2 -z`. Formato -z:
 * registros separados por NUL, caminhos sem quoting; entradas de rename
 * ("2 …") carregam o caminho novo no registro e o original no registro
 * seguinte — ambos contam como sujos.
 */
export function dirtyPathsFromPorcelainV2(status: string): string[] {
  const records = status.split('\0').filter((record) => record.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.startsWith('1 ')) {
      paths.push(pathAfterSpaces(record, 8));
    } else if (record.startsWith('2 ')) {
      paths.push(pathAfterSpaces(record, 9));
      const original = records[i + 1];
      if (original !== undefined) {
        paths.push(original);
        i += 1;
      }
    } else if (record.startsWith('u ')) {
      paths.push(pathAfterSpaces(record, 10));
    } else if (record.startsWith('? ') || record.startsWith('! ')) {
      paths.push(record.slice(2));
    }
  }
  return paths.filter((value) => value.length > 0);
}

/** Caminhos sujos que invalidam a evidência (dentro da superfície). */
export function blockingEvidencePaths(
  dirtyPaths: readonly string[],
): string[] {
  return dirtyPaths.filter((dirty) =>
    EVIDENCE_PATH_PREFIXES.some((prefix) =>
      prefix.endsWith('/')
        ? dirty === prefix.slice(0, -1) || dirty.startsWith(prefix)
        : dirty === prefix,
    ),
  );
}

export function inspectGitBinding(
  scope: ProjectExecutionScope,
  baseSha?: string,
  git: GitRunner = new ProcessGitRunner(),
): GitBindingSnapshot {
  const root = canonicalRoot(scope);
  const status = git.run(root, [
    'status', '--porcelain=v2', '--untracked-files=all', '-z',
  ]).stdout;
  const blocking = blockingEvidencePaths(dirtyPathsFromPorcelainV2(status));
  if (blocking.length > 0) {
    const preview = blocking.slice(0, 5).join(', ');
    const suffix = blocking.length > 5 ? ` (+${blocking.length - 5})` : '';
    throw new Error(
      'workflow binding requires a clean committed checkout of the evidence ' +
        `surface: ${preview}${suffix}`,
    );
  }
  const headSha = git.run(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
    .stdout.trim().toLowerCase();
  if (!SHA_PATTERN.test(headSha)) throw new Error('Git returned an invalid HEAD');
  const frozenBase = (baseSha ?? headSha).toLowerCase();
  if (!SHA_PATTERN.test(frozenBase)) throw new Error('invalid workflow base commit');
  const verifiedBase = git.run(root, [
    'rev-parse', '--verify', `${frozenBase}^{commit}`,
  ]).stdout.trim().toLowerCase();
  if (verifiedBase !== frozenBase) throw new Error('workflow base commit changed');
  git.run(root, ['merge-base', '--is-ancestor', verifiedBase, headSha]);
  const diff = git.run(root, [
    'diff', '--binary', '--full-index', '--no-ext-diff',
    `${verifiedBase}...${headSha}`, '--',
  ]).stdout;
  return Object.freeze({
    baseSha: verifiedBase,
    headSha,
    diffHash: sha256(diff),
  });
}

export function bindingMatchesGit(
  binding: EvidenceBinding,
  git: GitBindingSnapshot,
): boolean {
  return binding.baseSha === git.baseSha &&
    binding.headSha === git.headSha &&
    binding.diffHash === git.diffHash;
}
