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

export function inspectGitBinding(
  scope: ProjectExecutionScope,
  baseSha?: string,
  git: GitRunner = new ProcessGitRunner(),
): GitBindingSnapshot {
  const root = canonicalRoot(scope);
  const status = git.run(root, [
    'status', '--porcelain=v2', '--untracked-files=all',
  ]).stdout;
  if (status.trim().length > 0) {
    throw new Error('workflow binding requires a clean committed checkout');
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
