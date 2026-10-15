/**
 * Pure PR-creation orchestration: resolve head/target branches, refuse a PR
 * whose head is its own target, push the head when the remote needs it
 * (GitHub 422s on an unseen branch), then create the PR. Dependencies are
 * injected so the rule set — push gate and no-self-target — is testable
 * without electron/git.
 *
 * Push gate (emdash create-pr-modal pattern): needsPush = !isOnRemote ||
 * aheadCount > 0 — a branch already on origin with no unpushed commits goes
 * straight to PR creation. Without a branchPushState probe we conservatively
 * always push (legacy behavior). Push failures are classified into the typed
 * GitHubApiError taxonomy so the UI gets actionable state, not a bare string.
 */
import type { GitHubApiError } from '../../vendor/emdash/github/github-api-errors';

export interface PrCreateResult {
  ok: boolean;
  error?: string;
  githubError?: GitHubApiError;
  url?: string;
  number?: number;
}

/** Remote-sync view of the head branch, used by the push gate. */
export interface PrBranchPushState {
  /** origin already has a ref for this branch. */
  isOnRemote: boolean;
  /** Commits on the local branch not yet on origin/<branch>. */
  aheadCount: number;
}

export interface PrOrchestrationDeps {
  currentBranch: () => string | null | Promise<string | null>;
  defaultBranch: () => string | Promise<string>;
  branchPushState?: (branch: string) => PrBranchPushState | Promise<PrBranchPushState>;
  push: (branch: string) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  createPr: (input: {
    sourceBranch: string;
    targetBranch: string;
  }) => Promise<PrCreateResult>;
  /** Forge host for typed errors (defaults to github.com). */
  host?: string;
}

export interface PrOrchestrationInput {
  sourceBranch?: string;
  targetBranch?: string;
}

/** Classify a raw `git push` failure (stderr) into the GitHub taxonomy. */
export function classifyGitPushError(detail: string, host: string): GitHubApiError {
  const text = detail.trim() || 'git push failed';
  if (
    /could not resolve hostname|temporary failure in name resolution|connection timed out|connection refused|network is unreachable|failed to connect|operation timed out|no route to host/i.test(
      text,
    )
  ) {
    return { type: 'host_unreachable', host, reason: text };
  }
  if (/repository not found|not found\./i.test(text)) {
    return { type: 'not_found', host, message: text };
  }
  if (
    /permission denied|publickey|authentication failed|forbidden|403|write access|read.only/i.test(
      text,
    )
  ) {
    return { type: 'forbidden', host, status: 403, message: text };
  }
  return { type: 'unknown', message: text };
}

export async function orchestratePrCreation(
  input: PrOrchestrationInput,
  deps: PrOrchestrationDeps,
): Promise<PrCreateResult> {
  const branch = input.sourceBranch ?? (await deps.currentBranch());
  if (!branch) return { ok: false, error: 'cannot resolve current branch' };
  const target = input.targetBranch ?? (await deps.defaultBranch());
  if (branch === target) {
    return {
      ok: false,
      error: `branch atual "${branch}" é o alvo do PR — troque de branch antes de abrir o PR`,
    };
  }
  const state = await deps.branchPushState?.(branch);
  const needsPush = !state || !state.isOnRemote || state.aheadCount > 0;
  if (needsPush) {
    const pushed = await deps.push(branch);
    if (!pushed.ok) {
      const githubError = classifyGitPushError(
        pushed.error ?? 'git push failed',
        deps.host ?? 'github.com',
      );
      return {
        ok: false,
        error: `falha ao dar push em "${branch}": ${pushed.error}`,
        githubError,
      };
    }
  }
  return deps.createPr({ sourceBranch: branch, targetBranch: target });
}
