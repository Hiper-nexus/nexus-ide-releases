import { resolveSourceControlPrimaryActionDecision } from '../../shared/source-control-primary-action-decision';
import type {
  SourceControlPrimaryActionDecision,
  SourceControlPrimaryActionDecisionInputs,
} from '../../shared/source-control-primary-action-decision';
import type { ForgePrInspect } from '../../shared/integrations-types';

export type GitPrimaryActionSlice = {
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  commitMessage: string;
  hasUnresolvedConflicts: boolean;
  committing: boolean;
  remoteBusy: boolean;
  branch: string | null;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  defaultBranch: string | null;
  pr: ForgePrInspect | null;
};

export function gitPrimaryActionInputs(
  slice: GitPrimaryActionSlice,
): SourceControlPrimaryActionDecisionInputs {
  const pr = slice.pr;
  return {
    stagedCount: slice.stagedCount,
    hasStageableChanges: slice.unstagedCount + slice.untrackedCount > 0,
    hasMessage: slice.commitMessage.trim().length > 0,
    hasUnresolvedConflicts: slice.hasUnresolvedConflicts,
    isCommitting: slice.committing,
    isRemoteBusy: slice.remoteBusy,
    hasCurrentBranch: Boolean(slice.branch),
    hasUpstream: slice.hasUpstream,
    ahead: slice.ahead,
    behind: slice.behind,
    isDefaultBranch: Boolean(
      slice.branch && slice.defaultBranch && slice.branch === slice.defaultBranch,
    ),
    prState: pr?.state ?? null,
    autoMergeEnabled: pr?.autoMergeEnabled === true,
    autoMergeAllowed: pr?.autoMergeAllowed ?? null,
    mergeQueueRequired: pr?.mergeQueueRequired ?? null,
    mergeable: pr?.mergeable,
    mergeStateStatus: pr?.mergeStateStatus,
    reviewDecision: pr?.reviewDecision,
  };
}

export function decideGitPrimaryAction(
  slice: GitPrimaryActionSlice,
): SourceControlPrimaryActionDecision {
  return resolveSourceControlPrimaryActionDecision(gitPrimaryActionInputs(slice));
}

export function gitPrimaryActionBusyLabel(
  decision: SourceControlPrimaryActionDecision,
  flags: { committing: boolean; remoteBusy: boolean; prBusy: boolean },
): string | null {
  if (flags.committing) return 'Commitando…';
  if (flags.prBusy && decision.kind === 'enqueue') return 'Enfileirando…';
  if (flags.remoteBusy) {
    if (decision.kind === 'create_pr') return 'Abrindo PR…';
    if (decision.kind === 'publish') return 'Publicando…';
    return 'Enviando…';
  }
  return null;
}

export async function dispatchGitPrimaryAction(
  decision: SourceControlPrimaryActionDecision,
  deps: {
    commit: () => Promise<boolean>;
    stageAll: () => Promise<void>;
    push: () => Promise<boolean>;
    createPr: () => Promise<boolean>;
    enqueuePr: () => Promise<boolean>;
  },
): Promise<boolean> {
  if (decision.disabled) return false;
  switch (decision.kind) {
    case 'commit':
      return deps.commit();
    case 'stage':
      await deps.stageAll();
      return true;
    case 'publish':
    case 'push':
      return deps.push();
    case 'create_pr':
      return deps.createPr();
    case 'enqueue':
      return deps.enqueuePr();
    default:
      return false;
  }
}
