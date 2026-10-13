// F-1423: o veredito precisa amarrar o commit revisado, não o HEAD do cwd do
// pane. O chamador passa a worktree, a branch ou o headSha; os três, quando
// vêm juntos, têm de fechar no mesmo commit. SHA que o repositório não tem
// não grava nada.
import fs from 'node:fs';
import path from 'node:path';
import {
  assertSafeLocalGitConfig,
  ProcessGitRunner,
  type GitRunner,
} from '../runtime/git-command';
import { measureIntegrationState } from './integration-review-gate';

const gitRunner = new ProcessGitRunner();

export interface ReviewVerdictTarget {
  readonly worktree?: string;
  readonly branch?: string;
  readonly headSha?: string;
}

interface ListedWorktree {
  readonly realPath: string;
  readonly head: string;
  readonly branch: string | null;
}

const FULL_SHA = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/u;

function realOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function listRegisteredWorktrees(git: GitRunner, repoRoot: string): ListedWorktree[] {
  const result = git.run(repoRoot, ['worktree', 'list', '--porcelain'], { allowFailure: true });
  if (result.status !== 0) {
    throw new Error('nexus_review_verdict: não consegui listar as worktrees deste repositório');
  }
  const listed: ListedWorktree[] = [];
  for (const block of result.stdout.split('\n\n')) {
    if (!block.trim()) continue;
    let worktree = '';
    let head = '';
    let branch: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim().toLowerCase();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim();
    }
    if (!worktree) continue;
    listed.push({ realPath: realOrNull(worktree) ?? path.resolve(worktree), head, branch });
  }
  return listed;
}

function verifyCommit(git: GitRunner, repoRoot: string, revision: string): string | null {
  const result = git.run(
    repoRoot,
    ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
    { allowFailure: true },
  );
  const sha = result.stdout.trim().toLowerCase();
  if (result.status !== 0 || !FULL_SHA.test(sha)) return null;
  return sha;
}

/** Branch só como nome: sem opção, sem sintaxe de revisão do git. */
function assertSafeBranch(branch: string): void {
  if (
    branch.startsWith('-') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    /[\s^~:@\\]/.test(branch) ||
    branch.includes('@{')
  ) {
    throw new Error('nexus_review_verdict: branch inválida');
  }
}

function measureWorktree(
  git: GitRunner,
  repoRoot: string,
  listed: readonly ListedWorktree[],
  worktree: string,
): { headSha: string; treeDirty: boolean } {
  if (worktree.startsWith('-') || worktree.includes('\0')) {
    throw new Error('nexus_review_verdict: worktree não é deste repositório');
  }
  const resolved = path.isAbsolute(worktree) ? path.resolve(worktree) : path.resolve(repoRoot, worktree);
  const real = realOrNull(resolved);
  if (!real) throw new Error('nexus_review_verdict: worktree não é deste repositório');
  const top = git.run(real, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  const topReal = top.status === 0 ? realOrNull(top.stdout.trim()) : null;
  if (!topReal || !listed.some((entry) => entry.realPath === topReal)) {
    throw new Error('nexus_review_verdict: worktree não é deste repositório');
  }
  return measureIntegrationState(topReal, git);
}

function measureBranch(
  git: GitRunner,
  repoRoot: string,
  listed: readonly ListedWorktree[],
  branch: string,
): { headSha: string; treeDirty: boolean } {
  assertSafeBranch(branch);
  // Tag homônima vence o nome solto (`release` = refs/tags antes de heads).
  const sha = verifyCommit(git, repoRoot, `refs/heads/${branch}`);
  if (!sha) throw new Error('nexus_review_verdict: branch não existe neste repositório');
  const checkout = listed.find((entry) => entry.branch === `refs/heads/${branch}`);
  if (!checkout) return { headSha: sha, treeDirty: false };
  return measureIntegrationState(checkout.realPath, git);
}

function verifyHeadSha(git: GitRunner, repoRoot: string, headSha: string): string {
  const raw = headSha.trim().toLowerCase();
  // Hex ≥ 7. Abaixo disso um nome de branch (`cafe`) casa no rev-parse.
  // Revisão (`^`, `~`, `:`) não entra. O SHA resolvido tem de começar pelo
  // valor pedido — prefixo que aponta um objeto com outro nome é recusado.
  if (!/^[a-f0-9]{7,64}$/u.test(raw)) {
    throw new Error('nexus_review_verdict: headSha não existe neste repositório');
  }
  const sha = verifyCommit(git, repoRoot, raw);
  if (!sha || !sha.startsWith(raw)) {
    throw new Error('nexus_review_verdict: headSha não existe neste repositório');
  }
  return sha;
}

/**
 * Resolve o commit revisado a partir da worktree, da branch e/ou do headSha.
 * Sem nenhum dos três o chamador continua medindo o checkout do pane.
 */
export function resolveReviewVerdictTarget(
  repoRoot: string,
  target: ReviewVerdictTarget,
  git: GitRunner = gitRunner,
): { headSha: string; treeDirty: boolean } {
  assertSafeLocalGitConfig(git, repoRoot);
  const listed = listRegisteredWorktrees(git, repoRoot);
  const shas: string[] = [];
  let treeDirty = false;
  let sawCheckout = false;

  if (target.worktree !== undefined) {
    const state = measureWorktree(git, repoRoot, listed, target.worktree);
    shas.push(state.headSha);
    treeDirty = state.treeDirty;
    sawCheckout = true;
  }
  if (target.branch !== undefined) {
    const state = measureBranch(git, repoRoot, listed, target.branch);
    shas.push(state.headSha);
    if (listed.some((entry) => entry.branch === `refs/heads/${target.branch}`)) {
      treeDirty = state.treeDirty;
      sawCheckout = true;
    }
  }
  if (target.headSha !== undefined) {
    const sha = verifyHeadSha(git, repoRoot, target.headSha);
    shas.push(sha);
    if (!sawCheckout) {
      const checkouts = listed.filter((entry) => entry.head === sha);
      if (checkouts.length > 0) {
        treeDirty = checkouts.some((entry) => measureIntegrationState(entry.realPath, git).treeDirty);
      }
    }
  }
  if (shas.length === 0) {
    throw new Error('nexus_review_verdict: informe worktree, branch ou headSha');
  }
  if (new Set(shas).size !== 1) {
    throw new Error('nexus_review_verdict: worktree, branch e headSha não fecham no mesmo commit');
  }
  return { headSha: shas[0], treeDirty };
}
