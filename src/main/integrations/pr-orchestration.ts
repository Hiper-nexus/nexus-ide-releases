/**
 * Pure PR-creation orchestration: resolve head/target branches, refuse a PR
 * whose head is its own target, push the head first (GitHub 422s on an unseen
 * branch), then create the PR. Dependencies are injected so the rule set —
 * push-before-create and no-self-target — is testable without electron/git.
 */

export interface PrCreateResult {
  ok: boolean;
  error?: string;
  url?: string;
  number?: number;
}

export interface PrOrchestrationDeps {
  currentBranch: () => string | null;
  defaultBranch: () => string;
  push: (branch: string) => { ok: boolean; error?: string };
  createPr: (input: {
    sourceBranch: string;
    targetBranch: string;
  }) => Promise<PrCreateResult>;
}

export interface PrOrchestrationInput {
  sourceBranch?: string;
  targetBranch?: string;
}

export async function orchestratePrCreation(
  input: PrOrchestrationInput,
  deps: PrOrchestrationDeps,
): Promise<PrCreateResult> {
  const branch = input.sourceBranch ?? deps.currentBranch();
  if (!branch) return { ok: false, error: 'cannot resolve current branch' };
  const target = input.targetBranch ?? deps.defaultBranch();
  if (branch === target) {
    return {
      ok: false,
      error: `branch atual "${branch}" é o alvo do PR — troque de branch antes de abrir o PR`,
    };
  }
  const pushed = deps.push(branch);
  if (!pushed.ok) {
    return { ok: false, error: `falha ao dar push em "${branch}": ${pushed.error}` };
  }
  return deps.createPr({ sourceBranch: branch, targetBranch: target });
}
